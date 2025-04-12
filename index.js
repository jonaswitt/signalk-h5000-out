
const { H5000Websocket } = require("yacht-data-streams/build/src/h5000-ws");

module.exports = (app) => {
  let unsubscribes = [];

  let websocket;

  const plugin = {
    id: "signalk-h5000-out",
    name: "H5000 Output",
    start: (settings, restartPlugin) => {
      app.debug("H5000 Output plugin started");

      websocket = new H5000Websocket(settings.h5000_websocket_url);
      websocket.on("open", () => {
        // Subscribe just to make sure we get constant
        // messages from H5000
        // 421 - GPS Lat
        // 422 - GPS Lon
        websocket.dataReq([
          { id: 421, repeat: true },
          { id: 422, repeat: true },
        ]);
      });

      app.subscriptionmanager.subscribe(
        {
          context: "vessels.self",
          subscribe: [
            ...(settings.send_course_data ? [{
              path: "navigation.course.calcValues.bearingTrue",
              period: 1000,
            },
            {
              path: "navigation.course.calcValues.distance",
              period: 1000,
            },
            {
              path: "navigation.course.calcValues.velocityMadeGood",
              period: 1000,
            },
            {
              path: "navigation.course.calcValues.timeToGo",
              period: 1000,
            },
            {
              path: "navigation.course.calcValues.crossTrackError",
              period: 1000,
            },
            ] : []),
            {
              path: "notifications.navigation.",
            }
          ],
        },
        unsubscribes,
        subscriptionError => {
          app.error('Error:' + subscriptionError);
        },
        (delta) => {
          app.debug("Delta: " + JSON.stringify(delta, null, 2));

          const h5000Datas = []
          delta.updates.forEach(u => {
            // app.debug(u);

            u.values.forEach(({ path, value }) => {
              if (value === null) {
                return;
              }
              switch (path) {
                case "navigation.course.calcValues.bearingTrue":
                  // value in rad
                  h5000Datas.push({ id: 14, inst: 0, sysVal: value, valid: true });
                  break;

                case "navigation.course.calcValues.distance":
                  // value in m -> convert to nm
                  h5000Datas.push({ id: 21, inst: 0, sysVal: value / 1852, valid: true });
                  break;

                case "navigation.course.calcValues.velocityMadeGood":
                  // value in m/s -> convert to knots
                  h5000Datas.push({ id: 358, inst: 0, sysVal: value * 1.94384, valid: true });
                  break;

                case "navigation.course.calcValues.timeToGo":
                  // value in sec
                  if (value) {
                    h5000Datas.push({ id: 23, inst: 0, sysVal: value, valid: true });
                  }
                  break;

                case "navigation.course.calcValues.crossTrackError":
                  // value in m -> convert to nm
                  h5000Datas.push({ id: 18, inst: 0, sysVal: value / 1852, valid: true });
                  break;
              }
            });
          });

          if (h5000Datas.length > 0) {
            app.debug(`Sending data to H5000: ${JSON.stringify(h5000Datas)}`)
            websocket?.sendData(h5000Datas);
          }
        }
      );
    },
    stop: () => {
      app.debug("H5000 Output plugin stopped");

      unsubscribes.forEach(f => f());
      unsubscribes = [];

      websocket?.close();
      websocket = undefined;
    },
    schema: () => ({
      properties: {
        h5000_websocket_url: {
          type: 'string',
          title: 'H5000 Websocket URL (in the form of ws://192.168.1.100:2053)',
        },
        send_course_data: {
          type: 'boolean',
          title: 'Send course data',
          default: true,
        }
      },
    }),
  };

  return plugin;
};

