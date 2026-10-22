// ==NitracordPlugin==
// @name Invisible Typing
// @author Nitracord
// @version 0.0.1
// @description Hide outgoing typing indicators globally or only in selected channels.
// @website https://github.com/Nitracord/Nitracord
// ==/NitracordPlugin==
/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Nitracord contributors.
 * See ../LICENSE. Requires Nitracord runtime 0.0.1+.
 */
(function (g) {
  "use strict";
  var dc = g.Nitracord;
  if (!dc || !dc.findModule || !dc.registerTool || !dc.ui)
    throw new Error("Invisible Typing requires Nitracord runtime 0.0.1+");
  if (dc.invisibleTyping && dc.invisibleTyping.stop) dc.invisibleTyping.stop();
  var KEY = "nitracord.plugin.invisible-typing.v1",
    settings = { hide: true, channels: {} },
    dispatcher = null,
    detach = null,
    timer = null,
    attempts = 0,
    blocked = 0,
    active = true,
    storage = null,
    storageStatus = "Session only · settings reset on restart",
    saveQueue = Promise.resolve(),
    listeners = [],
    revision = 0;
  function validId(value) {
    return typeof value === "string" && /^\d{15,22}$/.test(value);
  }
  function emit() {
    listeners.slice().forEach(function (listener) {
      listener(revision);
    });
  }
  function current() {
    if (
      dc.context &&
      dc.context.apiVersion === 1 &&
      typeof dc.context.currentChannel === "function"
    ) {
      var selected = dc.context.currentChannel();
      return validId(selected) ? selected : null;
    }
    var channelId = null;
    dc.findModule(function (module) {
      var names = ["getCurrentlySelectedChannelId", "getChannelId", "getLastSelectedChannelId"];
      for (var i = 0; i < names.length; i++)
        try {
          if (typeof module[names[i]] !== "function") continue;
          var value = module[names[i]]();
          if (value && typeof value === "object")
            value = value.id || value.channelId || value.channel_id;
          if (validId(value)) {
            channelId = value;
            return true;
          }
        } catch (ignore) {}
      return false;
    });
    return channelId;
  }
  function hidden(channelId) {
    return validId(channelId) && Object.prototype.hasOwnProperty.call(settings.channels, channelId)
      ? settings.channels[channelId]
      : settings.hide;
  }
  function stopLocal(channelId) {
    if (dc.typing && dc.typing.apiVersion === 1 && typeof dc.typing.stopLocal === "function") {
      dc.typing.stopLocal(channelId);
      return;
    }
    if (!validId(channelId) || !dispatcher || typeof dispatcher.dispatch !== "function") return;
    try {
      dispatcher.dispatch({ type: "TYPING_STOP_LOCAL", channelId: channelId });
    } catch (ignore) {}
  }
  function save() {
    if (!storage) return;
    var serialized = JSON.stringify(settings);
    saveQueue = saveQueue
      .then(function () {
        return storage.setItem(KEY, serialized);
      })
      .catch(function () {
        storageStatus = "Could not save · settings apply for this session";
        emit();
      });
  }
  function changeDefault(value) {
    if (typeof value !== "boolean") throw new Error("Expected a switch value");
    settings.hide = value;
    revision++;
    save();
    if (value) stopLocal(current());
    emit();
  }
  function changeChannel(channelId, value) {
    if (!validId(channelId)) throw new Error("Open a chat first, then refresh this page");
    if (value === null || value === settings.hide) delete settings.channels[channelId];
    else if (typeof value === "boolean") {
      if (
        Object.keys(settings.channels).length >= 1000 &&
        !Object.prototype.hasOwnProperty.call(settings.channels, channelId)
      )
        throw new Error("Too many channel overrides. Reset some overrides first.");
      settings.channels[channelId] = value;
    } else throw new Error("Invalid channel setting");
    revision++;
    save();
    if (hidden(channelId)) stopLocal(channelId);
    emit();
  }
  function interceptor(event) {
    if (!active || !event || event.type !== "TYPING_START_LOCAL") return false;
    var channelId = event.channelId || event.channel_id;
    if (!validId(channelId) || !hidden(channelId)) return false;
    blocked++;
    return true;
  }
  function attach() {
    if (!active || detach) return !!detach;
    if (dc.typing && dc.typing.apiVersion === 1 && typeof dc.typing.suppress === "function") {
      detach = dc.typing.suppress(function (channelId) {
        if (!active || !hidden(channelId)) return false;
        blocked++;
        return true;
      });
      if (settings.hide) stopLocal(current());
      emit();
      return true;
    }
    var candidate = dc.findModule(function (module) {
      return (
        typeof module.dispatch === "function" &&
        typeof module.addInterceptor === "function" &&
        (Array.isArray(module._interceptors) || typeof module.removeInterceptor === "function")
      );
    });
    if (!candidate) return false;
    try {
      var remover = candidate.addInterceptor(interceptor);
      dispatcher = candidate;
      detach =
        typeof remover === "function"
          ? remover
          : function () {
              if (typeof candidate.removeInterceptor === "function")
                candidate.removeInterceptor(interceptor);
              else {
                var index = candidate._interceptors.indexOf(interceptor);
                if (index !== -1) candidate._interceptors.splice(index, 1);
              }
            };
      if (timer !== null && typeof g.clearInterval === "function") {
        g.clearInterval(timer);
        timer = null;
      }
      if (settings.hide) stopLocal(current());
      if (dc.log) dc.log("info", "Invisible Typing hook attached");
      emit();
      return true;
    } catch (ignore) {
      if (Array.isArray(candidate._interceptors)) {
        var index = candidate._interceptors.indexOf(interceptor);
        if (index !== -1) candidate._interceptors.splice(index, 1);
      }
      dispatcher = null;
      detach = null;
      return false;
    }
  }
  function normalize(value) {
    var next = { hide: true, channels: {} };
    if (!value || typeof value !== "object" || Array.isArray(value)) return next;
    if (typeof value.hide === "boolean") next.hide = value.hide;
    if (value.channels && typeof value.channels === "object")
      Object.keys(value.channels)
        .slice(0, 1000)
        .forEach(function (key) {
          if (validId(key) && typeof value.channels[key] === "boolean")
            next.channels[key] = value.channels[key];
        });
    return next;
  }
  var loadRevision = revision;
  function legacyStorage() {
    return dc.findModule(function (module) {
      return (
        typeof module.getItem === "function" &&
        typeof module.setItem === "function" &&
        typeof module.removeItem === "function" &&
        typeof module.multiRemove === "function" &&
        typeof module.mergeItem === "function"
      );
    });
  }
  var scopedStorage = !!(
      dc.storage &&
      dc.storage.apiVersion === 1 &&
      typeof dc.storage.scope === "function"
    ),
    migratedStorage = false;
  try {
    storage = scopedStorage ? dc.storage.scope("invisible-typing") : legacyStorage();
  } catch (ignore) {}
  var ready = storage
    ? Promise.resolve()
        .then(function () {
          return storage.getItem(KEY);
        })
        .then(function (value) {
          if (value || !scopedStorage) return value;
          var previous = legacyStorage();
          return previous
            ? Promise.resolve(previous.getItem(KEY)).then(function (saved) {
                migratedStorage = !!saved;
                return saved;
              })
            : value;
        })
        .then(function (value) {
          if (!active) return;
          if (revision === loadRevision && value)
            settings = normalize(typeof value === "string" ? JSON.parse(value) : value);
          storageStatus = "Settings saved on this device";
          if (revision !== loadRevision || migratedStorage) save();
          if (settings.hide) stopLocal(current());
          emit();
        })
        .catch(function () {
          storageStatus = "Storage unavailable · settings apply for this session";
          storage = null;
          emit();
        })
    : Promise.resolve();
  function status() {
    return {
      hook: !!detach && (!dc.typing || dc.typing.apiVersion !== 1 || dc.typing.status().available),
      hide: settings.hide,
      channels: Object.assign({}, settings.channels),
      blocked: blocked,
      storage: storageStatus,
      active: active,
    };
  }
  function stop() {
    if (!active) return;
    active = false;
    if (timer !== null && typeof g.clearInterval === "function") g.clearInterval(timer);
    timer = null;
    if (detach)
      try {
        detach();
      } catch (ignore) {}
    detach = null;
    dispatcher = null;
    emit();
    listeners = [];
  }
  function open() {
    if (!active) throw new Error("Restart Discord to reload Invisible Typing");
    attach();
    var React = dc.React,
      N = dc.Native;
    if (!React || !N || !N.Switch) throw new Error("Discord UI is not ready");
    function Screen() {
      var e = React.createElement,
        refresh = React.useState(0),
        colors = dc.ui.colors ? dc.ui.colors() : (dc.config && dc.config.theme) || {},
        ink = colors.text || "#f2f3f5",
        muted = colors.textMuted || colors.text4 || "#a5a7af",
        surface = colors.surface || "#242429",
        accent = colors.accent || "#5865f2",
        channelId = current(),
        state = status();
      React.useEffect(function () {
        var listener = function () {
          refresh[1](function (n) {
            return n + 1;
          });
        };
        listeners.push(listener);
        return function () {
          listeners = listeners.filter(function (item) {
            return item !== listener;
          });
        };
      }, []);
      function text(value, size, color) {
        return e(N.Text, { style: { color: color || ink, fontSize: size || 15 } }, value);
      }
      function row(title, description, control) {
        if (dc.ui.Row)
          return e(dc.ui.Row, { title: title, description: description, trailing: control });
        return e(
          N.View,
          {
            style: {
              padding: 16,
              borderBottomWidth: 1,
              borderBottomColor: "rgba(255,255,255,0.08)",
              flexDirection: "row",
              alignItems: "center",
            },
          },
          e(
            N.View,
            { style: { flex: 1, paddingRight: 12 } },
            text(title, 16),
            e(N.Text, { style: { color: muted, fontSize: 13, marginTop: 5 } }, description),
          ),
          control,
        );
      }
      function toggle(title, value, onChange, disabled) {
        return e(dc.ui.Switch || N.Switch, {
          value: value,
          onValueChange: onChange,
          disabled: !!disabled,
          accessibilityLabel: title,
          trackColor: { true: accent, false: "#55565f" },
        });
      }
      function action(title, callback, disabled) {
        if (dc.ui.Row)
          return e(dc.ui.Row, {
            type: "action",
            title: title,
            onPress: callback,
            disabled: !!disabled,
          });
        return e(
          N.Pressable,
          {
            accessibilityRole: "button",
            accessibilityLabel: title,
            onPress: callback,
            disabled: !!disabled,
            style: { padding: 16, opacity: disabled ? 0.45 : 1 },
          },
          text(title, 15, accent),
        );
      }
      function update(callback) {
        try {
          callback();
        } catch (error) {
          N.Alert.alert("Invisible Typing", String(error.message || error));
        }
      }
      var insets = dc.ui.safeInsets ? dc.ui.safeInsets() : { top: 24, bottom: 24 };
      return e(
        dc.ui.Page || N.View,
        {
          testID: "nitracord-invisible-typing-page",
          title: "Invisible Typing",
          scroll: false,
          style: {
            flex: 1,
            backgroundColor: colors.background || "#1c1d22",
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        },
        dc.ui.Page
          ? null
          : dc.ui.Header
            ? e(dc.ui.Header, { title: "Invisible Typing" })
            : e(
                N.View,
                {
                  style: {
                    height: 56,
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 8,
                  },
                },
                e(
                  N.Pressable,
                  {
                    onPress: dc.ui.close,
                    accessibilityLabel: "Back",
                    style: {
                      width: 48,
                      height: 48,
                      alignItems: "center",
                      justifyContent: "center",
                    },
                  },
                  text("‹", 32),
                ),
                text("Invisible Typing", 18),
              ),
        e(
          N.ScrollView,
          { contentContainerStyle: { padding: 16 } },
          e(
            dc.ui.Section || N.View,
            { style: { backgroundColor: surface, borderRadius: 16, overflow: "hidden" } },
            row(
              "Typing suppression",
              state.hook
                ? "Hook active · " + state.blocked + " typing events suppressed this session"
                : "Hook unavailable · open a chat, then retry. Typing is not currently hidden.",
            ),
            row(
              "Hide typing by default",
              "Applies to chats without a channel override.",
              toggle("Hide typing by default", state.hide, function (value) {
                changeDefault(value);
              }),
            ),
            row(
              "Hide in this channel",
              channelId
                ? Object.prototype.hasOwnProperty.call(settings.channels, channelId)
                  ? "Custom choice for this chat"
                  : "Following the default"
                : "Open a channel or DM first.",
              toggle(
                "Hide in this channel",
                !!channelId && hidden(channelId),
                function (value) {
                  update(function () {
                    changeChannel(channelId, value);
                  });
                },
                !channelId,
              ),
            ),
            action(
              "Use default for this channel",
              function () {
                update(function () {
                  changeChannel(channelId, null);
                });
              },
              !channelId,
            ),
            row("Channel overrides", Object.keys(settings.channels).length + " custom choices"),
            action("Reset channel overrides", function () {
              N.Alert.alert(
                "Reset channel overrides?",
                "All chats will follow your default setting.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Reset",
                    onPress: function () {
                      settings.channels = {};
                      revision++;
                      save();
                      if (settings.hide) stopLocal(current());
                      emit();
                    },
                  },
                ],
              );
            }),
            row("Settings storage", state.storage),
            action("Refresh / retry hook", function () {
              attach();
              emit();
            }),
          ),
          e(
            N.Text,
            { style: { color: muted, fontSize: 13, marginTop: 16 } },
            "Hides outgoing typing indicators only. Messages still send normally, and other people’s typing indicators stay visible. A typing indicator already visible to someone else expires normally.",
          ),
        ),
      );
    }
    dc.ui.present(React.createElement(Screen));
  }
  dc.invisibleTyping = {
    version: "0.0.1",
    status: status,
    hidden: hidden,
    setDefault: changeDefault,
    setChannel: changeChannel,
    currentChannel: current,
    retry: attach,
    stop: stop,
    ready: ready,
  };
  dc.registerTool({
    id: "invisible-typing",
    title: "Invisible Typing",
    author: "Nitracord",
    version: "0.0.1",
    website: "https://github.com/Nitracord/Nitracord",
    open: open,
  });
  attach();
  if (!detach && typeof g.setInterval === "function")
    timer = g.setInterval(function () {
      attempts++;
      if (attach() || attempts >= 120) {
        if (timer !== null && typeof g.clearInterval === "function") g.clearInterval(timer);
        timer = null;
      }
    }, 500);
})(globalThis);
