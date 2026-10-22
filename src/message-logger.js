// ==NitracordPlugin==
// @name Message Logger
// @author Nitracord
// @version 0.0.1
// @description Keep deleted messages in red and earlier edits in gray, with session-only or persistent history.
// @website https://github.com/Nitracord/nitracord-plugins
// ==/NitracordPlugin==
/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Nitracord contributors. See ../LICENSE.
 */
(function (g) {
  "use strict";
  var dc = g.Nitracord;
  if (!dc || !dc.findModule || !dc.registerTool || !dc.ui)
    throw new Error("Message Logger requires Nitracord runtime 0.0.1+");
  var previousSession = null,
    previousSave;
  if (dc.messageLogger) {
    previousSession = {
      account: dc.messageLogger.status().account,
      entries: dc.messageLogger.entries(),
    };
    previousSave = dc.messageLogger.stop();
  }
  var PREFIX = "nitracord.plugin.message-logger.v1.",
    MAX_LOGS = 10000,
    MAX_EDITS = 20,
    RED = 0xffff6b7a | 0,
    GRAY = 0xffa5a7af | 0,
    active = true,
    account = null,
    epoch = 0,
    revision = 0,
    persistent = false,
    loading = false,
    restoring = false,
    busy = false,
    error = "",
    logs = {},
    records = new Map(),
    dispatcher = null,
    messages = null,
    users = null,
    storage = null,
    creator = null,
    chat = null,
    detach = null,
    undo = [],
    listeners = [],
    timer = null,
    retryTimer = null,
    appStateCleanup = null,
    attempts = 0,
    unregister = null,
    savedQueue = Promise.resolve(previousSave).catch(function () {}),
    ready = Promise.resolve(),
    projections = new WeakMap(),
    liveLookupDepth = 0,
    captureEvents = 0,
    cacheMisses = 0,
    renderCalls = 0,
    decoratedRows = 0,
    projectionHook = false,
    cacheDetail = "",
    storageDetail = "",
    chatModules = new WeakSet(),
    paintDepth = 0,
    bridgeMode = !!(
      dc.messages &&
      dc.messages.apiVersion === 1 &&
      dc.storage &&
      dc.storage.apiVersion === 1
    ),
    bridgeDetach = null,
    actionDetach = null,
    editDispatchers = new WeakSet(),
    observed = new Map(),
    observedBytes = 0,
    loggedOut = null,
    dirtyLogs = new Map(),
    mutation = 0,
    historyCursor = null;
  // A linked disk journal keeps each write small without limiting total history.
  // The pending record makes interrupted appends and erasures recoverable.
  function historyStore(owner) {
    var base = PREFIX + owner + ".archive",
      chunkSize = 65536;
    function parse(value) {
      return typeof value === "string" ? JSON.parse(value) : value;
    }
    function validId(value) {
      return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
    }
    function metadata(value) {
      var result = parse(value);
      if (
        !result ||
        result.format !== 1 ||
        !Number.isInteger(result.parts) ||
        result.parts < 1 ||
        result.parts > 512 ||
        (result.previous !== null && !validId(result.previous))
      )
        throw new Error("Invalid saved history page");
      return result;
    }
    async function head() {
      var value = parse(await storage.getItem(base));
      if (value == null) return null;
      if (value.format !== 2 || !validId(value.cursor))
        throw new Error("Invalid saved history index");
      return value.cursor;
    }
    async function setHead(cursor) {
      if (cursor) await storage.setItem(base, JSON.stringify({ format: 2, cursor: cursor }));
      else await storage.removeItem(base);
    }
    async function erasePage(page) {
      for (var index = 0; index < page.parts; index++)
        await storage.removeItem(base + "." + page.id + "." + index);
      await storage.removeItem(base + "." + page.id);
    }
    async function recover() {
      var pending = parse(await storage.getItem(base + ".pending"));
      if (!pending) return;
      metadata(pending);
      if (!validId(pending.id) || (pending.operation !== "append" && pending.operation !== "erase"))
        throw new Error("Invalid pending history operation");
      var current = await head();
      if (pending.operation === "erase") {
        if (current === pending.id) await setHead(pending.previous);
        else if (current !== pending.previous) throw new Error("History changed during erasure");
        await erasePage(pending);
      } else if (current !== pending.id) {
        if (current !== pending.previous) throw new Error("History changed during a save");
        await erasePage(pending);
      }
      await storage.removeItem(base + ".pending");
    }
    async function appendGroup(serialized) {
      await recover();
      var previous = await head(),
        pageId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14),
        chunks = [];
      for (var offset = 0; offset < serialized.length; ) {
        var end = Math.min(serialized.length, offset + chunkSize);
        if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized.charAt(end - 1))) end--;
        chunks.push(serialized.slice(offset, end));
        offset = end;
      }
      var page = {
        format: 1,
        id: pageId,
        previous: previous,
        parts: chunks.length,
        operation: "append",
      };
      await storage.setItem(base + ".pending", JSON.stringify(page));
      try {
        for (var index = 0; index < chunks.length; index++)
          await storage.setItem(base + "." + pageId + "." + index, chunks[index]);
        await storage.setItem(
          base + "." + pageId,
          JSON.stringify({ format: 1, previous: previous, parts: chunks.length }),
        );
        await setHead(pageId);
        await storage.removeItem(base + ".pending");
      } catch (failure) {
        await recover();
        if ((await head()) !== pageId) throw failure;
      }
    }
    return {
      append: async function (serializedEntries) {
        var group = [],
          length = 0;
        for (var index = 0; index < serializedEntries.length; index++) {
          var value = serializedEntries[index];
          if (group.length && (group.length >= 32 || length + value.length > 131072)) {
            await appendGroup('{"format":1,"entries":[' + group.join(",") + "]}");
            group = [];
            length = 0;
          }
          group.push(value);
          length += value.length;
        }
        if (group.length) await appendGroup('{"format":1,"entries":[' + group.join(",") + "]}");
      },
      read: async function (cursor) {
        await recover();
        if (cursor === undefined) cursor = await head();
        if (cursor === null) return { entries: [], cursor: null };
        if (!validId(cursor)) throw new Error("Invalid history cursor");
        var page = metadata(await storage.getItem(base + "." + cursor)),
          pieces = [];
        for (var index = 0; index < page.parts; index++) {
          var piece = await storage.getItem(base + "." + cursor + "." + index);
          if (typeof piece !== "string" || piece.length > chunkSize)
            throw new Error("Saved history page is incomplete");
          pieces.push(piece);
        }
        var data = JSON.parse(pieces.join(""));
        if (!data || data.format !== 1 || !Array.isArray(data.entries) || data.entries.length > 32)
          throw new Error("Invalid saved history contents");
        return { entries: data.entries, cursor: page.previous, id: cursor };
      },
      clear: async function () {
        await recover();
        var cursor;
        while ((cursor = await head()) !== null) {
          var page = metadata(await storage.getItem(base + "." + cursor));
          await storage.setItem(
            base + ".pending",
            JSON.stringify({
              format: 1,
              id: cursor,
              previous: page.previous,
              parts: page.parts,
              operation: "erase",
            }),
          );
          await recover();
        }
      },
    };
  }
  function id(value) {
    return typeof value === "string" && /^\d{15,22}$/.test(value);
  }
  function key(channel, message) {
    return channel + ":" + message;
  }
  function emit() {
    listeners.slice().forEach(function (fn) {
      try {
        fn();
      } catch (ignore) {}
    });
  }
  function text(value, limit) {
    return typeof value === "string" ? value.slice(0, limit || 20000) : "";
  }
  function iso(value) {
    var time = value ? Date.parse(String(value)) : NaN;
    return new Date(isFinite(time) ? time : Date.now()).toISOString();
  }
  function displayTime(value) {
    var date = new Date(value);
    if (!isFinite(date.getTime())) return "Unknown time";
    try {
      return date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (ignore) {
      function pad(number) {
        return String(number).padStart(2, "0");
      }
      return (
        pad(date.getDate()) +
        "." +
        pad(date.getMonth() + 1) +
        "." +
        date.getFullYear() +
        " · " +
        pad(date.getHours()) +
        ":" +
        pad(date.getMinutes())
      );
    }
  }
  function snapshot(message, previous) {
    if (!message || !id(message.id) || !id(message.channel_id || message.channelId)) return null;
    var author = message.author || {},
      priorAuthor = (previous && previous.author) || {},
      content =
        typeof message.content === "string" ? message.content : previous ? previous.content : "",
      attachments = Array.isArray(message.attachments)
        ? message.attachments
        : previous
          ? previous.attachments
          : [];
    var authorId = author.id || priorAuthor.id;
    if (!id(authorId)) return null;
    return {
      id: message.id,
      channel_id: message.channel_id || message.channelId,
      author: {
        id: authorId,
        username: text(author.username || priorAuthor.username, 100),
        global_name: text(author.global_name || author.globalName || priorAuthor.global_name, 100),
        bot: author.bot === undefined ? priorAuthor.bot === true : author.bot === true,
      },
      content: text(content),
      timestamp: iso(message.timestamp || (previous && previous.timestamp)),
      edited_timestamp: message.edited_timestamp ? iso(message.edited_timestamp) : null,
      attachments: attachments.slice(0, 10).map(function (file) {
        return {
          id: id(file.id) ? file.id : "",
          filename: text(file.filename, 240),
          url:
            typeof file.url === "string" && /^https:\/\//i.test(file.url)
              ? file.url.slice(0, 2048)
              : "",
        };
      }),
      type: 0,
      flags: 0,
      mentions: [],
      mention_roles: [],
      embeds: [],
      reactions: [],
    };
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function entries() {
    return Object.keys(logs)
      .map(function (k) {
        return logs[k];
      })
      .filter(function (entry) {
        return !entry.removed;
      })
      .sort(function (a, b) {
        return b.changedAt - a.changedAt || compare(b.message, a.message);
      });
  }
  function trim() {
    var items = entries();
    items.slice(MAX_LOGS).forEach(function (item) {
      var k = key(item.message.channel_id, item.message.id);
      // A dirty entry must reach disk before leaving the persistent hot cache.
      if (persistent && dirtyLogs.has(k)) return;
      if (persistent) historyCursor = undefined;
      delete logs[k];
      records.delete(k);
      dirtyLogs.delete(k);
    });
  }
  function changed() {
    trim();
    revision++;
    projections = new WeakMap();
    scheduleSave();
    emit();
  }
  function queue(work) {
    var result = savedQueue.then(work);
    savedQueue = result.catch(function () {});
    return result;
  }
  function cancelSave() {
    if (timer !== null) g.clearTimeout(timer);
    timer = null;
  }
  function flush() {
    cancelSave();
    if (!storage || !persistent || !account || loading || restoring || busy || !active)
      return savedQueue;
    var owner = account,
      generation = epoch,
      versions = new Map(dirtyLogs),
      serialized = Array.from(versions.keys())
        .filter(function (k) {
          return !!logs[k];
        })
        .sort(function (a, b) {
          return logs[a].changedAt - logs[b].changedAt || compare(logs[a].message, logs[b].message);
        })
        .map(function (k) {
          return JSON.stringify(logs[k]);
        });
    if (!serialized.length) return savedQueue;
    return queue(function () {
      return historyStore(owner).append(serialized);
    })
      .then(function () {
        if (epoch === generation) {
          versions.forEach(function (version, k) {
            if (dirtyLogs.get(k) === version) dirtyLogs.delete(k);
          });
          trim();
        }
        if (
          epoch === generation &&
          error === "Could not save history. Keep Discord open and retry."
        ) {
          error = "";
          emit();
        }
      })
      .catch(function () {
        if (epoch === generation) {
          error = "Could not save history. Keep Discord open and retry.";
          emit();
        }
      });
  }
  function scheduleSave() {
    if (timer === null && persistent && !loading && !restoring && !busy)
      timer = g.setTimeout(flush, 500);
  }
  function repaint() {
    if (bridgeMode) {
      dc.messages.repaint();
      return;
    }
    if (messages && typeof messages.emitChange === "function")
      try {
        messages.emitChange();
      } catch (ignore) {}
  }
  function normalizeEntry(item) {
    if (!item || typeof item !== "object") return null;
    if (item.removed === true) {
      var target = item.message;
      if (!target || !id(target.id) || !id(target.channel_id) || !Number.isFinite(item.changedAt))
        return null;
      return {
        removed: true,
        message: { id: target.id, channel_id: target.channel_id },
        changedAt: item.changedAt,
      };
    }
    var message = snapshot(item.message);
    if (!message || (item.deleted !== true && !Array.isArray(item.edits))) return null;
    return {
      message: message,
      deleted: item.deleted === true,
      changedAt:
        typeof item.changedAt === "number" && isFinite(item.changedAt)
          ? item.changedAt
          : Date.now(),
      edits: (Array.isArray(item.edits) ? item.edits : [])
        .slice(-MAX_EDITS)
        .map(function (edit) {
          var version = snapshot(edit.message);
          return version && version.id === message.id && version.channel_id === message.channel_id
            ? { message: version, at: iso(edit.at) }
            : null;
        })
        .filter(Boolean),
    };
  }
  function mergeSaved(value) {
    if (!value) return;
    var input = typeof value === "string" ? JSON.parse(value) : value;
    if (!input || input.format !== 1 || !Array.isArray(input.entries))
      throw new Error("Invalid saved history");
    input.entries.forEach(function (item) {
      var saved = normalizeEntry(item);
      if (!saved) return;
      var k = key(saved.message.channel_id, saved.message.id),
        existing = logs[k];
      if (existing) {
        if (existing.removed || saved.removed) {
          if (saved.removed) logs[k] = saved;
          return;
        }
        if (!dirtyLogs.has(k) && saved.changedAt > existing.changedAt) {
          logs[k] = saved;
          saved = existing;
          existing = logs[k];
        }
        var versions = saved.edits.concat(existing.edits),
          seen = {};
        existing.edits = versions
          .sort(function (a, b) {
            return Date.parse(a.at) - Date.parse(b.at);
          })
          .filter(function (edit) {
            var signature = edit.at + ":" + edit.message.content;
            if (seen[signature]) return false;
            seen[signature] = true;
            return true;
          })
          .slice(-MAX_EDITS);
      } else logs[k] = saved;
    });
    trim();
    revision++;
    projections = new WeakMap();
  }
  function selectAccount(next, retain) {
    if (next === account && !retain) return ready;
    var retainedLogs = retain && next === account ? logs : {},
      retainedRecords = retain && next === account ? records : new Map();
    flush();
    cancelSave();
    epoch++;
    account = next;
    logs = retainedLogs;
    records = retainedRecords;
    if (!retain) dirtyLogs = new Map();
    historyCursor = null;
    if (next && previousSession) {
      if (previousSession.account === next)
        mergeSaved({ format: 1, entries: previousSession.entries });
      Object.keys(logs).forEach(function (k) {
        dirtyLogs.set(k, ++mutation);
      });
      previousSession = null;
    }
    if (!retain) {
      observed = new Map();
      observedBytes = 0;
    }
    if (!retain) persistent = false;
    loading = !!next && !!storage;
    restoring = loading;
    busy = false;
    error = "";
    revision++;
    projections = new WeakMap();
    var generation = epoch;
    ready = !loading
      ? Promise.resolve()
      : queue(async function () {
          var value = await storage.getItem(PREFIX + next + ".settings");
          var settings = typeof value === "string" ? JSON.parse(value) : value;
          var keep = !!settings && settings.persistent === true;
          if (!active || epoch !== generation) return;
          // The stored choice remains valid even if reading its history fails.
          persistent = keep;
          var archive = historyStore(next),
            data = keep ? await storage.getItem(PREFIX + next + ".logs") : null;
          if (keep && data) {
            var legacy = typeof data === "string" ? JSON.parse(data) : data;
            if (!legacy || legacy.format !== 1 || !Array.isArray(legacy.entries))
              throw new Error("Invalid saved history");
            // Keep the old snapshot intact until every page has committed.
            await archive.append(
              legacy.entries
                .map(normalizeEntry)
                .filter(Boolean)
                .sort(function (a, b) {
                  return a.changedAt - b.changedAt || compare(a.message, b.message);
                })
                .map(function (entry) {
                  return JSON.stringify(entry);
                }),
            );
            await storage.removeItem(PREFIX + next + ".logs");
          }
          var cursor;
          if (keep) {
            // Bound startup work and memory; older pages stay available on disk.
            for (var pageIndex = 0; pageIndex < 32; pageIndex++) {
              var page = await archive.read(cursor);
              if (!active || epoch !== generation) return;
              mergeSaved({ format: 1, entries: page.entries });
              cursor = page.cursor;
              if (cursor === null) break;
            }
          } else {
            await archive.clear();
            await storage.removeItem(PREFIX + next + ".logs");
            cursor = null;
          }
          if (!active || epoch !== generation) return;
          historyCursor = cursor;
          restoring = false;
          storageDetail = "";
        })
          .catch(function (failure) {
            if (epoch === generation) {
              storageDetail = String((failure && failure.name) || "Error");
              error = "Could not load saved history. Session logging remains available.";
            }
          })
          .then(function () {
            if (epoch === generation) {
              loading = false;
              scheduleSave();
              emit();
              repaint();
            }
          });
    emit();
    return ready;
  }
  function ensureAccount() {
    if (!active) return null;
    if (bridgeMode) {
      var bridgeUser = dc.messages.currentUser();
      if (loggedOut && bridgeUser === loggedOut) bridgeUser = null;
      else if (loggedOut) loggedOut = null;
      selectAccount(id(bridgeUser) ? bridgeUser : null);
      return account;
    }
    function read(store) {
      // Several unrelated modules expose getCurrentUser, including a null stub.
      // Only inspect the synchronous user cache; never call account API actions.
      if (
        !store ||
        typeof store.getCurrentUser !== "function" ||
        typeof store.getUser !== "function" ||
        typeof store.getUsers !== "function"
      )
        return null;
      try {
        var value = store.getCurrentUser();
        if (value && typeof value.then === "function") {
          if (typeof value.catch === "function") value.catch(function () {});
          return null;
        }
        return value && id(value.id) ? value : null;
      } catch (ignore) {
        return null;
      }
    }
    var user = read(users);
    if (!user) {
      users = dc.findModule(function (candidate) {
        var value = read(candidate);
        if (!value) return false;
        user = value;
        return true;
      });
    }
    var next = user && id(user.id) ? user.id : null;
    if (loggedOut && next === loggedOut) next = null;
    else if (loggedOut) loggedOut = null;
    selectAccount(next);
    return account;
  }
  function remember(raw, channel) {
    if (!raw || (raw.flags & 64) === 64) return null;
    if (!raw.channel_id && !raw.channelId && id(channel))
      raw = Object.assign({}, raw, { channel_id: channel });
    var saved = snapshot(raw);
    if (!saved) return null;
    var k = key(saved.channel_id, saved.id),
      prior = observed.get(k),
      bytes = JSON.stringify(saved).length * 3;
    if (prior) {
      observedBytes -= prior.bytes;
      observed.delete(k);
    }
    observed.set(k, { message: saved, bytes: bytes });
    observedBytes += bytes;
    while (observed.size > MAX_LOGS || observedBytes > 900000) {
      var first = observed.keys().next().value,
        oldest = observed.get(first);
      observedBytes -= oldest.bytes;
      observed.delete(first);
    }
    return saved;
  }
  function forget(channel, messageId) {
    var k = key(channel, messageId),
      prior = observed.get(k);
    if (prior) {
      observedBytes -= prior.bytes;
      observed.delete(k);
    }
  }
  function readMessage(channel, messageId) {
    if (bridgeMode) {
      var live = dc.messages.get(channel, messageId),
        cached = observed.get(key(channel, messageId));
      return live || (cached && cached.message) || null;
    }
    var found = null;
    function valid(raw) {
      var saved = snapshot(raw);
      return saved && saved.id === messageId && saved.channel_id === channel;
    }
    function probe(store) {
      if (
        !store ||
        typeof store.getMessage !== "function" ||
        typeof store.getMessages !== "function" ||
        typeof store.emitChange !== "function"
      )
        return false;
      liveLookupDepth++;
      try {
        var raw = store.getMessage(channel, messageId);
        if (valid(raw)) {
          found = raw;
          return true;
        }
        if (store === messages)
          cacheDetail =
            "Record=" +
            typeof raw +
            "; id=" +
            (raw && typeof raw.id) +
            "; channel=" +
            (raw && typeof (raw.channel_id || raw.channelId)) +
            "; author=" +
            (raw && typeof raw.author) +
            "; author.id=" +
            (raw && raw.author && typeof raw.author.id);
        var cache = store.getMessages(channel),
          items =
            cache && typeof cache.toArray === "function"
              ? cache.toArray()
              : Array.isArray(cache)
                ? cache
                : null;
        if (store === messages)
          cacheDetail +=
            "; collection=" +
            typeof cache +
            "; rows=" +
            (Array.isArray(items) ? items.length : "unavailable");
        if (Array.isArray(items))
          for (var i = 0; i < items.length; i++)
            if (items[i] && items[i].id === messageId && valid(items[i])) {
              found = items[i];
              return true;
            }
      } catch (ignore) {
      } finally {
        liveLookupDepth--;
      }
      return false;
    }
    if (!probe(messages))
      dc.findModule(function (store) {
        return store !== messages && probe(store);
      });
    var prior = observed.get(key(channel, messageId));
    return found || (prior && prior.message) || null;
  }
  function before(event) {
    if (!active || !event) return false;
    try {
      if (event.type === "LOGOUT") {
        loggedOut = account;
        selectAccount(null);
        repaint();
        return false;
      }
      if (!ensureAccount()) return false;
      if (event.type === "MESSAGE_CREATE" && event.message) {
        remember(event.message, event.channelId || event.channel_id);
        return false;
      }
      if (
        (event.type === "LOAD_MESSAGES_SUCCESS" ||
          event.type === "LOAD_MESSAGES_SUCCESS_CACHED" ||
          event.type === "LOCAL_MESSAGES_LOADED") &&
        Array.isArray(event.messages)
      ) {
        event.messages.slice(-MAX_LOGS).forEach(function (message) {
          remember(message, event.channelId || event.channel_id);
        });
        return false;
      }
      if (
        event.type === "MESSAGE_UPDATE" ||
        event.type === "MESSAGE_DELETE" ||
        event.type === "MESSAGE_DELETE_BULK"
      )
        captureEvents++;
      if (
        event.type === "MESSAGE_UPDATE" &&
        event.message &&
        typeof event.message.content === "string"
      ) {
        var update = event.message,
          channel = update.channel_id || update.channelId;
        if (!id(channel) || !id(update.id)) return false;
        var old = readMessage(channel, update.id),
          previous = snapshot(old),
          k = key(channel, update.id);
        if (logs[k] && logs[k].removed) return false;
        if (!previous) {
          cacheMisses++;
          remember(update, channel);
          emit();
          return false;
        }
        if (previous.content === update.content) {
          emit();
          return false;
        }
        var next = snapshot(update, previous);
        if (!next) return false;
        remember(next);
        var entry = logs[k] || {
          message: previous,
          edits: [],
          deleted: false,
          changedAt: Date.now(),
        };
        entry.edits.push({ message: previous, at: iso(update.edited_timestamp) });
        entry.edits = entry.edits.slice(-MAX_EDITS);
        entry.message = next;
        entry.changedAt = Date.now();
        logs[k] = entry;
        dirtyLogs.set(k, ++mutation);
        changed();
      } else if (
        (event.type === "MESSAGE_DELETE" || event.type === "MESSAGE_DELETE_BULK") &&
        event.local !== true
      ) {
        var channelId = event.channelId || event.channel_id;
        if (!id(channelId)) return false;
        (event.type === "MESSAGE_DELETE_BULK"
          ? Array.isArray(event.ids)
            ? event.ids.slice(0, 1000)
            : []
          : [event.id]
        ).forEach(function (messageId) {
          if (!id(messageId)) return;
          var original = readMessage(channelId, messageId),
            saved = snapshot(original),
            k = key(channelId, messageId);
          if (logs[k] && logs[k].removed) return;
          if (!saved) {
            cacheMisses++;
            return;
          }
          var entry = logs[k] || {
            message: saved,
            edits: [],
            deleted: false,
            changedAt: Date.now(),
          };
          entry.message = saved;
          entry.deleted = true;
          entry.changedAt = Date.now();
          logs[k] = entry;
          dirtyLogs.set(k, ++mutation);
          records.delete(k);
          forget(channelId, messageId);
        });
        changed();
      }
    } catch (ignore) {
      error = "A message could not be logged; Discord continued normally.";
      emit();
    }
    return false;
  }
  function compare(a, b) {
    return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  function project(base, channel) {
    if (
      !active ||
      !ensureAccount() ||
      !base ||
      typeof base.toArray !== "function" ||
      typeof base.merge !== "function"
    )
      return base;
    var cached = projections.get(base);
    if (cached && cached.revision === revision && cached.channel === channel) return cached.value;
    var current = base.toArray();
    if (!Array.isArray(current)) return base;
    var ordered = current
      .filter(function (item) {
        return item && id(item.id);
      })
      .slice()
      .sort(compare);
    var present = typeof base.hasPresent === "function" && base.hasPresent();
    if (!ordered.length && !present) return base;
    var first = ordered[0],
      last = ordered[ordered.length - 1],
      missing = [];
    entries().forEach(function (entry) {
      var raw = entry.message;
      if (
        !entry.deleted ||
        raw.channel_id !== channel ||
        (typeof base.has === "function" && base.has(raw.id))
      )
        return;
      if (
        (first && compare(raw, first) < 0 && base.hasMoreBefore !== false) ||
        (last && compare(raw, last) > 0 && !present)
      )
        return;
      var k = key(channel, raw.id),
        record = records.get(k);
      if (!record && creator) {
        try {
          var displayed = clone(raw);
          // A changed display value invalidates Discord's memoized native row immediately.
          displayed.content = "-# " + deletionLabel(entry) + "\n" + body(raw);
          record = creator.createMessageRecord(displayed);
          records.set(k, record);
        } catch (ignore) {}
      }
      if (record) missing.push(record);
    });
    var result = base;
    if (missing.length) {
      var merged = base.merge(missing);
      if (merged !== base && Array.isArray(merged._array)) {
        merged._array = merged._array.slice().sort(compare);
        result = merged;
      }
    }
    projections.set(base, { channel: channel, revision: revision, value: result });
    return result;
  }
  function body(message) {
    return (
      message.content ||
      (message.attachments.length
        ? message.attachments
            .map(function (a) {
              return "[Attachment: " + a.filename + "]";
            })
            .join("\n")
        : "[No text content]")
    );
  }
  function coloredText(content, color) {
    return {
      type: "link",
      content: content,
      target: {
        type: "com.discord.chat.bridge.contentnode.LinkContextData.BindDoNothing",
        linkColor: color,
        medium: false,
      },
      linkColor: color,
      medium: false,
      isUrl: false,
    };
  }
  function labelNode(value) {
    return { type: "subtext", content: [{ type: "text", content: value }] };
  }
  function deletionLabel(entry) {
    return "Deleted · " + displayTime(entry.changedAt);
  }
  function isDeletionLabel(value) {
    return value === "Deleted message" || value.indexOf("Deleted · ") === 0;
  }
  function compactContent(prefix, content) {
    var leading = prefix.slice(),
      rest = content.slice();
    while (rest.length && rest[0].type === "subtext") leading.push(rest.shift());
    if (rest.length && rest[0].type === "paragraph")
      return [{ type: "paragraph", content: leading.concat(rest[0].content) }].concat(
        rest.slice(1),
      );
    return [{ type: "paragraph", content: leading.concat(rest) }];
  }
  function deletedContent(value, label) {
    var count = 0;
    function tint(node, depth) {
      if (!node || typeof node !== "object" || depth > 12 || ++count > 20000) return node;
      if (Array.isArray(node))
        return node.map(function (item) {
          return tint(item, depth + 1);
        });
      if (node.type === "subtext" && isDeletionLabel(firstText(node, 0)))
        return Object.assign({}, node, { content: [{ type: "text", content: label }] });
      if (node.type === "text" && typeof node.content === "string") return coloredText([node], RED);
      if (node.type === "link") {
        var link = Object.assign({}, node, { linkColor: RED });
        if (node.target && typeof node.target === "object")
          link.target = Object.assign({}, node.target, { linkColor: RED });
        return link;
      }
      var copy = null;
      Object.keys(node).forEach(function (name) {
        var next = tint(node[name], depth + 1);
        if (next !== node[name]) {
          if (!copy) copy = Object.assign({}, node);
          copy[name] = next;
        }
      });
      return copy || node;
    }
    return tint(value, 0);
  }
  function firstText(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return "";
    if (node.type === "text" && typeof node.content === "string") return node.content;
    var content = Array.isArray(node) ? node : node.content;
    if (Array.isArray(content))
      for (var index = 0; index < content.length; index++) {
        var value = firstText(content[index], depth + 1);
        if (value) return value;
      }
    return "";
  }
  function editable(channel, messageId) {
    if (!active || !ensureAccount()) return true;
    var entry = logs[key(channel, messageId)];
    return !entry || (!entry.deleted && !entry.removed);
  }
  function messageActions(channel, messageId) {
    if (!active || !ensureAccount()) return null;
    var owner = account,
      entry = logs[key(channel, messageId)];
    if (!entry) return null;
    if (entry.removed) return [];
    if (!entry.deleted) return null;
    return [
      {
        id: "message-logger-force-delete",
        label: "Force delete",
        isDestructive: true,
        onPress: function () {
          if (!active || ensureAccount() !== owner) return;
          return forceDelete(channel, messageId);
        },
      },
    ];
  }
  async function forceDelete(channel, messageId) {
    var owner = ensureAccount(),
      generation = epoch;
    await ready;
    if (!owner || owner !== account || generation !== epoch || !active)
      throw new Error("The account changed. Please retry.");
    if (busy || restoring) throw new Error("Saved history is not ready. Please retry.");
    var k = key(channel, messageId),
      entry = logs[k];
    if (!entry || !entry.deleted || entry.removed) return;
    logs[k] = {
      removed: true,
      message: { id: messageId, channel_id: channel },
      changedAt: Date.now(),
    };
    dirtyLogs.set(k, ++mutation);
    records.delete(k);
    forget(channel, messageId);
    changed();
    repaint();
    await flush();
    if (persistent && dirtyLogs.has(k))
      throw new Error("Could not save the removal. Keep Discord open and retry saving history.");
  }
  function decorate(value) {
    var count = 0;
    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 12 || ++count > 20000) return node;
      if (Array.isArray(node)) {
        var changed = false,
          next = node.map(function (item) {
            var result = visit(item, depth + 1);
            if (result !== item) changed = true;
            return result;
          });
        return changed ? next : node;
      }
      var copy = null;
      if (id(node.id) && id(node.channelId) && Array.isArray(node.content)) {
        var entry = logs[key(node.channelId, node.id)];
        if (!entry || entry.removed) return node;
        decoratedRows++;
        copy = Object.assign({}, node);
        var history = [];
        entry.edits.slice(-5).forEach(function (edit) {
          history.push(labelNode("Earlier edit · " + displayTime(edit.at)));
          history.push(coloredText([{ type: "text", content: body(edit.message) + "\n" }], GRAY));
        });
        if (entry.deleted) {
          copy.textColor = RED;
          copy.linkColor = RED;
          copy.editedColor = RED;
          copy.isCurrentUserMessageAuthor = false;
          var label = deletionLabel(entry),
            content = deletedContent(node.content, label);
          if (!isDeletionLabel(firstText(node.content, 0))) history.push(labelNode(label));
          copy.content = compactContent(history, content);
        } else if (entry.edits.length) copy.content = compactContent(history, node.content);
        return copy;
      }
      Object.keys(node).forEach(function (name) {
        var result = visit(node[name], depth + 1);
        if (result !== node[name]) {
          if (!copy) copy = Object.assign({}, node);
          copy[name] = result;
        }
      });
      return copy || node;
    }
    return visit(value, 0);
  }
  function patch(owner, name, wrap) {
    var original = owner[name],
      replacement = wrap(original);
    owner[name] = replacement;
    if (owner[name] !== replacement) throw new Error("Read-only client module");
    undo.push(function () {
      if (owner[name] === replacement) owner[name] = original;
    });
  }
  function attach() {
    if (!active) return false;
    if (!bridgeMode || typeof dc.messages.canEdit !== "function") {
      var editStore = dc.findModule(function (value) {
        return (
          typeof value.getMessages === "function" &&
          typeof value.getMessage === "function" &&
          typeof value.getLastEditableMessage === "function" &&
          value._dispatcher
        );
      });
      var editFlux = editStore && editStore._dispatcher;
      if (editFlux && typeof editFlux.dispatch === "function" && !editDispatchers.has(editFlux))
        try {
          patch(editFlux, "dispatch", function (original) {
            return function (event) {
              if (
                event &&
                event.type === "MESSAGE_START_EDIT" &&
                !editable(event.channelId || event.channel_id, event.messageId || event.id)
              )
                return;
              return original.apply(this, arguments);
            };
          });
          editDispatchers.add(editFlux);
        } catch (ignore) {}
    }
    if (!appStateCleanup && dc.Native && dc.Native.AppState) {
      try {
        var appState = dc.Native.AppState;
        var onState = function (state) {
          if (state === "background" || state === "inactive") flush();
        };
        var subscription = appState.addEventListener("change", onState);
        appStateCleanup = function () {
          if (subscription && typeof subscription.remove === "function") subscription.remove();
          else if (typeof appState.removeEventListener === "function")
            appState.removeEventListener("change", onState);
        };
      } catch (ignore) {}
    }
    if (bridgeMode) {
      if (!storage) storage = dc.storage.scope("message-logger");
      if (!actionDetach && typeof dc.messages.actions === "function")
        actionDetach = dc.messages.actions(messageActions);
      if (!detach) detach = dc.messages.subscribe(before);
      if (!bridgeDetach)
        bridgeDetach = dc.messages.render(
          function (rows) {
            renderCalls++;
            return ensureAccount() ? decorate(rows) : rows;
          },
          project,
          editable,
        );
      creator = {
        createMessageRecord: function (raw) {
          return dc.messages.createRecord(raw);
        },
      };
      chat = dc.messages;
      messages = { emitChange: dc.messages.repaint };
      ensureAccount();
      if (account && restoring && !loading) selectAccount(account, true);
      emit();
      return !!account && !restoring;
    }
    ensureAccount();
    if (!storage) {
      storage = dc.findModule(function (m) {
        return (
          typeof m.getItem === "function" &&
          typeof m.setItem === "function" &&
          typeof m.removeItem === "function" &&
          typeof m.multiRemove === "function" &&
          typeof m.mergeItem === "function"
        );
      });
      if (storage && account) selectAccount(account, true);
    }
    creator =
      creator ||
      dc.findModule(function (m) {
        return typeof m.createMessageRecord === "function";
      });
    if (!messages) {
      var candidate = dc.findModule(function (m) {
        return (
          typeof m.getMessage === "function" &&
          typeof m.getMessages === "function" &&
          typeof m.emitChange === "function" &&
          typeof m.getLastEditableMessage === "function" &&
          typeof m.hasPresent === "function"
        );
      });
      if (candidate) {
        // Recording does not depend on being able to replace display methods.
        messages = candidate;
        var checkpoint = undo.length;
        try {
          patch(candidate, "getMessages", function (original) {
            return function (channel) {
              var base = original.apply(this, arguments);
              if (liveLookupDepth) return base;
              try {
                return project(base, channel);
              } catch (ignore) {
                return base;
              }
            };
          });
          // The edit-last-message shortcut must only see Discord's live cache.
          patch(candidate, "getLastEditableMessage", function (original) {
            return function () {
              liveLookupDepth++;
              try {
                return original.apply(this, arguments);
              } finally {
                liveLookupDepth--;
              }
            };
          });
          projectionHook = true;
        } catch (ignore) {
          while (undo.length > checkpoint)
            try {
              undo.pop()();
            } catch (cleanupFailure) {}
        }
      }
    }
    if (!detach && messages) {
      function supportedDispatcher(m) {
        return (
          !!m &&
          typeof m.addInterceptor === "function" &&
          typeof m.dispatch === "function" &&
          (Array.isArray(m._interceptors) || typeof m.removeInterceptor === "function")
        );
      }
      // A structurally similar dispatcher can belong to a separate store graph.
      var flux = supportedDispatcher(messages._dispatcher)
        ? messages._dispatcher
        : dc.findModule(supportedDispatcher);
      if (flux)
        try {
          var remove = flux.addInterceptor(before);
          dispatcher = flux;
          detach =
            typeof remove === "function"
              ? remove
              : function () {
                  if (typeof flux.removeInterceptor === "function") flux.removeInterceptor(before);
                  else {
                    var index = flux._interceptors.indexOf(before);
                    if (index >= 0) flux._interceptors.splice(index, 1);
                  }
                };
        } catch (ignore) {}
    }
    {
      var triedChats = new WeakSet(),
        nativeChat;
      for (var attempt = 0; attempt < 16; attempt++) {
        nativeChat = dc.findModule(function (m) {
          return (
            !triedChats.has(m) &&
            !chatModules.has(m) &&
            typeof m.updateRows === "function" &&
            typeof m.clearRows === "function" &&
            typeof m.scrollToBottom === "function"
          );
        });
        if (!nativeChat) break;
        triedChats.add(nativeChat);
        try {
          patch(nativeChat, "updateRows", function (original) {
            return function (view, payload) {
              var args = Array.prototype.slice.call(arguments);
              renderCalls++;
              if (!paintDepth && active && ensureAccount() && payload)
                try {
                  if (typeof payload === "string") {
                    // Android's ChatModule takes serialized operations, while
                    // NativeChatUtils takes an object containing the rows.
                    var parsed = JSON.parse(payload);
                    if (Array.isArray(parsed)) {
                      var painted = decorate(parsed);
                      if (painted !== parsed) args[1] = JSON.stringify(painted);
                    }
                  } else if (Array.isArray(payload.rows)) {
                    var rows = decorate(payload.rows);
                    if (rows !== payload.rows) args[1] = Object.assign({}, payload, { rows: rows });
                  }
                } catch (ignore) {}
              paintDepth++;
              try {
                return original.apply(this, args);
              } finally {
                paintDepth--;
              }
            };
          });
          chatModules.add(nativeChat);
          chat = chat || nativeChat;
        } catch (ignore) {}
      }
    }
    ensureAccount();
    if (account && restoring && !loading) selectAccount(account, true);
    emit();
    return !!(detach && chat && creator && storage && account && renderCalls && !restoring);
  }
  async function setPersistent(value) {
    if (typeof value !== "boolean") throw new Error("Invalid storage choice");
    var target = ensureAccount();
    await ready;
    if (account !== target) throw new Error("The account changed. Please retry.");
    if (!active) throw new Error("Restart Discord to reload Message Logger");
    if (!account)
      throw new Error(
        "Could not find the active Discord user store. Open a chat, then tap Refresh / retry hooks.",
      );
    if (!storage) throw new Error("Persistent storage is unavailable on this build");
    if (restoring)
      throw new Error("Saved storage choice is still loading. Tap Refresh / retry hooks.");
    if (busy) throw new Error("Wait for the storage change to finish");
    if (value === persistent) return;
    busy = true;
    cancelSave();
    error = "";
    emit();
    var owner = account,
      generation = epoch,
      versions = new Map(dirtyLogs),
      serialized = entries()
        .reverse()
        .map(function (entry) {
          return JSON.stringify(entry);
        });
    try {
      await queue(async function () {
        if (value) {
          await historyStore(owner).append(serialized);
          await storage.setItem(PREFIX + owner + ".settings", JSON.stringify({ persistent: true }));
        } else {
          await historyStore(owner).clear();
          await storage.removeItem(PREFIX + owner + ".logs");
          await storage.setItem(
            PREFIX + owner + ".settings",
            JSON.stringify({ persistent: false }),
          );
        }
      });
      if (epoch === generation) {
        persistent = value;
        historyCursor = null;
        versions.forEach(function (version, k) {
          if (dirtyLogs.get(k) === version) dirtyLogs.delete(k);
        });
        trim();
      }
    } catch (failure) {
      if (value)
        try {
          await queue(async function () {
            await historyStore(owner).clear();
            await storage.removeItem(PREFIX + owner + ".logs");
          });
        } catch (cleanupFailure) {
          if (epoch === generation)
            error =
              "Could not enable persistence or erase its partial saved copy. Retry Clear history.";
          throw new Error("Could not erase the partial saved copy. Retry Clear history.");
        }
      if (epoch === generation)
        error = "Could not change storage mode. Your previous choice remains active; retry.";
      throw new Error("Could not change storage mode. Please retry.");
    } finally {
      if (epoch === generation) {
        busy = false;
        scheduleSave();
        emit();
      }
    }
  }
  async function clear() {
    var target = ensureAccount();
    await ready;
    if (account !== target) throw new Error("The account changed. Please retry.");
    if (busy) throw new Error("Wait for the storage change to finish");
    busy = true;
    cancelSave();
    var owner = account,
      generation = epoch;
    try {
      if (storage && owner)
        await queue(async function () {
          await historyStore(owner).clear();
          await storage.removeItem(PREFIX + owner + ".logs");
        });
      if (epoch === generation) {
        logs = {};
        dirtyLogs.clear();
        historyCursor = null;
        records = new Map();
        revision++;
        projections = new WeakMap();
        error = "";
        repaint();
      }
    } catch (failure) {
      if (epoch === generation) error = "Could not erase saved history. Please retry.";
      throw new Error("Could not erase saved history");
    } finally {
      if (epoch === generation) {
        busy = false;
        emit();
      }
    }
  }
  async function historyPage(cursor, seen) {
    var owner = ensureAccount(),
      generation = epoch;
    await ready;
    if (!owner || owner !== account || generation !== epoch)
      throw new Error("The account changed. Please retry.");
    if (!persistent || restoring || busy) throw new Error("Saved history is not ready");
    if (cursor === undefined) cursor = historyCursor;
    var result = await queue(async function () {
      var unique = new Map(),
        page,
        visitedPages = new Set(),
        visited = new Set(Array.isArray(seen) ? seen : []);
      do {
        if (!active || generation !== epoch) throw new Error("The account changed. Please retry.");
        page = await historyStore(owner).read(cursor);
        if (page.id && visitedPages.has(page.id)) throw new Error("Invalid history page cycle");
        if (page.id) visitedPages.add(page.id);
        page.entries
          .map(normalizeEntry)
          .filter(Boolean)
          .forEach(function (entry) {
            var k = key(entry.message.channel_id, entry.message.id),
              existing = unique.get(k);
            if (entry.removed) {
              visited.add(k);
              return;
            }
            if (logs[k] || visited.has(k)) return;
            if (!existing || existing.changedAt < entry.changedAt) unique.set(k, entry);
          });
        cursor = page.cursor;
      } while (unique.size < 32 && cursor !== null);
      unique.forEach(function (entry, k) {
        visited.add(k);
      });
      return {
        account: owner,
        entries: Array.from(unique.values()).sort(function (a, b) {
          return b.changedAt - a.changedAt || compare(b.message, a.message);
        }),
        cursor: cursor,
        seen: Array.from(visited),
      };
    });
    if (!active || generation !== epoch) throw new Error("The account changed. Please retry.");
    return result;
  }
  function checkCache() {
    if (bridgeMode) {
      var state = dc.messages.status();
      return state.cacheHits ? "ready" : state.stores ? "empty" : "unavailable";
    }
    if (!messages) return "unavailable";
    try {
      var channel = null;
      dc.findModule(function (module) {
        if (typeof module.getChannelId !== "function") return false;
        var value = module.getChannelId();
        if (!id(value)) return false;
        channel = value;
        return true;
      });
      if (!channel) return "empty";
      var cache = messages.getMessages(channel);
      if (!cache || typeof cache.toArray !== "function" || typeof cache.merge !== "function")
        return "unavailable";
      var items = cache.toArray();
      if (!Array.isArray(items)) return "unavailable";
      if (!items.length) return "empty";
      return items.slice(-10).some(function (message) {
        return message && snapshot(messages.getMessage(channel, message.id));
      })
        ? "ready"
        : "unavailable";
    } catch (ignore) {
      return "unavailable";
    }
  }
  function status() {
    ensureAccount();
    return {
      active: active,
      hook: !!detach,
      inline: !!chat,
      restoration: !!creator,
      projection: projectionHook,
      persistent: persistent,
      storage: !!storage,
      loading: loading,
      restoring: restoring,
      busy: busy,
      count: entries().length,
      actionGuard: !!actionDetach,
      hasOlder: historyCursor !== null,
      error: error,
      account: account,
      cache: checkCache(),
      captureEvents: captureEvents,
      cacheMisses: cacheMisses,
      renderCalls: renderCalls,
      decoratedRows: decoratedRows,
      storeDispatcher: !!(messages && dispatcher && dispatcher === messages._dispatcher),
      cacheDetail: cacheDetail,
      storageDetail: storageDetail,
      observedMessages: observed.size,
    };
  }
  function stop() {
    if (!active) return savedQueue;
    var pendingSave = flush();
    cancelSave();
    active = false;
    epoch++;
    if (retryTimer !== null) g.clearInterval(retryTimer);
    if (appStateCleanup)
      try {
        appStateCleanup();
      } catch (ignore) {}
    appStateCleanup = null;
    if (detach)
      try {
        detach();
      } catch (ignore) {}
    if (bridgeDetach) {
      bridgeDetach();
      bridgeDetach = null;
    }
    if (actionDetach) {
      actionDetach();
      actionDetach = null;
    }
    undo.reverse().forEach(function (fn) {
      try {
        fn();
      } catch (ignore) {}
    });
    if (typeof unregister === "function") unregister();
    logs = {};
    observed.clear();
    observedBytes = 0;
    account = null;
    records.clear();
    projections = new WeakMap();
    listeners = [];
    detach = null;
    repaint();
    return pendingSave;
  }
  function retry() {
    var attached = attach();
    flush();
    return attached;
  }
  function open() {
    if (!active) throw new Error("Restart Discord to reload Message Logger");
    attach();
    var R = dc.React,
      N = dc.Native;
    if (!R || !N) throw new Error("Discord UI is not ready");
    function Screen() {
      var e = R.createElement,
        refresh = R.useState(0),
        search = R.useState(""),
        filter = R.useState("all"),
        limit = R.useState(30),
        confirmation = R.useState(false),
        notice = R.useState(""),
        archivePage = R.useState(null),
        paging = R.useState(false),
        colors = dc.ui.colors ? dc.ui.colors() : (dc.config && dc.config.theme) || {},
        ink = colors.text || "#f2f3f5",
        muted = colors.textMuted || colors.text4 || "#a5a7af",
        accent = colors.accent || "#c4b5fd",
        state = status();
      R.useEffect(function () {
        var listener = function () {
          refresh[1](function (n) {
            return n + 1;
          });
        };
        listeners.push(listener);
        return function () {
          listeners = listeners.filter(function (fn) {
            return fn !== listener;
          });
        };
      }, []);
      function label(value, color, size) {
        return e(
          N.Text,
          { selectable: true, style: { color: color || ink, fontSize: size || 15 } },
          value,
        );
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
            disabled: !!disabled,
            onPress: callback,
            style: { padding: 16, opacity: disabled ? 0.45 : 1 },
          },
          label(title, accent),
        );
      }
      function run(work) {
        return Promise.resolve()
          .then(work)
          .catch(function (failure) {
            notice[1](String(failure.message || "Operation failed"));
          });
      }
      function mode(value, title, description) {
        var selected = (!state.restoring || state.persistent) && state.persistent === value,
          disabled = state.loading || state.restoring || state.busy || (value && !state.storage);
        if (dc.ui.Row)
          return e(dc.ui.Row, {
            type: "radio",
            title: title,
            description: description,
            selected: selected,
            disabled: disabled,
            onPress: function () {
              return run(function () {
                return setPersistent(value).then(function () {
                  archivePage[1](null);
                });
              });
            },
          });
        return e(
          N.Pressable,
          {
            accessibilityRole: "radio",
            accessibilityLabel: title,
            accessibilityState: {
              checked: selected,
              disabled: disabled,
            },
            disabled: disabled,
            onPress: function () {
              return run(function () {
                return setPersistent(value).then(function () {
                  archivePage[1](null);
                });
              });
            },
            style: {
              padding: 16,
              flexDirection: "row",
              alignItems: "center",
              borderBottomWidth: 1,
              borderBottomColor: colors.divider || "#3a304e",
            },
          },
          e(
            N.View,
            { style: { flex: 1, paddingRight: 16, opacity: disabled ? 0.5 : 1 } },
            label(title, ink, 16),
            e(
              N.Text,
              { style: { color: muted, fontSize: 14, lineHeight: 20, marginTop: 4 } },
              description,
            ),
          ),
          dc.ui.Radio
            ? e(dc.ui.Radio, { selected: selected, disabled: disabled })
            : e(
                N.View,
                {
                  accessible: false,
                  style: {
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: selected ? accent : muted,
                    backgroundColor: selected ? accent : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: disabled ? 0.5 : 1,
                  },
                },
                selected
                  ? e(N.View, {
                      style: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#ffffff" },
                    })
                  : null,
              ),
        );
      }
      var older =
        archivePage[0] && archivePage[0].account === state.account && state.persistent
          ? archivePage[0]
          : null;
      var items = (older ? older.entries : entries()).filter(function (entry) {
        if (
          (filter[0] === "deleted" && !entry.deleted) ||
          (filter[0] === "edited" && !entry.edits.length)
        )
          return false;
        return (
          !search[0] ||
          (
            body(entry.message) +
            " " +
            entry.message.author.username +
            " " +
            entry.message.channel_id +
            " " +
            entry.edits
              .map(function (edit) {
                return body(edit.message);
              })
              .join(" ")
          )
            .toLowerCase()
            .indexOf(search[0].toLowerCase()) >= 0
        );
      });
      var insets = dc.ui.safeInsets ? dc.ui.safeInsets() : { top: 24, bottom: 24 };
      return e(
        dc.ui.Page || N.View,
        {
          testID: "nitracord-message-logger-page",
          title: "Message Logger",
          scroll: false,
          style: {
            flex: 1,
            backgroundColor: colors.background || "#121214",
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        },
        dc.ui.Page
          ? null
          : dc.ui.Header
            ? e(dc.ui.Header, { title: "Message Logger" })
            : e(
                N.View,
                { style: { height: 56, flexDirection: "row", alignItems: "center" } },
                action("‹ Back", dc.ui.close),
                label("Message Logger", ink, 18),
              ),
        e(
          N.ScrollView,
          { contentContainerStyle: { padding: 16 } },
          e(
            dc.ui.Section || N.View,
            {
              title: "History storage",
              style: {
                backgroundColor: colors.surface || "#242429",
                borderRadius: 16,
                overflow: "hidden",
              },
            },
            mode(
              false,
              "Remove on close",
              "History stays in memory until Discord's process closes. Switching apps keeps this session.",
            ),
            mode(
              true,
              "Persistent",
              "Keep history on this device across restarts. Switching to Remove on close erases the saved copy.",
            ),
            action("Refresh / retry hooks", retry),
            action(
              "Clear history",
              function () {
                confirmation[1](true);
              },
              state.busy || state.loading,
            ),
          ),
          confirmation[0]
            ? e(
                N.View,
                { style: { padding: 16 } },
                label("Delete all logged history for this account?"),
                action("Cancel", function () {
                  confirmation[1](false);
                }),
                action(
                  "Delete history",
                  function () {
                    return run(async function () {
                      await clear();
                      archivePage[1](null);
                      confirmation[1](false);
                    });
                  },
                  state.busy,
                ),
              )
            : null,
          e(
            N.View,
            { style: { paddingVertical: 16 } },
            label(
              state.loading
                ? "Loading saved history…"
                : older
                  ? "Saved history page"
                  : state.count + " recent messages loaded",
              muted,
              13,
            ),
            label(
              !state.account
                ? "Waiting for the active Discord user store · open a chat and retry"
                : state.hook
                  ? state.inline
                    ? state.cache === "ready"
                      ? "Live chat cache verified · logging and inline colors ready"
                      : state.cache === "unavailable"
                        ? "Live chat cache unavailable · open a chat and retry"
                        : "Hooks ready · open a chat with loaded messages to verify capture"
                    : "Logging active · inline chat hook unavailable"
                  : "Message hook unavailable · open a chat and retry",
              muted,
              13,
            ),
            label(
              state.persistent
                ? "No saved-message limit; available device storage is the limit. Keeps 20 earlier edits per message. Search applies to the loaded page."
                : "Session history keeps up to 10,000 messages and 20 earlier edits per message. Choose Persistent to save unlimited messages across restarts.",
              muted,
              12,
            ),
            label(
              "Changes received: " + state.captureEvents + " · Not in cache: " + state.cacheMisses,
              muted,
              12,
            ),
            label(
              "Chat updates: " +
                state.renderCalls +
                " · Messages highlighted: " +
                state.decoratedRows,
              muted,
              12,
            ),
            state.cacheDetail ? label(state.cacheDetail, muted, 11) : null,
            label("Messages cached this session: " + state.observedMessages, muted, 11),
            label(
              bridgeMode
                ? "Nitracord message bridge API 1"
                : "Legacy hooks · update Nitracord to use the message bridge",
              muted,
              11,
            ),
            state.storageDetail ? label("Storage: " + state.storageDetail, muted, 11) : null,
            state.error || notice[0] ? label(state.error || notice[0], "#ff6b7a", 13) : null,
          ),
          e(N.TextInput, {
            value: search[0],
            onChangeText: function (value) {
              search[1](value);
              limit[1](30);
            },
            placeholder: "Search text, username or channel ID",
            placeholderTextColor: muted,
            accessibilityLabel: "Search message history",
            style: {
              color: ink,
              backgroundColor: colors.input || colors.surface || "#242429",
              borderRadius: 12,
              padding: 12,
            },
          }),
          e(
            N.View,
            { style: { flexDirection: "row" } },
            ["all", "deleted", "edited"].map(function (value) {
              return e(
                N.Pressable,
                {
                  key: value,
                  accessibilityRole: "radio",
                  accessibilityState: { checked: filter[0] === value },
                  onPress: function () {
                    filter[1](value);
                    limit[1](30);
                  },
                  style: { padding: 12 },
                },
                label(value, filter[0] === value ? accent : muted),
              );
            }),
          ),
          !items.length ? label("No matching deleted or edited messages yet.", muted) : null,
          items.slice(0, limit[0]).map(function (entry) {
            return e(
              N.View,
              {
                key: key(entry.message.channel_id, entry.message.id),
                style: {
                  padding: 16,
                  marginBottom: 12,
                  borderRadius: 12,
                  backgroundColor: colors.surface || "#242429",
                },
              },
              label(
                (entry.deleted ? "Deleted" : "Edited") +
                  " · " +
                  (entry.message.author.global_name ||
                    entry.message.author.username ||
                    entry.message.author.id),
                entry.deleted ? "#ff6b7a" : ink,
              ),
              label(
                "Channel " + entry.message.channel_id + " · " + displayTime(entry.changedAt),
                muted,
                12,
              ),
              entry.edits.map(function (edit, index) {
                return e(
                  N.View,
                  { key: String(index), style: { marginTop: 8 } },
                  label("Earlier edit · " + displayTime(edit.at), "#a5a7af", 12),
                  label(body(edit.message), "#a5a7af"),
                );
              }),
              e(
                N.View,
                { style: { marginTop: 8 } },
                label(body(entry.message), entry.deleted ? "#ff6b7a" : ink),
              ),
            );
          }),
          items.length > limit[0]
            ? action("Show more", function () {
                limit[1](limit[0] + 30);
              })
            : null,
          older
            ? action("Back to recent messages", function () {
                archivePage[1](null);
                limit[1](30);
              })
            : null,
          state.persistent && (older ? older.cursor !== null : state.hasOlder)
            ? action(
                paging[0] ? "Loading older history…" : "Older saved messages",
                function () {
                  paging[1](true);
                  return run(async function () {
                    try {
                      archivePage[1](
                        await historyPage(
                          older ? older.cursor : undefined,
                          older ? older.seen : [],
                        ),
                      );
                      limit[1](30);
                    } finally {
                      paging[1](false);
                    }
                  });
                },
                paging[0] || state.busy || state.loading || state.restoring,
              )
            : null,
        ),
      );
    }
    dc.ui.present(R.createElement(Screen));
  }
  dc.messageLogger = {
    version: "0.0.1",
    status: status,
    entries: function () {
      ensureAccount();
      return clone(entries());
    },
    setPersistent: setPersistent,
    historyPage: historyPage,
    clear: clear,
    forceDelete: forceDelete,
    flush: flush,
    retry: retry,
    whenReady: function () {
      ensureAccount();
      return ready;
    },
    stop: stop,
  };
  unregister = dc.registerTool({
    id: "message-logger",
    title: "Message Logger",
    author: "Nitracord",
    version: "0.0.1",
    website: "https://github.com/Nitracord/nitracord-plugins",
    open: open,
  });
  attach();
  if (typeof g.setInterval === "function")
    retryTimer = g.setInterval(function () {
      attempts++;
      if (attach() || attempts >= 120) {
        g.clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 500);
})(globalThis);
