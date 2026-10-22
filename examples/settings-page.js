// @name Settings Page Example
// @version 0.0.1
// @author Nitracord
// @description A settings screen built with Nitracord's shared Discord UI.
(function () {
  "use strict";
  var dc = globalThis.Nitracord;
  if (!dc || !dc.ui || !dc.ui.createPage)
    throw new Error("Update Nitracord to use the page builder");
  if (dc.settingsPageExample) dc.settingsPageExample.stop();
  var Settings = dc.ui.createPage(function () {
    var enabled = dc.React.useState(true),
      prefix = dc.React.useState("!");
    return {
      title: "Settings Page Example",
      sections: [
        {
          id: "preferences",
          title: "Preferences",
          rows: [
            {
              id: "enabled",
              type: "switch",
              title: "Enable example",
              description: "A local example preference.",
              value: enabled[0],
              onValueChange: enabled[1],
            },
            {
              id: "prefix",
              type: "input",
              title: "Prefix",
              value: prefix[0],
              onChangeText: prefix[1],
              placeholder: "Enter a prefix",
            },
            {
              id: "reset",
              type: "action",
              title: "Reset example",
              onPress: function () {
                enabled[1](true);
                prefix[1]("!");
              },
            },
          ],
        },
      ],
    };
  });
  var unregister = dc.registerTool({
    id: "settings-page-example",
    title: "Settings Page Example",
    version: "0.0.1",
    author: "Nitracord",
    open: function () {
      dc.ui.present(dc.React.createElement(Settings));
    },
  });
  dc.settingsPageExample = {
    stop: function () {
      unregister();
    },
  };
})();
