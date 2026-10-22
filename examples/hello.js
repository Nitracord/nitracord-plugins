// ==NitracordPlugin==
// @name Hello Nitracord
// @author Nitracord
// @version 0.0.1
// @description A minimal plugin that writes a startup message to Nitracord Logs.
// @website https://github.com/Nitracord/nitracord-plugins
// ==/NitracordPlugin==
// SPDX-License-Identifier: MIT
(function (g) {
  "use strict";
  if (!g.Nitracord || typeof g.Nitracord.log !== "function")
    throw new Error("Hello Nitracord requires the Nitracord plugin loader");
  g.Nitracord.log("info", "Hello from Nitracord", g.Nitracord.version);
})(globalThis);
