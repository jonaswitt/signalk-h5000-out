
const VictronRelayController = require("./controller");

module.exports = (app) => {
  let controller;

  const plugin = {
    id: "signalk-victron-relay-control-plugin",
    name: "Victron Relay Control",
    start: (settings, restartPlugin) => {
      app.debug("Victron Relay Control plugin started");

      const onRelayStateChange = (value) => {
        app.handleMessage(
          plugin.id,
          {
            updates: [{
              values: [{
                path: `electrical.switches.victron-${settings.relay_id}.state`,
                value: value,
              }]
            }],
          }
        );
      };

      controller = new VictronRelayController(settings, app.debug.bind(app), onRelayStateChange);
      controller.start();
    },
    stop: () => {
      app.debug("Victron Relay Control plugin stopped");
      controller?.stop();
      controller = undefined;
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
