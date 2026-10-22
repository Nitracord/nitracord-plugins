// ==NitracordPlugin==
// @name Channel Activity
// @author Nitracord
// @version 0.0.1
// @description Count messages observed in each chat during this session.
// @website https://github.com/Nitracord/nitracord-plugins
// ==/NitracordPlugin==
// SPDX-License-Identifier: MIT
(function (g) {
  "use strict";
  var dc = g.Nitracord;
  if (
    !dc ||
    !dc.messages ||
    !dc.context ||
    typeof dc.messages.subscribe !== "function" ||
    typeof dc.context.current !== "function" ||
    typeof dc.context.currentUser !== "function" ||
    typeof dc.context.currentChannel !== "function"
  )
    throw new Error("Channel Activity requires an updated Nitracord context/message bridge");
  if (dc.channelActivity) dc.channelActivity.stop();
  var active = true,
    owner = null,
    counts = Object.create(null),
    listeners = [];
  function getCount() {
    var account = dc.context.currentUser();
    if (owner !== account) {
      owner = account;
      counts = Object.create(null);
    }
    var channel = dc.context.currentChannel();
    return account && channel ? counts[channel] || 0 : 0;
  }
  var unsubscribe = dc.messages.subscribe(function (event) {
    if (!active) return;
    if (event.type === "LOGOUT") {
      owner = null;
      counts = Object.create(null);
      listeners.slice().forEach(function (listener) {
        listener(0);
      });
      return;
    }
    if (event.type !== "MESSAGE_CREATE" || !event.message) return;
    getCount();
    var channel = event.message.channel_id || event.message.channelId;
    if (!owner || typeof channel !== "string" || !/^\d{15,22}$/.test(channel)) return;
    counts[channel] = (counts[channel] || 0) + 1;
    listeners.slice().forEach(function (listener) {
      listener(getCount());
    });
  });
  function open() {
    var R = dc.React,
      N = dc.Native;
    if (!R || !N || !N.View || !N.Text || !N.Pressable) throw new Error("Discord UI is not ready");
    function Screen() {
      var state = R.useState(getCount()),
        colors = dc.config.theme || {},
        insets = dc.ui.safeInsets();
      R.useEffect(function () {
        listeners.push(state[1]);
        return function () {
          listeners = listeners.filter(function (item) {
            return item !== state[1];
          });
        };
      }, []);
      return R.createElement(
        N.View,
        {
          style: {
            flex: 1,
            padding: 20,
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 16,
            backgroundColor: colors.background || "#1c1d22",
          },
        },
        R.createElement(
          N.Text,
          { style: { color: colors.text || "#f2f3f5", fontSize: 24 } },
          "Channel Activity",
        ),
        R.createElement(
          N.Text,
          { style: { color: colors.text4 || "#a5a7af", fontSize: 15, marginTop: 12 } },
          state[0] +
            (state[0] === 1 ? " message" : " messages") +
            " observed in this chat during this session.",
        ),
        R.createElement(
          N.Pressable,
          {
            accessibilityRole: "button",
            onPress: function () {
              dc.ui.close();
            },
            style: { paddingVertical: 16 },
          },
          R.createElement(
            N.Text,
            { style: { color: colors.accent || "#c4b5fd", fontSize: 16 } },
            "Close",
          ),
        ),
      );
    }
    dc.ui.present(R.createElement(Screen));
  }
  var unregister = dc.registerTool({
    id: "channel-activity",
    title: "Channel Activity",
    author: "Nitracord",
    version: "0.0.1",
    website: "https://github.com/Nitracord/nitracord-plugins",
    open: open,
  });
  dc.channelActivity = {
    getCount: getCount,
    stop: function () {
      if (!active) return;
      active = false;
      unsubscribe();
      unregister();
      listeners = [];
      counts = Object.create(null);
    },
  };
})(globalThis);
