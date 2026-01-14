
const { VictronMQTTInput } = require("yacht-data-streams/build/src/victron-mqtt-input");
const { getSunset, getSunrise, getSolarPosition } = require("sunrise-sunset-js");
const fs = require('fs');

const LOG_FILE = 'signalk-victron-relay-control-plugin.log'

module.exports = (app) => {
  let mqqtClient;
  let sunInterval;

  const plugin = {
    id: "signalk-victron-relay-control-plugin",
    name: "Victron Relay Control",
    start: (settings, restartPlugin) => {
      app.debug("Victron Relay Control plugin started");

      mqqtClient = new VictronMQTTInput({
        url: settings.victron_mqqt_url,
        clientId: 'signalk-relay-control-' + Math.round(Math.random() * 1000000, 0).toString(16),
        subscribeTopics: [
          "N/+/system/0/Serial",
          `N/+/system/0/Relay/${settings.relay_id}/State`,
          `N/+/battery/${settings.battery_id}/Dc/0/Voltage`,
          `N/+/battery/${settings.battery_id}/Soc`,
          "N/+/gps/0/Position/Latitude",
          "N/+/gps/0/Position/Longitude",
          "N/+/gps/0/Speed",
          "N/+/motordrive/0/Dc/0/Power",
        ],
      });

      let instanceId;
      mqqtClient.onInstanceId = (_instanceId) => {
        // app.debug(`Received Victron instance ID: ${_instanceId}`);
        instanceId = _instanceId;
      };

      let state = {};

      const setRelayOn = (on, reason, isSailing) => {
        if (!instanceId) {
          console.error("Instance ID not set yet");
          return;
        }

        const oldRelayState = state.relay;
        const relayStateChanged = on !== oldRelayState;

        mqqtClient.source.publish(
          `W/${instanceId}/system/0/Relay/${settings.relay_id}/State`,
          JSON.stringify({ value: on ? 1 : 0 }),
          (err) => {
            if (err == null) {
              app.debug(`Setting relay ${settings.relay_id} to ${on ? "ON" : "OFF"} (${reason})`);
              updateState({ relay: on });
              if (relayStateChanged) {
                if (on) {
                  updateState({ lastRelayChangeOn: new Date() });
                } else {
                  updateState({ lastRelayChangeOff: new Date() });
                }
              }
            } else {
              console.error("Error setting relay state:", err);
            }

            if (relayStateChanged) {
              try {
                fs.appendFileSync(LOG_FILE, [
                  new Date().toISOString(),
                  (state.voltage?.toFixed(2) ?? '').padStart(5, ' '),
                  (state.soc?.toFixed(2) ?? '').padStart(6, ' '),
                  isSailing ? 'SAILING' : 'STOPPED',
                  (on ? "ON" : "OFF").padEnd(3, ' '),
                  reason ?? '',
                  err != null ? (err.message ?? 'ERROR') : "SUCCESS"
                ].join(',') + '\n', {
                  encoding: 'utf8'
                });
              } catch (e) {
                app.debug(`Error writing to log file: ${e}`);
              }
            }
          }
        );
      };

      const evaluateState = () => {
        if (state.soc == null || state.voltage == null) {
          // app.debug(`Missing SoC/Voltage to evaluate ${JSON.stringify(state)}`);
          return;
        }

        // Ensure fuller battery when moving > 2 knots, or when speed is unknown
        const isSailing = (state.speed == null || state.speed >= 1); // m/s

        // Voltage low - immediately turn on
        if (state.voltage < (isSailing ? 13.1 : 12.1)) {
          setRelayOn(true, 'low voltage', isSailing);
          return;
        }

        // SoC low - immediately turn on
        if (state.soc < (isSailing ? 80 : 67)) {
          setRelayOn(true, 'low state of charge', isSailing);
          return;
        }

        if (state.sunrise == null || state.sunElevation == null) {
          // app.debug(`Missing Sunrise/Elevation to evaluate ${JSON.stringify(state)}`);
          return;
        }

        // Ensure that if we turned on recently, we don't turn off again too quickly
        const hasBeenChargingFor15Mins = (
          state.lastRelayChangeOn == null ||
          Date.now() - state.lastRelayChangeOn > 15 * 60 * 1000
        )

        // Sun is up - turn off
        if (state.sunElevation != null && state.sunElevation > 10 && hasBeenChargingFor15Mins) {
          setRelayOn(false, 'sun is up', isSailing);
          return;
        }

        // Sunrise within 8 hours - turn off
        if (state.sunrise != null && state.sunrise.valueOf() < Date.now() + (isSailing ? 4 : 8) * 60 * 60 * 1000 && hasBeenChargingFor15Mins) {
          setRelayOn(false, `sunrise in ${((state.sunrise.valueOf() - Date.now()) / 60 / 60 / 1000).toFixed(1)} hours`, isSailing);
          return;
        }

        // Sun is down - turn on
        if (state.sunElevation != null && state.sunElevation < 0) {
          setRelayOn(true, 'sun is down', isSailing);
          return;
        }

        setRelayOn(true, 'fall-through', isSailing);
      };

      let updateSun;

      const updateState = (partial) => {
        const isSignificantChange = {
          relay: partial.relay != null && partial.relay !== state.relay,
          soc: partial.soc != null && Math.abs((state.soc ?? 0) - partial.soc) >= 0.1,
          voltage:
            partial.voltage != null &&
            Math.abs((state.voltage ?? 0) - partial.voltage) >= 0.01,
          sunset:
            partial.sunset != null &&
            (state.sunset == null ||
              Math.abs(partial.sunset.getTime() - state.sunset.getTime()) >
              5 * 60 * 1000),
          sunrise:
            partial.sunrise != null &&
            (state.sunrise == null ||
              Math.abs(partial.sunrise.getTime() - state.sunrise.getTime()) >
              5 * 60 * 1000),
          sunElevation:
            partial.sunElevation != null &&
            (state.sunElevation == null ||
              Math.abs((state.sunElevation ?? 0) - partial.sunElevation) >= 1),
          lat:
            (state.lat == null && partial.lat != null) ||
            (state.lat != null &&
              partial.lat != null &&
              Math.abs(state.lat - partial.lat) > 0.0001),
          lon:
            (state.lon == null && partial.lon != null) ||
            (state.lon != null &&
              partial.lon != null &&
              Math.abs(state.lon - partial.lon) > 0.0001),
        };

        // if (isSignificantChange.relay) {
        //   app.debug(`Relay state: ${partial.relay ? "ON" : "OFF"}`);
        // }
        if (isSignificantChange.soc) {
          app.debug(`State of Charge: ${partial.soc.toFixed(2)}%`);
        }
        if (isSignificantChange.voltage) {
          app.debug(`Battery Voltage: ${partial.voltage.toFixed(2)}V`);
        }
        if (isSignificantChange.sunset) {
          app.debug(`Sunset time: ${partial.sunset.toString()}`);
        }
        if (isSignificantChange.sunrise) {
          app.debug(`Sunrise time: ${partial.sunrise.toString()}`);
        }
        if (isSignificantChange.sunElevation) {
          app.debug(`Sun Elevation: ${partial.sunElevation.toFixed(0)}°`);
        }

        state = { ...state, ...partial };

        if (isSignificantChange.lat || isSignificantChange.lon) {
          updateSun();
        }

        if (
          isSignificantChange.soc ||
          isSignificantChange.voltage ||
          isSignificantChange.sunrise ||
          isSignificantChange.sunElevation
        ) {
          evaluateState();
        }
      };

      updateSun = () => {
        if (state.lat == null || state.lon == null) {
          return;
        }
        // Always returns *next* sunset/sunrise
        // const sunset = getSunset(state.lat, state.lon);
        const sunrise = getSunrise(state.lat, state.lon);
        const solarPosition = getSolarPosition(state.lat, state.lon);
        updateState({
          // sunset, 
          sunrise, sunElevation: solarPosition.elevation
        });
      }

      if (sunInterval != null) {
        clearInterval(sunInterval);
      }
      sunInterval = setInterval(() => {
        updateSun();
      }, 60 * 1000);

      mqqtClient.onMessage = (topic, message) => {
        // app.debug(`Received MQTT message on topic ${topic}: ${JSON.stringify(message)}`);

        switch (topic.slice(3 + (instanceId?.length ?? 0))) {
          case `system/0/Relay/${settings.relay_id}/State`:
            updateState({ relay: message.value === 1 });
            app.handleMessage(
              plugin.id,
              {
                updates: [{
                  values: [{
                    path: `electrical.switches.victron-${settings.relay_id}.state`,
                    value: message.value,
                  }]
                }],
              }
            );
            break;
          case `battery/${settings.battery_id}/Dc/0/Voltage`:
            updateState({ voltage: message.value });
            break;
          case `battery/${settings.battery_id}/Soc`:
            updateState({ soc: message.value });
            break;
          case `gps/0/Position/Latitude`:
            updateState({ lat: message.value });
            break;
          case `gps/0/Position/Longitude`:
            updateState({ lon: message.value });
            break;
          case `gps/0/Speed`:
            updateState({ speed: message.value });
            break;
          case 'motordrive/0/Dc/0/Power':
            updateState({ motorLastSeen: new Date() });
            break;
        }
      };
    },
    stop: () => {
      app.debug("Victron Relay Control plugin stopped");

      if (sunInterval != null) {
        clearInterval(sunInterval);
        sunInterval = null;
      }

      mqqtClient?.close();
      mqqtClient = undefined;

    },
    schema: () => ({
      properties: {
        victron_mqqt_url: {
          type: 'string',
          title: 'Victron Cerbo MQQT Url (in the form of mqtt://192.168.1.10)',
        },
        relay_id: {
          type: 'string',
          title: 'ID of the relay (e.g. 0 for the first relay)',
        },
        battery_id: {
          type: 'string',
          title: 'ID of the battery (e.g. 0 for the first battery)',
        },
      },
    }),
  }
  return plugin;

};
