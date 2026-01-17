const VictronRelayController = require('./controller.js');

const settings = {
    victron_mqqt_url: 'mqtt://192.168.2.10',
    relay_id: '1',
    battery_id: '277',
};

const controller = new VictronRelayController(
    settings,
    console.log,
    (value) => {
        // console.log(`Relay state changed: ${value}`);
    },
    true
);

controller.start();
// console.log("Controller started");
