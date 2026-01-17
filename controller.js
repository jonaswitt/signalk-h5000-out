const { VictronMQTTInput } = require("yacht-data-streams/build/src/victron-mqtt-input");
const SunCalc = require('suncalc');
const fs = require('fs');

const LOG_FILE = 'signalk-victron-relay-control-plugin.log'

/**
 * Gets the next time (e.g., sunrise) that is greater than or equal to the given time.
 * Uses 23 hours instead of 24 to handle edge cases where day length changes (e.g., DST transitions,
 * extreme latitudes) while still capturing the previous and next day's times.
 */
const getNextTimeGreaterOrEqualThan = (t, lat, lon, timeKey) => {
    const times0 = SunCalc.getTimes(new Date(t.getTime() - 23 * 60 * 60 * 1000), lat, lon);
    const times1 = SunCalc.getTimes(t, lat, lon);
    const times2 = SunCalc.getTimes(new Date(t.getTime() + 23 * 60 * 60 * 1000), lat, lon);
    const times = [times0, times1, times2].map(t => t[timeKey]).sort((a, b) => a.getTime() - b.getTime());
    return times.find(t2 => t2.getTime() >= t.getTime());
}

const calculateNewState = ({ partial, state, forceSunCalc = false }) => {
    let newState = { ...state, ...partial };

    if ((partial.lat !== undefined || partial.lon !== undefined) && newState.lat != null && newState.lon != null || forceSunCalc) {
        const now = new Date();
        partial.sunrise = getNextTimeGreaterOrEqualThan(now, newState.lat, newState.lon, 'sunrise');
        partial.sunElevation = SunCalc.getPosition(now, newState.lat, newState.lon).altitude * 180 / Math.PI;
        const nextSunElevation = SunCalc.getPosition(new Date(Date.now() + 5 * 60 * 1000), newState.lat, newState.lon).altitude * 180 / Math.PI;
        partial.sunRising = nextSunElevation > partial.sunElevation;
        newState = { ...newState, ...partial };
    }

    if ((partial.speed !== undefined || partial.motorLastSeen !== undefined)) {
        // Update sailing status
        partial.isSailing = partial.motorLastSeen != null && Date.now() - partial.motorLastSeen.valueOf() < 60000 ? true : newState.speed != null ? newState.speed >= 1 : undefined; // m/s
        newState = { ...newState, ...partial };
    }

    return {
        state: newState, partial
    }
}

const calculateRelayState = (state) => {
    if (state.soc == null || state.voltage == null) {
        return { relayDesired: null, relayReason: 'insufficient data (SoC/voltage)' };
    }

    // Voltage low - immediately turn on
    if (state.voltage < (state.isSailing ? 13.1 : 12.1)) {
        return {
            relayDesired: true,
            relayReason: `low voltage ${state.isSailing ? '(sailing)' : '(stopped)'}`
        };
    }

    // SoC low - immediately turn on
    if (state.soc < (state.isSailing ? 80 : 67)) {
        return { relayDesired: true, relayReason: `low state of charge ${state.isSailing ? '(sailing)' : '(stopped)'}` };
    }

    if (state.sunrise == null || state.sunElevation == null) {
        return { relayDesired: null, relayReason: 'insufficient data (sun)' };
    }

    // Ensure that if we turned on recently, we don't turn off again too quickly
    const hasBeenChargingFor15Mins = (
        state.lastRelayChangeOn == null ||
        Date.now() - state.lastRelayChangeOn > 15 * 60 * 1000
    )

    // Sun is significantly up - turn off
    if (state.sunElevation != null && state.sunElevation > 10 && hasBeenChargingFor15Mins) {
        return {
            relayDesired: false,
            relayReason: 'sun is up'
        }
    }

    // Sunrise within 4/8 hours - turn off
    if (state.sunrise != null && state.sunrise.valueOf() < Date.now() + (state.isSailing ? 4 : 8) * 60 * 60 * 1000 && state.sunrise.valueOf() >= Date.now() && state.sunRising && hasBeenChargingFor15Mins) {
        return {
            relayDesired: false,
            relayReason: `sun rising within ${state.isSailing ? '4' : '8'} hours ${state.isSailing ? '(sailing)' : '(stopped)'}`
        }
    }

    // Sun is down - turn on
    if (state.sunElevation != null && state.sunElevation < 0) {
        return {
            relayDesired: true,
            relayReason: 'sun is down'
        }
    }

    return {
        relayDesired: true,
        relayReason: 'fall-through case'
    }
}

const stateToString = (state) => [
    new Date().toISOString(),
    (state.voltage?.toFixed(2) ?? '').padStart(5, ' '),
    (state.soc?.toFixed(2) ?? '').padStart(6, ' '),
    state.isSailing ? 'SAILING' : 'STOPPED',
    (state.relayDesired ? "ON" : "OFF").padEnd(3, ' '),
    state.relayReason ?? '',
].join(',');

class VictronRelayController {
    constructor(settings, log, onRelayStateChange = null, dryRun = false) {
        this.settings = settings;
        this.log = log;
        this.onRelayStateChange = onRelayStateChange;
        this.state = {};
        this.mqttClient = null;
        this.sunInterval = null;
        this.logTimeout = null;
        this.instanceId = null;
        this.dryRun = dryRun;
    }

    start() {
        this.mqttClient = new VictronMQTTInput({
            url: this.settings.victron_mqqt_url,
            clientId: 'signalk-relay-control-' + Math.round(Math.random() * 1000000, 0).toString(16),
            subscribeTopics: [
                "N/+/system/0/Serial",
                `N/+/system/0/Relay/${this.settings.relay_id}/State`,
                `N/+/battery/${this.settings.battery_id}/Dc/0/Voltage`,
                `N/+/battery/${this.settings.battery_id}/Soc`,
                "N/+/gps/0/Position/Latitude",
                "N/+/gps/0/Position/Longitude",
                "N/+/gps/0/Speed",
                "N/+/motordrive/0/Dc/0/Power",
            ],
        });

        this.mqttClient.onInstanceId = (_instanceId) => {
            // this.log(`Received Victron instance ID: ${_instanceId}`);
            this.instanceId = _instanceId;
        };

        if (this.sunInterval != null) {
            clearInterval(this.sunInterval);
        }
        this.sunInterval = setInterval(() => {
            this.updateState({}, true);
        }, 60 * 1000);

        this.mqttClient.onMessage = (topic, message) => {
            // this.log(`Received MQTT message on topic ${topic}: ${JSON.stringify(message)}`);
            this.handleMessage(topic, message);
        };
    }

    stop() {
        if (this.sunInterval != null) {
            clearInterval(this.sunInterval);
            this.sunInterval = null;
        }

        if (this.logTimeout != null) {
            clearTimeout(this.logTimeout);
            this.logTimeout = null;
        }

        this.mqttClient?.close();
        this.mqttClient = null;
    }

    setRelayOn(on) {
        if (!this.instanceId) {
            console.error("Instance ID not set yet");
            return;
        }

        const oldRelayState = this.state.relay;
        const relayStateChanged = on !== oldRelayState;
        const updateRelayStateAfterChange = () => {
            this.updateState({ relayActual: on });
            if (relayStateChanged) {
                if (on) {
                    this.updateState({ lastRelayChangeOn: new Date() });
                } else {
                    this.updateState({ lastRelayChangeOff: new Date() });
                }
            }
        }

        if (this.dryRun) {
            updateRelayStateAfterChange();
            return;
        }


        this.mqttClient.source.publish(
            `W/${this.instanceId}/system/0/Relay/${this.settings.relay_id}/State`,
            JSON.stringify({ value: on ? 1 : 0 }),
            (err) => {
                if (err == null) {
                    updateRelayStateAfterChange();
                } else {
                    console.error("Error setting relay state:", err);
                }
            }
        );
    }

    evaluateState() {
        const relayDecision = calculateRelayState(this.state);
        this.updateState(relayDecision);
        if (relayDecision.relayDesired != null && relayDecision.relayDesired !== this.state.relayActual) {
            this.setRelayOn(relayDecision.relayDesired);
        }
    }

    logState() {
        if (this.logTimeout != null) {
            clearTimeout(this.logTimeout);
        }

        if (this.state.soc != null && this.state.voltage != null) {
            // Use this.state to always reference the current state instance variable
            const stateStr = stateToString(this.state);
            this.log(stateStr + (this.dryRun ? ',DRY RUN' : ''));
            try {
                fs.appendFileSync(LOG_FILE, stateStr + '\n', {
                    encoding: 'utf8'
                });
            } catch (e) {
                this.log(`Error writing to log file: ${e}`);
            }
        }

        // Use arrow function to preserve 'this' context, ensuring this.state is always current
        this.logTimeout = setTimeout(() => this.logState(), 60 * 60 * 1000);
    }

    updateState(partial, forceSunCalc = false) {
        const oldState = this.state;
        const { state: newState, partial: partialAugmented } = calculateNewState({ partial, state: this.state, forceSunCalc });
        this.state = newState;

        // console.log('Updated state:', JSON.stringify(partialAugmented));

        // Was SoC, voltage, sunrise or sunElevation updated?
        if (partialAugmented.soc !== undefined ||
            partialAugmented.voltage !== undefined ||
            partialAugmented.sunrise !== undefined ||
            partialAugmented.sunElevation !== undefined) {
            this.evaluateState();
        }

        if (newState.relayDesired !== oldState.relayDesired || newState.relayDecision !== oldState.relayDecision) {
            this.logState();
        }
    }

    handleMessage(topic, message) {
        switch (topic.slice(3 + (this.instanceId?.length ?? 0))) {
            case `system/0/Relay/${this.settings.relay_id}/State`:
                this.updateState({ relayActual: message.value === 1 });
                if (this.onRelayStateChange) {
                    this.onRelayStateChange(message.value);
                }
                break;
            case `battery/${this.settings.battery_id}/Dc/0/Voltage`:
                this.updateState({ voltage: message.value });
                break;
            case `battery/${this.settings.battery_id}/Soc`:
                this.updateState({ soc: message.value });
                break;
            case `gps/0/Position/Latitude`:
                this.updateState({ lat: message.value });
                break;
            case `gps/0/Position/Longitude`:
                this.updateState({ lon: message.value });
                break;
            case `gps/0/Speed`:
                this.updateState({ speed: message.value });
                break;
            case 'motordrive/0/Dc/0/Power':
                this.updateState({ motorLastSeen: new Date() });
                break;
        }
    }
}

module.exports = VictronRelayController;

