// ==NitracordPlugin==
// @name Discord Cleaner
// @author Nitracord
// @version 0.0.1
// @description Preview and delete your messages with filters, confirmation and pause controls.
// @website https://github.com/Nitracord/Nitracord
// ==/NitracordPlugin==
/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 discord-cleaner contributors.
 * Copyright (c) 2026 Nitracord adaptation contributors.
 * See ../LICENSE. Requires Nitracord runtime 0.0.1+.
 */
(function (g) {
  "use strict";
  var dc = g.Nitracord;
  if (!dc || !dc.registerTool || !dc.findModule || !dc.ui)
    throw new Error("Discord Cleaner requires Nitracord runtime 0.0.1 or newer");
  var stopped = { message: "Stopped" },
    MAX_PLAN = 5000;
  function id(value) {
    return typeof value === "string" && /^\d{15,22}$/.test(value);
  }
  function date(value, end) {
    if (!value) return end ? Infinity : -Infinity;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Dates must use YYYY-MM-DD");
    var time = Date.parse(value + "T00:00:00Z");
    if (!isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
      throw new Error("Invalid date");
    return time + (end ? 86400000 : 0);
  }
  function header(headers, key) {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(key);
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++)
      if (keys[i].toLowerCase() === key.toLowerCase()) return headers[keys[i]];
    return null;
  }
  function pacing(headers) {
    var remaining = Number(header(headers, "X-RateLimit-Remaining")),
      reset = Number(header(headers, "X-RateLimit-Reset-After"));
    if (!isFinite(reset) || reset <= 0) return 600;
    if (remaining <= 0) return reset * 1000 + 150;
    return Math.max(600, ((reset * 1000) / remaining) * 1.15);
  }
  function responseOf(value) {
    var response = (value && value.response) || value;
    if (!response || !Number(response.status || response.statusCode)) return null;
    return {
      status: Number(response.status || response.statusCode),
      body: response.body !== undefined ? response.body : response.data,
      headers: response.headers,
    };
  }
  function requestError(error) {
    var name = error && typeof error.name === "string" ? error.name : "Error";
    var message =
      error && typeof error.message === "string"
        ? error.message
        : "No error detail from the client";
    message = message
      .replace(/https?:\/\/[^\s]+/gi, "[URL]")
      .replace(/(?:authorization|token|password)[^,;\n]*/gi, "[credential detail removed]")
      .replace(/[A-Za-z0-9_+\/.=-]{24,}/g, "[redacted]")
      .replace(/\d{15,}/g, "[ID]")
      .slice(0, 220);
    return new Error(
      "Discord client request failed (" + name + "): " + message + ". The operation stopped.",
    );
  }
  function nativeRequest(http, method, path, query) {
    if (method !== "get" && method !== "del") throw new Error("Unsupported cleaner request method");
    if (
      typeof path !== "string" ||
      !/^\/(channels\/\d{15,22}\/messages(?:\/\d{15,22})?|guilds\/\d{15,22}\/channels|users\/@me\/channels)$/.test(
        path,
      )
    )
      throw new Error("Unsupported cleaner request route");
    var url = path;
    if (query) {
      if (method !== "get") throw new Error("Unexpected delete query");
      var parts = [];
      Object.keys(query).forEach(function (key) {
        if (key !== "limit" && key !== "before" && key !== "around")
          throw new Error("Unsupported history query");
        parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(query[key])));
      });
      if (parts.length) url += "?" + parts.join("&");
    }
    // Discord Android forwards a URL string to its native request bridge.
    // Encode pagination in the URL so no query object reaches that argument.
    return http[method].call(http, url, { retries: 0 });
  }
  function resolve() {
    var bridgeUser =
      dc.context && dc.context.apiVersion === 1 && typeof dc.context.currentUser === "function"
        ? function () {
            return dc.context.currentUser();
          }
        : dc.messages &&
            dc.messages.apiVersion === 1 &&
            typeof dc.messages.currentUser === "function"
          ? function () {
              return dc.messages.currentUser();
            }
          : null;
    var store = bridgeUser
      ? null
      : dc.findModule(function (m) {
          if (typeof m.getCurrentUser !== "function") return false;
          try {
            var user = m.getCurrentUser();
            if (user && typeof user.then === "function") {
              if (typeof user.catch === "function") user.catch(function () {});
              return false;
            }
            return !!(user && id(user.id));
          } catch (ignore) {
            return false;
          }
        });
    var session = dc.findModule(function (m) {
      if (typeof m.getToken !== "function") return false;
      try {
        var value = m.getToken();
        return typeof value === "string" && value.trim().length > 0;
      } catch (ignore) {
        return false;
      }
    });
    if (
      (!bridgeUser && !store) ||
      (bridgeUser && !id(bridgeUser())) ||
      !session ||
      typeof g.fetch !== "function"
    )
      throw new Error(
        "Cannot find a supported signed-in Discord session on this build. No requests were sent.",
      );
    return {
      user: function () {
        var userId = bridgeUser ? bridgeUser() : (store.getCurrentUser() || {}).id;
        if (!id(userId))
          throw new Error(
            "The active Discord user store is unavailable. Reopen a channel and try again.",
          );
        return userId;
      },
      request: function (method, path, query) {
        return sessionRequest(g.fetch.bind(g), session, method, path, query);
      },
    };
  }
  async function sessionRequest(fetcher, session, method, path, query) {
    var url;
    // Reuse strict route and query validation without sending any client request.
    nativeRequest(
      {
        get: function (value) {
          url = value;
        },
        del: function (value) {
          url = value;
        },
      },
      method,
      path,
      query,
    );
    var token = session.getToken();
    if (typeof token !== "string" || !token.trim())
      throw new Error("Discord session is not ready. Reopen Discord and try again.");
    var response;
    try {
      response = await fetcher("https://discord.com/api/v9" + url, {
        method: method === "get" ? "GET" : "DELETE",
        headers: { Authorization: token, Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
      });
    } finally {
      token = null;
    }
    if (response.url && !/^https:\/\/discord\.com\/api\/v9\//.test(response.url))
      throw new Error("Unexpected API response location");
    var body = null;
    if (response.status !== 204) {
      var text = await response.text();
      if (text)
        try {
          body = JSON.parse(text);
        } catch (ignore) {
          throw new Error(
            "Discord API returned a non-JSON response (HTTP " + response.status + ")",
          );
        }
    }
    return { status: response.status, body: body, headers: response.headers };
  }

  function currentContext() {
    if (dc.context && dc.context.apiVersion === 1 && typeof dc.context.current === "function") {
      var selected = dc.context.current();
      return {
        channelId: selected && id(selected.channelId) ? selected.channelId : null,
        guildId: selected && id(selected.guildId) ? selected.guildId : null,
      };
    }
    var channelId = null,
      guildId = null;
    dc.findModule(function (m) {
      var methods = ["getCurrentlySelectedChannelId", "getChannelId", "getLastSelectedChannelId"];
      for (var i = 0; i < methods.length; i++)
        try {
          if (typeof m[methods[i]] !== "function") continue;
          var value = m[methods[i]]();
          if (value && typeof value === "object")
            value = value.id || value.channelId || value.channel_id;
          if (id(value)) {
            channelId = value;
            return true;
          }
        } catch (ignore) {}
      return false;
    });
    if (channelId)
      dc.findModule(function (m) {
        try {
          if (typeof m.getChannel !== "function") return false;
          var channel = m.getChannel(channelId);
          if (!channel || channel.id !== channelId) return false;
          var guild = channel.guild_id || channel.guildId;
          if (!guild && typeof channel.getGuildId === "function") guild = channel.getGuildId();
          if (id(guild)) guildId = guild;
          return !!guildId;
        } catch (ignore) {
          return false;
        }
      });
    return { channelId: channelId, guildId: guildId };
  }
  function canDeleteOthers(channelId) {
    var channel = null,
      allowed = false;
    dc.findModule(function (m) {
      try {
        if (typeof m.getChannel !== "function") return false;
        var value = m.getChannel(channelId);
        if (value && value.id === channelId) {
          channel = value;
          return true;
        }
      } catch (ignore) {}
      return false;
    });
    if (!channel || !(channel.guild_id || channel.guildId)) return false;
    dc.findModule(function (m) {
      try {
        if (typeof m.can !== "function") return false;
        if (m.can(BigInt(8192), channel) === true) {
          allowed = true;
          return true;
        }
      } catch (ignore) {}
      return false;
    });
    return allowed;
  }
  function createEngine(adapter, notify, sleep) {
    var epoch = 0,
      paused = false,
      plan = null,
      sequence = 0;
    var state = {
      phase: "idle",
      scanned: 0,
      matched: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      channels: 0,
      limited: false,
      message: "Preview first. Choose whose messages to include.",
    };
    sleep =
      sleep ||
      function (ms) {
        return new Promise(function (done) {
          setTimeout(done, ms);
        });
      };
    notify = notify || function () {};
    function emit(message) {
      if (message) state.message = message;
      notify(Object.assign({}, state));
    }
    function check(run) {
      if (run !== epoch) throw stopped;
    }
    async function wait(ms, run) {
      var left = ms;
      while (left > 0) {
        check(run);
        var amount = Math.min(left, 200);
        await sleep(amount);
        left -= amount;
      }
      check(run);
    }
    async function gate(run) {
      check(run);
      while (paused) await wait(200, run);
      check(run);
    }
    async function request(method, path, query, run) {
      for (var retry = 0; retry <= 10; retry++) {
        await gate(run);
        var response;
        try {
          response = responseOf(await adapter.request(method, path, query));
        } catch (error) {
          response = responseOf(error);
          if (!response) throw requestError(error);
        }
        check(run);
        if (!response)
          throw new Error(
            "Unsupported Discord REST response: no HTTP status returned. The client adapter needs updating.",
          );
        if (Number(response.status) !== 429) return response;
        if (retry === 10) throw new Error("Too many rate limits. Stopped.");
        var seconds = Number(response.body && response.body.retry_after);
        if (!isFinite(seconds) || seconds < 0) seconds = 1;
        emit("Rate limited. Waiting before retrying…");
        await wait(seconds * 1000 + 300, run);
      }
    }
    function own(message, options, user) {
      var time = message && Date.parse(message.timestamp);
      return !!(
        message &&
        id(message.id) &&
        message.author &&
        id(message.author.id) &&
        (options.authors === "everyone" ||
          message.author.id === (options.authors === "user" ? options.authorId : user)) &&
        (message.type === 0 || message.type === 19) &&
        isFinite(time) &&
        time >= options.after &&
        time < options.before &&
        (!options.skipPinned || !message.pinned) &&
        (!options.keyword ||
          String(message.content || "")
            .toLowerCase()
            .indexOf(options.keyword) >= 0)
      );
    }
    function normalize(options) {
      var out = {
        authors: options.authors || "mine",
        authorId: String(options.authorId || "").trim(),
        mode: options.mode || "channel",
        channelId: String(options.channelId || "").trim(),
        guildId: String(options.guildId || "").trim(),
        after: date(options.after, false),
        before: date(options.before, true),
        keyword: String(options.keyword || "").toLowerCase(),
        skipPinned: options.skipPinned !== false,
      };
      if (["mine", "everyone", "user"].indexOf(out.authors) < 0)
        throw new Error("Choose whose messages to include");
      if (out.authors === "user" && !id(out.authorId))
        throw new Error("Enter a valid author user ID");
      if (["channel", "server", "dms"].indexOf(out.mode) < 0)
        throw new Error("Choose a supported scope");
      if (out.mode === "channel" && !id(out.channelId)) throw new Error("Enter a channel or DM ID");
      if (out.mode === "server" && !id(out.guildId)) throw new Error("Enter a server ID");
      if (out.after >= out.before) throw new Error("After date must precede before date");
      return Object.freeze(out);
    }
    async function channels(options, run) {
      if (options.mode === "channel") return [{ id: options.channelId }];
      var res = await request(
        "get",
        options.mode === "server"
          ? "/guilds/" + options.guildId + "/channels"
          : "/users/@me/channels",
        undefined,
        run,
      );
      if (res.status !== 200 || !Array.isArray(res.body))
        throw new Error("Could not list channels (HTTP " + res.status + ")");
      return res.body.filter(function (c) {
        return (
          id(c.id) &&
          (options.mode === "dms"
            ? c.type === 1 || c.type === 3
            : [0, 5, 10, 11, 12].indexOf(c.type) >= 0)
        );
      });
    }
    function permitted(message, channel, user) {
      return (
        message.author.id === user ||
        (typeof adapter.canDeleteOthers === "function" && adapter.canDeleteOthers(channel) === true)
      );
    }
    function busy() {
      return state.phase === "scanning" || state.phase === "deleting";
    }
    async function preview(options) {
      if (busy()) throw new Error("A task is already running");
      plan = null;
      var settings = normalize(options),
        user = adapter.user(),
        run = ++epoch;
      paused = false;
      state = {
        phase: "scanning",
        scanned: 0,
        matched: 0,
        deleted: 0,
        skipped: 0,
        failed: 0,
        channels: 0,
        limited: false,
        message: "",
      };
      emit("Scanning message history. Nothing is being deleted.");
      var items = [],
        seen = new Set();
      try {
        var list = await channels(settings, run);
        outer: for (var c = 0; c < list.length; c++) {
          var channel = list[c].id,
            cursor = null;
          state.channels++;
          emit();
          for (var pages = 0; pages < 10000; pages++) {
            var query = { limit: 100 };
            if (cursor) query.before = cursor;
            var res = await request("get", "/channels/" + channel + "/messages", query, run);
            if (res.status === 403 || res.status === 404) {
              state.skipped++;
              break;
            }
            if (res.status !== 200 || !Array.isArray(res.body))
              throw new Error("Cannot read message history (HTTP " + res.status + ")");
            var messages = res.body;
            if (!messages.length) break;
            var oldest = null,
              oldestTime = Infinity;
            for (var m = 0; m < messages.length; m++) {
              var message = messages[m];
              if (!id(message.id)) throw new Error("Invalid message ID in history");
              if (
                oldest === null ||
                message.id.length < oldest.length ||
                (message.id.length === oldest.length && message.id < oldest)
              )
                oldest = message.id;
              oldestTime = Math.min(oldestTime, Date.parse(message.timestamp));
              state.scanned++;
              if (
                own(message, settings, user) &&
                permitted(message, channel, user) &&
                !seen.has(channel + ":" + message.id)
              ) {
                seen.add(channel + ":" + message.id);
                items.push(
                  Object.freeze({
                    channelId: channel,
                    messageId: message.id,
                    authorId: message.author.id,
                  }),
                );
                state.matched = items.length;
                if (items.length >= MAX_PLAN) {
                  state.limited = true;
                  break outer;
                }
              }
            }
            emit();
            if (oldest === cursor) throw new Error("Discord returned a repeated history page");
            cursor = oldest;
            if (oldestTime < settings.after) break;
            if (pages === 9999)
              throw new Error("History scan limit reached; narrow the date range");
            await wait(600, run);
          }
        }
        check(run);
        plan = Object.freeze({
          id: ++sequence,
          user: user,
          options: settings,
          items: Object.freeze(items),
        });
        state.phase = "preview";
        emit(
          items.length +
            " messages match (" +
            (settings.authors === "mine"
              ? "Only mine"
              : settings.authors === "user"
                ? "Selected user"
                : "Everyone · permitted messages") +
            ")" +
            (state.limited ? " (5,000-message preview limit)" : "") +
            ". Review scope and confirm to delete.",
        );
        return plan.id;
      } catch (error) {
        if (run === epoch) {
          plan = null;
          state.phase = "error";
          emit(error.message || "Preview failed");
        }
        if (error !== stopped) throw error;
        return null;
      }
    }
    async function remove(planId) {
      if (busy() || !plan || plan.id !== planId || state.phase !== "preview")
        throw new Error("Run a fresh preview first");
      if (adapter.user() !== plan.user) {
        plan = null;
        throw new Error("Account changed. Run a fresh preview.");
      }
      var selected = plan;
      plan = null;
      var run = ++epoch;
      paused = false;
      state.phase = "deleting";
      emit("Deleting only the reviewed messages…");
      try {
        for (var i = 0; i < selected.items.length; i++) {
          await gate(run);
          if (adapter.user() !== selected.user) throw new Error("Account changed. Stopped.");
          var item = selected.items[i];
          var path = "/channels/" + item.channelId + "/messages/" + item.messageId,
            res = await request(
              "get",
              "/channels/" + item.channelId + "/messages",
              { around: item.messageId, limit: 1 },
              run,
            );
          if (res.status !== 200)
            throw new Error(
              "Cannot verify message ownership through history (HTTP " +
                res.status +
                "). No delete was sent for this message.",
            );
          if (!Array.isArray(res.body))
            throw new Error("Unexpected ownership verification response. Stopped before deletion.");
          var checked = res.body.filter(function (message) {
            return message && message.id === item.messageId;
          })[0];
          if (!checked) {
            state.skipped++;
            emit("Skipped a message no longer present in history.");
            continue;
          }
          if (
            (checked.author && checked.author.id !== item.authorId) ||
            !own(checked, selected.options, selected.user) ||
            !permitted(checked, item.channelId, selected.user)
          ) {
            state.skipped++;
            emit("Skipped a message whose author or filters changed.");
            continue;
          }
          await gate(run);
          if (adapter.user() !== selected.user) throw new Error("Account changed. Stopped.");
          res = await request("del", path, undefined, run);
          if (res.status === 200 || res.status === 204) state.deleted++;
          else if (res.status === 404) state.skipped++;
          else
            throw new Error(
              "Delete failed (HTTP " +
                res.status +
                "). Stopped; remaining messages were not attempted.",
            );
          emit();
          await wait(pacing(res.headers), run);
        }
        state.phase = "done";
        emit(
          "Finished: " +
            state.deleted +
            " deleted, " +
            state.skipped +
            " skipped. " +
            (state.skipped
              ? "Skipped messages were missing or no longer matched the reviewed filters."
              : "Preview again to scan for remaining messages."),
        );
      } catch (error) {
        if (run === epoch) {
          state.phase = "error";
          state.failed++;
          emit(error.message || "Deletion failed");
        }
        if (error !== stopped) throw error;
      }
    }
    return {
      preview: preview,
      remove: remove,
      state: function () {
        return Object.assign({}, state);
      },
      plan: function () {
        return plan;
      },
      pause: function () {
        if (busy()) {
          paused = true;
          emit("Paused. An in-flight request may finish.");
        }
      },
      resume: function () {
        paused = false;
        emit("Resumed.");
      },
      stop: function () {
        epoch++;
        paused = false;
        plan = null;
        state.phase = "stopped";
        emit("Stopped. No more requests will start.");
      },
      invalidate: function () {
        if (!busy()) {
          plan = null;
          state.phase = "idle";
          emit("Filters changed. Run a new preview.");
        }
      },
    };
  }
  function open() {
    var React = dc.React,
      N = dc.Native;
    if (!React || !N || !N.View || !N.TextInput || !N.Alert)
      throw new Error("React Native UI is not available yet");
    var colors = dc.ui.colors ? dc.ui.colors() : (dc.config && dc.config.theme) || {},
      bg = colors.background || "#1c1d22",
      surface = colors.surface || "#242429",
      ink = colors.text || "#f2f3f5",
      muted = colors.textMuted || "#a5a7af",
      accent = colors.accent || "#5865f2";
    var adapter = {
      canDeleteOthers: canDeleteOthers,
      user: function () {
        return resolve().user();
      },
      request: function (method, path, query) {
        return resolve().request(method, path, query);
      },
    };
    function Screen() {
      var e = React.createElement,
        ref = React.useRef(null),
        mounted = React.useRef(true),
        context = currentContext(),
        initial = {
          authors: "mine",
          authorId: "",
          mode: "channel",
          channelId: context.channelId || "",
          guildId: context.guildId || "",
          after: "",
          before: "",
          keyword: "",
          skipPinned: true,
        };
      var settings = React.useState(initial),
        options = settings[0],
        setOptions = settings[1],
        progress = React.useState(null),
        status = progress[0],
        setStatus = progress[1];
      if (!ref.current)
        ref.current = createEngine(adapter, function (value) {
          if (mounted.current) setStatus(value);
        });
      var engine = ref.current;
      React.useEffect(function () {
        setStatus(engine.state());
        return function () {
          mounted.current = false;
          engine.stop();
        };
      }, []);
      var calendar = React.useState(null),
        calendarValue = calendar[0],
        setCalendar = calendar[1];
      var active = status && (status.phase === "scanning" || status.phase === "deleting");
      function error(err) {
        N.Alert.alert("Discord Cleaner", String(err.message || err));
      }
      function change(key, value) {
        var next = Object.assign({}, options);
        next[key] = value;
        setOptions(next);
        engine.invalidate();
      }
      function close() {
        if (active) {
          N.Alert.alert("Stop cleanup?", "A request already in progress may finish.", [
            { text: "Keep running", style: "cancel" },
            {
              text: "Stop and close",
              style: "destructive",
              onPress: function () {
                engine.stop();
                dc.ui.close();
              },
            },
          ]);
        } else dc.ui.close();
      }
      function text(value, size, color) {
        return e(N.Text, { style: { color: color || ink, fontSize: size || 16 } }, value);
      }
      React.useEffect(
        function () {
          if (dc.ui.setBackHandler) dc.ui.setBackHandler(close);
          return function () {
            if (dc.ui.setBackHandler) dc.ui.setBackHandler(null);
          };
        },
        [active],
      );
      function label(value) {
        return text(value, 14, muted);
      }
      function section(title, children) {
        if (dc.ui.Section) return e(dc.ui.Section, { title: title }, children);
        return e(
          N.View,
          { style: { marginBottom: 24 } },
          e(
            N.Text,
            {
              style: {
                fontSize: 13,
                fontWeight: "600",
                color: muted,
                marginBottom: 10,
                marginLeft: 4,
              },
            },
            title,
          ),
          e(
            N.View,
            { style: { backgroundColor: surface, borderRadius: 16, overflow: "hidden" } },
            children,
          ),
        );
      }
      function row(title, detail, onPress, extra) {
        if (dc.ui.Row)
          return e(dc.ui.Row, {
            title: title,
            description: detail,
            onPress: onPress,
            disabled: !!active,
            trailing: extra,
          });
        return e(
          N.Pressable,
          {
            onPress: onPress,
            disabled: !onPress || active,
            accessibilityRole: onPress ? "button" : undefined,
            style: { minHeight: 56, padding: 16, flexDirection: "row", alignItems: "center" },
          },
          e(
            N.View,
            { style: { flex: 1 } },
            text(title),
            detail
              ? e(N.Text, { style: { fontSize: 12, color: muted, marginTop: 4 } }, detail)
              : null,
          ),
          extra || (onPress ? text("›", 25, muted) : null),
        );
      }
      function button(title, fn, disabled, danger) {
        if (dc.ui.Row)
          return e(dc.ui.Row, {
            type: "action",
            title: title,
            onPress: fn,
            disabled: !!disabled,
            danger: !!danger,
          });
        return e(
          N.Pressable,
          {
            onPress: fn,
            disabled: !!disabled,
            accessibilityRole: "button",
            style: {
              minHeight: 48,
              padding: 14,
              borderRadius: 12,
              backgroundColor: danger ? "#a1283e" : accent,
              opacity: disabled ? 0.4 : 1,
              alignItems: "center",
              justifyContent: "center",
              marginTop: 10,
            },
          },
          text(title, 15, "#ffffff"),
        );
      }
      function field(title, key, placeholder) {
        if (dc.ui.Field)
          return e(dc.ui.Field, {
            title: title,
            value: options[key],
            onChangeText: function (value) {
              change(key, value);
            },
            disabled: !!active,
            placeholder: placeholder,
            keyboardType:
              key === "channelId" || key === "guildId" || key === "authorId"
                ? "number-pad"
                : "default",
          });
        return e(
          N.View,
          { style: { padding: 16 } },
          label(title),
          e(N.TextInput, {
            value: options[key],
            onChangeText: function (v) {
              change(key, v);
            },
            editable: !active,
            placeholder: placeholder,
            placeholderTextColor: muted,
            autoCapitalize: "none",
            keyboardType:
              key === "channelId" || key === "guildId" || key === "authorId"
                ? "number-pad"
                : "default",
            style: { color: ink, fontSize: 16, paddingVertical: 10 },
          }),
        );
      }
      function scopeName() {
        var name = null;
        dc.findModule(function (m) {
          try {
            var value =
              options.mode === "server" && typeof m.getGuild === "function"
                ? m.getGuild(options.guildId)
                : options.mode === "channel" && typeof m.getChannel === "function"
                  ? m.getChannel(options.channelId)
                  : null;
            if (value && typeof value.name === "string" && value.name) {
              name = value.name;
              return true;
            }
          } catch (ignore) {}
          return false;
        });
        return (
          name ||
          (options.mode === "dms"
            ? "All direct messages"
            : options.mode === "server"
              ? "Selected server"
              : "Selected conversation")
        );
      }
      function pickDate(key) {
        var value = options[key] ? new Date(options[key] + "T12:00:00Z") : new Date();
        setCalendar({ key: key, year: value.getUTCFullYear(), month: value.getUTCMonth() });
      }
      function datePicker() {
        if (!calendarValue) return null;
        var y = calendarValue.year,
          m = calendarValue.month,
          days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
          offset = new Date(Date.UTC(y, m, 1)).getUTCDay(),
          cells = [];
        for (var i = 0; i < offset; i++)
          cells.push(e(N.View, { key: "blank" + i, style: { width: "14.285%", height: 42 } }));
        for (var day = 1; day <= days; day++)
          (function (d) {
            cells.push(
              e(
                N.Pressable,
                {
                  key: d,
                  accessibilityLabel: "Choose " + y + "-" + (m + 1) + "-" + d,
                  onPress: function () {
                    change(
                      calendarValue.key,
                      y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0"),
                    );
                    setCalendar(null);
                  },
                  style: {
                    width: "14.285%",
                    height: 42,
                    alignItems: "center",
                    justifyContent: "center",
                  },
                },
                text(String(d)),
              ),
            );
          })(day);
        function move(delta) {
          var value = new Date(Date.UTC(y, m + delta, 1));
          setCalendar({
            key: calendarValue.key,
            year: value.getUTCFullYear(),
            month: value.getUTCMonth(),
          });
        }
        return e(
          N.Modal,
          {
            visible: true,
            transparent: true,
            onRequestClose: function () {
              setCalendar(null);
            },
          },
          e(
            N.View,
            {
              style: {
                flex: 1,
                justifyContent: "center",
                padding: 24,
                backgroundColor: "rgba(0,0,0,0.65)",
              },
            },
            e(
              N.View,
              { style: { backgroundColor: surface, borderRadius: 20, padding: 16 } },
              e(
                N.View,
                {
                  style: {
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  },
                },
                e(
                  N.Pressable,
                  {
                    onPress: function () {
                      move(-1);
                    },
                    accessibilityLabel: "Previous month",
                    style: { padding: 12 },
                  },
                  text("‹", 26),
                ),
                text(
                  new Date(Date.UTC(y, m, 1)).toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  }),
                ),
                e(
                  N.Pressable,
                  {
                    onPress: function () {
                      move(1);
                    },
                    accessibilityLabel: "Next month",
                    style: { padding: 12 },
                  },
                  text("›", 26),
                ),
              ),
              e(N.View, { style: { flexDirection: "row", flexWrap: "wrap" } }, cells),
              button("Clear date", function () {
                change(calendarValue.key, "");
                setCalendar(null);
              }),
              button("Cancel", function () {
                setCalendar(null);
              }),
            ),
          ),
        );
      }
      function current() {
        try {
          var value = currentContext();
          if (!value.channelId)
            throw new Error(
              "No active channel is available from this Discord build. Open a chat first, or paste its channel ID.",
            );
          if (options.mode === "server" && !value.guildId)
            throw new Error(
              "The current chat is a DM, or its server is unavailable. Open a server channel or paste the server ID.",
            );
          var next = Object.assign({}, options, {
            channelId: value.channelId,
            guildId: value.guildId || options.guildId,
          });
          setOptions(next);
          engine.invalidate();
        } catch (err) {
          error(err);
        }
      }

      function confirm() {
        var plan = engine.plan();
        if (!plan || !plan.items.length) return;
        var scope =
          plan.options.mode === "channel"
            ? "Channel " + plan.options.channelId
            : plan.options.mode === "server"
              ? "Server " + plan.options.guildId
              : "All DMs";
        N.Alert.alert(
          "Permanently delete " + plan.items.length + " messages?",
          scope +
            "\nAuthors: " +
            (plan.options.authors === "mine"
              ? "Only mine"
              : plan.options.authors === "user"
                ? "User " + plan.options.authorId
                : "Everyone (permitted messages)") +
            ". This cannot be undone.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete " + plan.items.length,
              style: "destructive",
              onPress: function () {
                engine.remove(plan.id).catch(error);
              },
            },
          ],
        );
      }
      return e(
        N.View,
        { style: { flex: 1 }, testID: "nitracord-cleaner-page" },
        e(
          dc.ui.Page || N.View,
          {
            title: "Message cleanup",
            scroll: false,
            onBack: close,
            style: {
              flex: 1,
              backgroundColor: bg,
              paddingTop: dc.ui.safeInsets
                ? dc.ui.safeInsets().top
                : (N.StatusBar && N.StatusBar.currentHeight) || 24,
              paddingBottom: dc.ui.safeInsets ? dc.ui.safeInsets().bottom : 24,
            },
          },
          dc.ui.Page
            ? null
            : e(
                N.View,
                {
                  style: {
                    height: 56,
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: "rgba(255,255,255,0.08)",
                  },
                },
                e(
                  N.Pressable,
                  {
                    onPress: close,
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
                e(N.View, { style: { flex: 1 } }, text("Message cleanup", 18), label(scopeName())),
                text("⌫", 24),
              ),
          e(
            N.ScrollView,
            {
              keyboardShouldPersistTaps: "handled",
              contentContainerStyle: { padding: 16, paddingBottom: 32 },
            },
            section(
              "SCOPE",
              e(
                N.View,
                null,
                e(
                  N.View,
                  { style: { flexDirection: "row", padding: 6 } },
                  ["channel", "server", "dms"].map(function (mode) {
                    return e(
                      N.Pressable,
                      {
                        key: mode,
                        onPress: function () {
                          change("mode", mode);
                        },
                        disabled: active,
                        accessibilityRole: "button",
                        accessibilityState: { selected: options.mode === mode },
                        style: {
                          flex: 1,
                          paddingVertical: 11,
                          borderRadius: 10,
                          backgroundColor: options.mode === mode ? accent : "transparent",
                          alignItems: "center",
                        },
                      },
                      text(
                        { channel: "Channel", server: "Server", dms: "All DMs" }[mode],
                        14,
                        options.mode === mode ? "#ffffff" : muted,
                      ),
                    );
                  }),
                ),
                options.mode === "dms"
                  ? row("All direct messages", "Closed conversations may be absent.")
                  : e(
                      N.View,
                      null,
                      row(scopeName(), "Use the current channel or server", current),
                      field(
                        options.mode === "server" ? "Server ID" : "Channel / DM ID",
                        options.mode === "server" ? "guildId" : "channelId",
                        "Paste ID if needed",
                      ),
                    ),
              ),
            ),
            section(
              "FILTERS",
              e(
                N.View,
                null,
                row(
                  "Whose messages",
                  options.authors === "mine"
                    ? "Only mine"
                    : options.authors === "user"
                      ? "Specific user"
                      : "Everyone · requires Manage Messages",
                  function () {
                    N.Alert.alert(
                      "Whose messages?",
                      "Other authors are included only where you have Manage Messages permission.",
                      [
                        {
                          text: "Only mine",
                          onPress: function () {
                            change("authors", "mine");
                          },
                        },
                        {
                          text: "Everyone",
                          onPress: function () {
                            change("authors", "everyone");
                          },
                        },
                        {
                          text: "Specific user",
                          onPress: function () {
                            change("authors", "user");
                          },
                        },
                        { text: "Cancel", style: "cancel" },
                      ],
                    );
                  },
                ),
                options.authors === "user"
                  ? field("Author user ID", "authorId", "Paste user ID")
                  : null,
                row("After date", options.after || "Any time · UTC", function () {
                  pickDate("after");
                }),
                row("Before date", options.before || "Any time · UTC", function () {
                  pickDate("before");
                }),
                field("Contains text", "keyword", "Any message"),
                row(
                  "Protect pinned messages",
                  "Pinned messages are excluded by default",
                  function () {
                    change("skipPinned", !options.skipPinned);
                  },
                  N.Switch
                    ? e(dc.ui.Switch || N.Switch, {
                        value: options.skipPinned,
                        disabled: active,
                        onValueChange: function (value) {
                          change("skipPinned", value);
                        },
                        trackColor: { false: "#55565f", true: accent },
                      })
                    : text(options.skipPinned ? "On" : "Off"),
                ),
              ),
            ),
            section(
              "PREVIEW",
              e(
                N.View,
                { style: { padding: 16 } },
                label(
                  status
                    ? status.message
                    : "Preview includes selected authors only where deletion is permitted.",
                ),
                e(
                  N.View,
                  { style: { flexDirection: "row", marginTop: 16 } },
                  [
                    { label: "Scanned", value: status ? status.scanned : 0 },
                    { label: "Matches", value: status ? status.matched : 0 },
                    { label: "Deleted", value: status ? status.deleted : 0 },
                  ].map(function (item) {
                    return e(
                      N.View,
                      { key: item.label, style: { flex: 1, alignItems: "center" } },
                      text(String(item.value), 24),
                      label(item.label),
                    );
                  }),
                ),
                status && status.skipped ? label("Skipped: " + status.skipped) : null,
                button(
                  active ? "Working…" : "Preview matches",
                  function () {
                    engine.preview(options).catch(error);
                  },
                  active,
                ),
                button(
                  "Delete reviewed messages",
                  confirm,
                  active || !status || status.phase !== "preview" || !status.matched,
                  true,
                ),
                active
                  ? e(
                      N.View,
                      null,
                      button("Pause", engine.pause),
                      button("Resume", engine.resume),
                      button("Stop", engine.stop, false, true),
                    )
                  : null,
              ),
            ),
            label(
              "Preview only reads history. Deletion requires confirmation and cannot be undone.",
            ),
          ),
          datePicker(),
        ),
      );
    }
    dc.ui.present(React.createElement(Screen));
  }
  dc.bulkCleaner = {
    createEngine: createEngine,
    nativeRequest: nativeRequest,
    sessionRequest: sessionRequest,
    currentContext: currentContext,
    open: open,
    version: "0.0.1",
    availability: function () {
      try {
        resolve().user();
        return { ready: true };
      } catch (error) {
        return { ready: false, message: String(error.message || error) };
      }
    },
  };
  dc.registerTool({
    id: "discord-cleaner",
    title: "Discord Cleaner",
    author: "Nitracord",
    version: "0.0.1",
    website: "https://github.com/Nitracord/Nitracord",
    icon: "trash",
    header: true,
    open: open,
  });
})(globalThis);

/*
MIT License

Copyright (c) 2026 discord-cleaner contributors
Copyright (c) 2026 Nitracord adaptation contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
