import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync("src/message-logger.js", "utf8"),
  USER = "111111111111111111",
  OTHER = "222222222222222222",
  CHANNEL = "333333333333333333",
  ID = "444444444444444444",
  ID2 = "444444444444444445",
  ID3 = "444444444444444446",
  PREFIX = "nitracord.plugin.message-logger.v1.";
const copy = (value) => JSON.parse(JSON.stringify(value));
function message(id = ID, content = "Original text") {
  return {
    id,
    channel_id: CHANNEL,
    author: { id: OTHER, username: "example" },
    content,
    timestamp: "2026-10-22T21:00:00.000Z",
    attachments: [],
    mentions: [],
  };
}

function archivedEntries(disk, owner = USER) {
  const base = PREFIX + owner + ".archive",
    head = disk.get(base),
    result = new Map();
  let cursor = head ? JSON.parse(head).cursor : null;
  const visited = new Set();
  while (cursor) {
    assert(!visited.has(cursor), "History index has no cycles");
    visited.add(cursor);
    const page = JSON.parse(disk.get(base + "." + cursor));
    let data = "";
    for (let i = 0; i < page.parts; i++) data += disk.get(base + "." + cursor + "." + i);
    for (const entry of JSON.parse(data).entries) {
      const key = entry.message.channel_id + ":" + entry.message.id;
      if (!result.has(key) || result.get(key).changedAt < entry.changedAt) result.set(key, entry);
    }
    cursor = page.previous;
  }
  return [...result.values()].filter((entry) => !entry.removed);
}

function setup({
  disk = new Map(),
  late = false,
  unavailableStorage = false,
  fail = null,
  delayedRead = null,
  storageOperation = null,
  leadingUsers = [],
  leadingMessages = [],
  leadingDispatchers = [],
  leadingChats = [],
  readonlyProjection = false,
  userAvailable = true,
  bridgeMode = false,
  initialUser = USER,
} = {}) {
  let user = initialUser,
    available = !late,
    rendered,
    tool,
    interval,
    nextTimer = 0;
  const timers = new Map(),
    writes = [],
    delivered = [],
    calls = [],
    caches = new Map(),
    lifecycle = new Set();
  function makeUserStore() {
    return {
      getCurrentUser: () => (user ? { id: user } : null),
      getUser: (id) => ({ id }),
      getUsers: () => ({}),
    };
  }
  let userStore = makeUserStore();
  class Cache {
    constructor(array = [], present = true) {
      this._array = array;
      this.present = present;
      this.hasMoreBefore = false;
    }
    toArray() {
      return this._array;
    }
    has(id) {
      return this._array.some((item) => item.id === id);
    }
    hasPresent() {
      return this.present;
    }
    merge(items) {
      return new Cache(
        this._array.concat(items.filter((item) => !this.has(item.id))),
        this.present,
      );
    }
  }
  const store = {
      getMessage(channel, id) {
        return (caches.get(channel)?.toArray() || []).find((item) => item.id === id);
      },
      getMessages(channel) {
        return caches.get(channel) || new Cache([], false);
      },
      getLastEditableMessage(channel) {
        return this.getMessages(channel)
          .toArray()
          .slice()
          .reverse()
          .find((m) => m.author.id === user);
      },
      hasPresent(channel) {
        return caches.get(channel)?.hasPresent() || false;
      },
      emitChange() {},
    },
    originalGetMessages = store.getMessages;
  const dispatcher = {
    _interceptors: [],
    addInterceptor(fn) {
      this._interceptors.push(fn);
    },
    dispatch(event) {
      if (this._interceptors.some((fn) => fn(event))) return;
      delivered.push(event);
      if (event.type === "LOGOUT") {
        user = null;
        caches.clear();
      }
      if (event.type === "MESSAGE_UPDATE") {
        const old = store.getMessage(event.message.channel_id, event.message.id);
        if (old) Object.assign(old, event.message);
      }
      if (event.type === "MESSAGE_DELETE" || event.type === "MESSAGE_DELETE_BULK") {
        const ids = event.ids || [event.id],
          cache = caches.get(event.channelId);
        if (cache)
          caches.set(
            event.channelId,
            new Cache(cache.toArray().filter((item) => !ids.includes(item.id))),
          );
      }
    },
  };
  store._dispatcher = dispatcher;
  if (readonlyProjection) Object.defineProperty(store, "getMessages", { writable: false });
  const storage = {
    async getItem(key) {
      if (storageOperation) await storageOperation("read", key);
      if (fail === "read") throw Error("Read failed");
      return delayedRead ? delayedRead(key, disk) : disk.get(key) || null;
    },
    async setItem(key, value) {
      if (storageOperation) await storageOperation("write", key, value);
      if (fail === "write") throw Error("Disk full");
      assert(
        Buffer.byteLength(value, "utf8") <= 1024 * 1024,
        "A storage value stays within the bridge limit",
      );
      encodeURIComponent(value); // Chunks cannot split a Unicode surrogate pair.
      writes.push([key, value]);
      disk.set(key, value);
    },
    async removeItem(key) {
      if (storageOperation) await storageOperation("remove", key);
      if (fail === "remove") throw Error("Erase failed");
      writes.push([key, null]);
      disk.delete(key);
    },
    multiRemove() {},
    mergeItem() {},
  };
  const chat = {
      updateRows(...args) {
        calls.push({ owner: this, args });
        return 17;
      },
      clearRows() {},
      scrollToBottom() {},
    },
    originalUpdateRows = chat.updateRows;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(value) {
      return [value, () => {}];
    },
    useEffect() {},
  };
  const dc = {
    config: { theme: {} },
    React,
    Native: {
      View: "View",
      Text: "Text",
      TextInput: "TextInput",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      AppState: {
        addEventListener(event, fn) {
          assert.equal(event, "change");
          lifecycle.add(fn);
          return {
            remove() {
              lifecycle.delete(fn);
            },
          };
        },
      },
    },
    ui: {
      close() {},
      safeInsets: () => ({ top: 30, bottom: 24 }),
      present(value) {
        rendered = value;
      },
    },
    findModule(predicate) {
      const modules = [
        ...leadingUsers,
        ...(userAvailable ? [userStore] : []),
        { getChannelId: () => CHANNEL },
        ...leadingMessages,
        ...leadingDispatchers,
        ...leadingChats,
        ...(available
          ? [store, dispatcher, chat, { createMessageRecord: (raw) => copy(raw) }]
          : []),
        ...(unavailableStorage ? [] : [storage]),
      ];
      return (
        modules.find((module) => {
          try {
            return predicate(module);
          } catch {
            return false;
          }
        }) || null
      );
    },
    registerTool(value) {
      tool = value;
      return () => {
        tool = null;
      };
    },
  };
  if (bridgeMode) {
    dc.messages = {
      apiVersion: 1,
      currentUser: () => user,
      subscribe: () => () => {},
      render: () => () => {},
      createRecord: copy,
      repaint() {},
      status: () => ({ stores: 1, cacheHits: 0 }),
    };
    dc.storage = { apiVersion: 1, scope: () => storage };
  }
  const context = vm.createContext({
    Nitracord: dc,
    console,
    setTimeout(fn) {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn) {
      interval = fn;
      return 1;
    },
    clearInterval() {
      interval = null;
    },
  });
  vm.runInContext(source, context);
  return {
    dc,
    disk,
    store,
    dispatcher,
    chat,
    calls,
    delivered,
    writes,
    caches,
    Cache,
    context,
    ready: () => dc.messageLogger.whenReady(),
    get api() {
      return dc.messageLogger;
    },
    get rendered() {
      return rendered;
    },
    get tool() {
      return tool;
    },
    setUser(value) {
      user = value;
    },
    setUserAvailable(value) {
      userAvailable = value;
    },
    replaceUserStore() {
      userStore.getCurrentUser = () => null;
      userStore = makeUserStore();
    },
    setFail(value) {
      fail = value;
    },
    late() {
      available = true;
      interval?.();
    },
    lifecycle,
    background() {
      lifecycle.forEach((fn) => fn("background"));
    },
    originalGetMessages,
    originalUpdateRows,
  };
}
{
  let searchLookups = 0;
  // SearchMessageStore exposes these same three methods, but getMessage takes
  // only a message ID and its messages are unrelated to the open chat cache.
  const searchStore = {
    getMessage() {
      searchLookups++;
      return undefined;
    },
    getMessages() {
      return [];
    },
    emitChange() {},
  };
  const originalSearchGetter = searchStore.getMessages;
  const r = setup({ leadingMessages: [searchStore] });
  await r.ready();
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, content: "Edited in chat" },
  });
  assert.equal(
    r.api.entries().length,
    1,
    "A search store loaded before MessageStore must not mask live chat edits",
  );
  assert.equal(
    r.api.status().cache,
    "ready",
    "Verify a real loaded message, not only the existence of hook methods",
  );
  assert.equal(r.api.entries()[0].edits[0].message.content, "Original text");
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(r.api.entries()[0].deleted, true);
  assert.equal(r.api.entries()[0].message.content, "Edited in chat");
  assert.match(
    r.store.getMessages(CHANNEL).toArray()[0].content,
    /^-# Deleted · .+\d{1,2}:\d{2}.*\nEdited in chat$/,
  );
  assert.equal(searchLookups, 0);
  assert.equal(searchStore.getMessages, originalSearchGetter, "Search results are never patched");
  r.api.stop();
  console.log(
    "PASS: SearchMessageStore cannot mask the live MessageStore; edits, deletes and inline restoration use the open chat cache",
  );
}
{
  const decoy = {
    _interceptors: [],
    dispatch() {},
    addInterceptor(fn) {
      this._interceptors.push(fn);
    },
  };
  const r = setup({ leadingDispatchers: [decoy] });
  await r.ready();
  assert.equal(r.api.status().storeDispatcher, true);
  assert.equal(
    decoy._interceptors.length,
    0,
    "Never subscribe to an unrelated dispatcher with the same methods",
  );
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, content: "Native bridge text" },
  });
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(r.api.entries()[0].deleted, true);
  assert.equal(r.api.status().captureEvents, 2);
  assert.equal(r.api.status().cacheMisses, 0);
  const rows = [
    {
      type: "change",
      rowData: {
        message: {
          id: ID,
          channelId: CHANNEL,
          content: [
            { type: "paragraph", content: [{ type: "text", content: "Native bridge text" }] },
          ],
        },
      },
    },
  ];
  const encoded = JSON.stringify(rows);
  const remainingArgs = [false, null, 8, false, true, true];
  r.chat.updateRows(42, encoded, ...remainingArgs);
  const forwarded = r.calls.at(-1).args;
  assert.equal(typeof forwarded[1], "string", "Android must still receive JSON text");
  assert.deepEqual(forwarded.slice(2), remainingArgs);
  const native = JSON.parse(forwarded[1])[0].rowData.message;
  assert.equal(native.textColor, 0xffff6b7a | 0);
  assert.equal(native.content[0].content[1].linkColor, 0xffa5a7af | 0);
  assert.match(native.content[0].content[1].content[0].content, /Original text/);
  assert.equal(r.api.status().decoratedRows, 1);
  assert.equal(JSON.stringify(rows), encoded, "Original rows are untouched");
  for (const untouched of ["not JSON", "[]", '{"unrelated":true}', JSON.stringify([{ id: ID2 }])]) {
    r.chat.updateRows(42, untouched, ...remainingArgs);
    assert.equal(r.calls.at(-1).args[1], untouched);
  }
  r.api.stop();
  console.log(
    "PASS: binds to MessageStore's own dispatcher and decorates Android JSON row operations without changing native call arguments",
  );
}
{
  const frozenBridge = Object.freeze({ updateRows() {}, clearRows() {}, scrollToBottom() {} });
  const r = setup({ readonlyProjection: true, leadingChats: [frozenBridge] });
  await r.ready();
  assert.equal(r.api.status().hook, true);
  assert.equal(r.api.status().projection, false);
  assert.equal(
    r.api.status().inline,
    true,
    "Skip an unpatchable native bridge and find writable chat utilities",
  );
  const raw = message();
  const author = {};
  Object.defineProperties(author, {
    id: { get: () => OTHER },
    username: { get: () => "Native author" },
  });
  raw.author = author;
  r.caches.set(CHANNEL, new r.Cache([raw]));
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, content: "Edit with cached author" },
  });
  assert.equal(r.api.entries()[0].message.author.id, OTHER);
  assert.equal(r.api.entries()[0].message.author.username, "Native author");
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(
    r.api.entries()[0].deleted,
    true,
    "A read-only display method cannot disable message capture",
  );
  r.api.stop();
  console.log(
    "PASS: capture survives read-only display methods, native bridge discovery skips frozen exports, and author getters are read directly",
  );
}
{
  const r = setup();
  await r.ready();
  const own = message();
  own.author.id = USER;
  r.caches.set(CHANNEL, new r.Cache([own]));
  assert.equal(r.store.getLastEditableMessage(CHANNEL).id, ID);
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(r.store.getMessages(CHANNEL).toArray()[0].id, ID);
  assert.equal(
    r.store.getLastEditableMessage(CHANNEL),
    undefined,
    "Retained deletions must not become editable through Discord's last-message shortcut",
  );
  r.api.stop();
  console.log(
    "PASS: deleted-message display does not change the edit-last-message shortcut's live cache",
  );
}
{
  const unusedChat = { updateRows() {}, clearRows() {}, scrollToBottom() {} };
  const r = setup({ leadingChats: [unusedChat] });
  await r.ready();
  const incoming = message();
  delete incoming.channel_id;
  r.dispatcher.dispatch({
    type: "LOAD_MESSAGES_SUCCESS",
    channelId: CHANNEL,
    messages: [incoming],
  });
  assert.equal(r.api.entries().length, 0, "Ordinary incoming messages are not logged or persisted");
  assert.equal(r.api.status().observedMessages, 1);
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, content: "Edited from events" },
  });
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(r.api.entries()[0].edits[0].message.content, "Original text");
  assert.equal(r.api.entries()[0].deleted, true);
  assert.equal(
    r.api.status().cacheMisses,
    0,
    "Incoming snapshots support clients with an unavailable cache lookup",
  );
  const rows = [
    {
      message: {
        id: ID,
        channelId: CHANNEL,
        content: [{ type: "text", content: "Edited from events" }],
      },
    },
  ];
  r.chat.updateRows(42, JSON.stringify(rows));
  assert.equal(JSON.parse(r.calls.at(-1).args[1])[0].message.textColor, 0xffff6b7a | 0);
  assert(
    r.api.status().renderCalls > 0,
    "An unused chat export cannot hide the active native bridge",
  );
  await r.api.flush();
  assert(
    !r.writes.some(([key, value]) => (key.endsWith(".logs") || key.includes(".archive")) && value),
  );
  r.setUser(OTHER);
  await r.ready();
  assert.equal(r.api.status().observedMessages, 0, "Incoming snapshots are isolated by account");
  r.api.stop();
  console.log(
    "PASS: loaded-message event snapshots capture edits/deletes with an empty store; all chat bridges are considered; ordinary messages remain memory-only and account-isolated",
  );
}
{
  const disk = new Map([
    [PREFIX + USER + ".settings", { persistent: true }],
    [
      PREFIX + USER + ".logs",
      {
        format: 1,
        entries: [{ message: message(), edits: [], deleted: true, changedAt: Date.now() }],
      },
    ],
  ]);
  const r = setup({ disk });
  await r.ready();
  assert.equal(r.api.status().persistent, true);
  assert.equal(r.api.entries()[0].deleted, true);
  assert.equal(r.api.status().error, "");
  r.api.stop();
  console.log(
    "PASS: storage adapters that return decoded settings/history objects restore without JSON parsing errors",
  );
}
{
  let actionCalls = 0;
  const r = setup({
    leadingUsers: [
      { getCurrentUser: () => null },
      {
        getCurrentUser() {
          actionCalls++;
          return Promise.reject(Error("Account API must not be called"));
        },
      },
      {
        getCurrentUser() {
          throw Error("Unavailable cache");
        },
        getUser() {},
        getUsers() {},
      },
      { getCurrentUser: () => null, getUser() {}, getUsers() {} },
    ],
  });
  await r.ready();
  assert.equal(
    r.api.status().account,
    USER,
    "Select the real signed-in cache after null stubs and unrelated actions",
  );
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(r.api.entries().length, 1);
  await r.api.flush();
  assert(r.disk.has(PREFIX + USER + ".archive"));
  assert.equal(actionCalls, 0, "Discovery never invokes unrelated account API actions");
  r.replaceUserStore();
  assert.equal(
    r.api.status().account,
    USER,
    "Recover when the previously resolved cache becomes unavailable",
  );
  assert.equal(r.api.entries().length, 1);
  r.api.stop();
  console.log(
    "PASS: null/throwing user stubs cannot mask the signed-in store; persistent mode and deletion capture work without calling account APIs",
  );
}
{
  const r = setup({ userAvailable: false });
  await r.ready();
  assert.equal(r.api.status().account, null);
  assert.equal(
    r.api.status().hook,
    true,
    "Message interception attaches before login discovery finishes",
  );
  await assert.rejects(r.api.setPersistent(true), /active Discord user store/);
  r.setUserAvailable(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(r.api.status().account, USER);
  assert.equal(
    r.api.entries().length,
    1,
    "An event resolves a late user store without a restart or manual refresh",
  );
  await r.ready();
  await r.api.setPersistent(true);
  r.api.stop();
  console.log(
    "PASS: late user-store discovery recovers automatically for both message capture and persistent settings",
  );
}
{
  const r = setup();
  await r.ready();
  assert(r.api.status().hook && r.api.status().inline);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: {
      id: ID,
      channel_id: CHANNEL,
      content: "New text",
      edited_timestamp: "2026-10-22T21:01:00Z",
    },
  });
  assert.equal(r.api.entries()[0].edits[0].message.content, "Original text");
  assert.equal(r.api.entries()[0].message.content, "New text");
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, content: "New text" },
  });
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, embeds: [{ title: "Changed embed" }] },
  });
  assert.equal(r.api.entries()[0].edits.length, 1);
  const native = Object.freeze({
    id: ID,
    channelId: CHANNEL,
    textColor: -1,
    content: Object.freeze([{ type: "text", content: "New text" }]),
  });
  const payload = Object.freeze({
    rows: Object.freeze([{ type: 1, item: Object.freeze({ type: 0, message: native }) }]),
    scrollData: "unchanged",
  });
  assert.equal(r.chat.updateRows.call(r.chat, 42, payload, "extra"), 17);
  const changed = r.calls.at(-1).args[1].rows[0].item.message;
  assert.equal(changed.content[0].content[1].linkColor, 0xffa5a7af | 0);
  assert.equal(
    changed.content[0].content[1].target.type,
    "com.discord.chat.bridge.contentnode.LinkContextData.BindDoNothing",
  );
  assert.equal(changed.content[0].content[2], native.content[0]);
  assert.equal(
    changed.content[0].content[0].type,
    "subtext",
    "Earlier edit label uses native small muted text",
  );
  const editLabel = JSON.stringify(changed.content[0].content[0]);
  assert.match(editLabel, /2026/);
  assert.match(editLabel, /\d{1,2}:\d{2}/);
  assert(
    !editLabel.includes("2026-10-22T21:01:00"),
    "Edit labels use local date/time instead of raw ISO",
  );
  assert.equal(
    changed.content.length,
    1,
    "History and current text share one paragraph without a blank gap",
  );
  assert.equal(native.content.length, 1);
  assert.equal(r.calls.at(-1).owner, r.chat);
  assert.equal(r.calls.at(-1).args[2], "extra");
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  assert.equal(
    r.store.getMessage(CHANNEL, ID),
    undefined,
    "Original Discord store processes deletion",
  );
  const base = r.caches.get(CHANNEL),
    visible = r.store.getMessages(CHANNEL);
  assert.equal(base.toArray().length, 0, "Logger does not mutate the real cache");
  assert.match(
    visible.toArray()[0].content,
    /^-# Deleted · .+\d{1,2}:\d{2}.*\nNew text$/,
    "Last/only deleted message remains in chat",
  );
  assert.equal(r.store.getMessages(CHANNEL), visible, "Projection is stable");
  r.chat.updateRows(42, payload);
  const deleted = r.calls.at(-1).args[1].rows[0].item.message;
  assert.equal(deleted.textColor, 0xffff6b7a | 0);
  assert.equal(deleted.linkColor, deleted.textColor);
  assert.equal(
    deleted.content[0].content[1].linkColor,
    0xffa5a7af | 0,
    "Earlier edits remain gray after deletion",
  );
  assert.equal(deleted.content[0].content[2].type, "subtext");
  assert.match(deleted.content[0].content[2].content[0].content, /^Deleted · .+\d{1,2}:\d{2}/);
  assert.equal(
    deleted.content[0].content[3].linkColor,
    0xffff6b7a | 0,
    "Deleted body uses explicit native span color even when Message.textColor is ignored",
  );
  assert.equal(
    deleted.content[0].content[3].content[0],
    native.content[0],
    "Original text node is preserved",
  );
  assert.equal(r.delivered.length, 4, "No incoming events are blocked");
  assert.equal(
    deleted.isCurrentUserMessageAuthor,
    false,
    "Native own-message edit actions are disabled",
  );
  r.dispatcher.dispatch({ type: "MESSAGE_START_EDIT", channelId: CHANNEL, messageId: ID });
  assert.equal(r.delivered.length, 4, "Retained deleted messages cannot enter the editor");
  r.dispatcher.dispatch({ type: "MESSAGE_START_EDIT", channelId: CHANNEL, messageId: ID2 });
  assert.equal(r.delivered.length, 5, "Normal message editing is preserved");
  await r.api.flush();
  assert(
    !r.writes.some(([key, value]) => (key.endsWith(".logs") || key.includes(".archive")) && value),
    "Session history never reaches disk",
  );
  const publicEntries = r.api.entries();
  publicEntries[0].message.content = "Tampered";
  assert.equal(r.api.entries()[0].message.content, "New text");
  r.tool.open();
  const page = r.rendered.type();
  assert.equal(page.props.testID, "nitracord-message-logger-page");
  assert.equal(page.props.style.paddingTop, 30);
  function nodes(tree) {
    return tree && typeof tree === "object"
      ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)]
      : [];
  }
  const storageChoices = (tree) =>
    nodes(tree).filter(
      (node) =>
        node.props?.accessibilityRole === "radio" &&
        ["Remove on close", "Persistent"].includes(node.props.accessibilityLabel),
    );
  const choices = storageChoices(page);
  assert.equal(choices.length, 2);
  assert.equal(choices[0].props.accessibilityLabel, "Remove on close");
  assert.equal(choices[0].props.accessibilityState.checked, true);
  assert.equal(choices[1].props.accessibilityState.checked, false);
  assert.equal(choices[0].children[1].props.accessible, false);
  assert.equal(choices[0].children[1].props.style.width, 24);
  const ui = r.context.Nitracord.ui;
  ui.Radio = function SharedRadio() {};
  ui.Header = function SharedHeader() {};
  const integratedPage = r.rendered.type();
  assert.equal(integratedPage.children[0].type, ui.Header);
  assert.equal(integratedPage.children[0].props.title, "Message Logger");
  const integratedChoices = storageChoices(integratedPage);
  assert.equal(integratedChoices[0].children[1].type, ui.Radio);
  assert.equal(integratedChoices[0].children[1].props.selected, true);
  await integratedChoices[1].props.onPress();
  assert.equal(r.api.status().persistent, true);
  await r.api.setPersistent(false);
  ui.Page = function Page() {};
  ui.Section = function Section() {};
  ui.Row = function Row() {};
  ui.colors = () => ({ background: "#101725", surface: "#202735", text: "#eeeeff" });
  const builderPage = r.rendered.type();
  assert.equal(builderPage.type, ui.Page);
  assert.equal(builderPage.props.title, "Message Logger");
  assert.equal(builderPage.props.style.backgroundColor, "#101725");
  const persistentRow = nodes(builderPage).find(
    (node) => node.type === ui.Row && node.props.title === "Persistent",
  );
  assert.equal(persistentRow.props.type, "radio");
  await persistentRow.props.onPress();
  assert.equal(r.api.status().persistent, true);
  await r.api.setPersistent(false);
  r.api.stop();
  assert.equal(r.dispatcher._interceptors.length, 0);
  assert.equal(r.lifecycle.size, 0);
  assert.equal(r.store.getMessages, r.originalGetMessages);
  assert.equal(r.chat.updateRows, r.originalUpdateRows);
  const fresh = setup({ disk: r.disk });
  await fresh.ready();
  assert.equal(fresh.api.entries().length, 0);
  console.log(
    "PASS: pre-edit capture, duplicate/embed update filtering, red native deleted text, gray native history above current content, last-message retention, unchanged real cache/events and memory-only restart",
  );
}
{
  const r = setup();
  await r.ready();
  r.caches.set(
    CHANNEL,
    new r.Cache([message(ID), message(ID2, "Second"), message(ID3, "Still present")]),
  );
  const event = { type: "MESSAGE_DELETE_BULK", ids: [ID, ID2], channelId: CHANNEL };
  r.dispatcher.dispatch(event);
  assert.equal(event.ids.length, 2);
  assert.equal(r.api.entries().length, 2);
  assert.deepEqual(
    Array.from(r.store.getMessages(CHANNEL).toArray(), (m) => m.id),
    [ID, ID2, ID3],
  );
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: "555555555555555555", channelId: CHANNEL });
  assert.equal(r.api.entries().length, 2);
  r.caches.set(CHANNEL, new r.Cache([message(ID3)]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID3, channelId: CHANNEL, local: true });
  assert.equal(r.api.entries().length, 2, "Local failed/pending message cleanup is not logged");
  r.caches.set(CHANNEL, new r.Cache([message("444444444444444447")], false));
  r.caches.get(CHANNEL).hasMoreBefore = true;
  assert.equal(
    r.store.getMessages(CHANNEL).toArray().length,
    1,
    "Older logs do not expand an unloaded history page",
  );
  r.api.stop();
  console.log(
    "PASS: bulk deletes, chronological restoration, unknown/local deletion exclusion and history-window boundaries",
  );
}
{
  const r = setup();
  await r.ready();
  const original = message();
  r.caches.set(CHANNEL, new r.Cache([original]));
  let lastContent,
    paints = 0;
  function renderIfContentChanged() {
    const shown = r.store.getMessages(CHANNEL).toArray()[0];
    if (shown && shown.content !== lastContent) {
      lastContent = shown.content;
      paints++;
      const newline = shown.content.indexOf("\n");
      const content = shown.content.startsWith("-# Deleted · ")
        ? [
            {
              type: "subtext",
              content: [{ type: "text", content: shown.content.slice(3, newline) }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", content: shown.content.slice(newline + 1) }],
            },
          ]
        : [{ type: "text", content: shown.content }];
      r.chat.updateRows(42, { rows: [{ message: { id: shown.id, channelId: CHANNEL, content } }] });
    }
  }
  renderIfContentChanged();
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  renderIfContentChanged();
  assert.equal(paints, 2, "Deletion invalidates a content-memoized row without changing chats");
  const painted = r.calls.at(-1).args[1].rows[0].message;
  assert.equal(painted.content.length, 1, "The deletion label is not duplicated");
  assert.equal(painted.content[0].content[0].type, "subtext");
  assert.equal(painted.content[0].content[1].linkColor, 0xffff6b7a | 0);
  assert.equal(painted.content[0].content[1].content[0].content, "Original text");
  assert.equal(original.content, "Original text");
  assert.equal(
    r.api.entries()[0].message.content,
    "Original text",
    "Only the display copy is changed",
  );
  r.api.stop();
  console.log(
    "PASS: deleted content repaints immediately through memoized rows, with one red label and unchanged saved/original content",
  );
}
{
  const disk = new Map(),
    r = setup({ disk });
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.flush();
  assert(disk.has(PREFIX + USER + ".archive"));
  r.api.stop();
  const restored = setup({ disk });
  await restored.ready();
  assert.equal(restored.api.status().persistent, true);
  assert.equal(restored.api.entries()[0].message.content, "Original text");
  restored.caches.set(CHANNEL, new restored.Cache([message(ID2)]));
  assert.equal(
    restored.store.getMessages(CHANNEL).toArray()[0].id,
    ID,
    "Persistent raw snapshots hydrate into real message records",
  );
  restored.setUser(OTHER);
  await restored.ready();
  assert.equal(restored.api.entries().length, 0);
  assert.equal(restored.api.status().persistent, false);
  restored.setUser(USER);
  await restored.ready();
  assert.equal(restored.api.entries().length, 1);
  await restored.api.setPersistent(false);
  assert.equal(restored.api.entries().length, 1, "Changing mode preserves this session's view");
  assert(!disk.has(PREFIX + USER + ".logs"));
  const afterSwitch = setup({ disk });
  await afterSwitch.ready();
  assert.equal(afterSwitch.api.entries().length, 0);
  restored.api.stop();
  afterSwitch.api.stop();
  console.log(
    "PASS: persistent restart and native record hydration, account isolation and erasure when switching back to session mode",
  );
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.flush();
  r.setFail("remove");
  await assert.rejects(r.api.setPersistent(false));
  assert.equal(r.api.status().persistent, true);
  assert(r.api.status().error);
  await assert.rejects(r.api.clear());
  assert.equal(r.api.entries().length, 1);
  r.setFail(null);
  await r.api.clear();
  assert.equal(r.api.entries().length, 0);
  assert(!r.disk.has(PREFIX + USER + ".logs"));
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  r.setFail("write");
  await r.api.flush();
  assert(r.api.status().error);
  r.setFail(null);
  await r.api.flush();
  assert.equal(r.api.status().error, "");
  r.dispatcher.dispatch({ type: "LOGOUT" });
  assert.equal(r.api.entries().length, 0);
  r.api.stop();
  console.log(
    "PASS: saved-data erase failures never claim session mode or successful clear; save errors remain visible and logout clears memory",
  );
}
{
  const r = setup({ late: true, unavailableStorage: true });
  await r.ready();
  assert.equal(r.api.status().hook, false);
  r.late();
  assert.equal(r.api.status().hook, true);
  await assert.rejects(r.api.setPersistent(true), /unavailable/);
  vm.runInContext(source, r.context);
  assert.equal(r.dispatcher._interceptors.length, 1);
  await assert.rejects(r.api.setPersistent("invalid"));
  r.api.stop();
  console.log(
    "PASS: deferred module discovery, unavailable storage, duplicate-load cleanup and invalid-mode rejection",
  );
}
{
  const disk = new Map([
    [PREFIX + USER + ".settings", JSON.stringify({ persistent: true })],
    [PREFIX + USER + ".logs", JSON.stringify({ format: 1, entries: [] })],
  ]);
  const r = setup({ disk, fail: "read" });
  await r.ready();
  assert(r.api.status().error);
  r.setFail(null);
  r.late();
  await r.ready();
  assert.equal(
    r.api.status().persistent,
    true,
    "A temporary cold-start storage failure must not reset the saved mode",
  );
  assert.equal(r.api.status().error, "");
  r.api.stop();
}
{
  const disk = new Map([
    [PREFIX + USER + ".settings", JSON.stringify({ persistent: true })],
    [
      PREFIX + USER + ".logs",
      JSON.stringify({
        format: 1,
        entries: [
          {
            message: message(),
            deleted: true,
            changedAt: Date.now(),
            edits: [],
          },
        ],
      }),
    ],
  ]);
  const r = setup({ disk, bridgeMode: true, initialUser: null, fail: "read" });
  await r.ready();
  r.late(); // A missing account must not stop the startup recovery interval.
  r.setUser(USER);
  await r.ready();
  assert.equal(r.api.status().restoring, true);
  await assert.rejects(r.api.setPersistent(false), /still loading/);
  await r.api.flush();
  assert.equal(r.writes.length, 0, "Startup failure cannot replace or erase saved data");
  r.setFail(null);
  r.late();
  await r.ready();
  assert.equal(r.api.status().persistent, true);
  assert.equal(r.api.status().restoring, false);
  assert.equal(r.api.entries()[0].message.content, "Original text");
  const beforeReplacement = JSON.stringify(r.api.entries());
  vm.runInContext(source, r.context);
  await r.ready();
  assert.equal(r.api.status().persistent, true, "Replacing a plugin restores its saved choice");
  assert.equal(r.api.entries()[0].message.content, "Original text");
  assert.equal(JSON.stringify(r.api.entries()), beforeReplacement);
  r.api.stop();
  console.log(
    "PASS: delayed bridge/account startup recovers persistence; plugin replacement retains settings and history",
  );
}
{
  let historyUnavailable = true;
  const disk = new Map([
    [PREFIX + USER + ".settings", JSON.stringify({ persistent: true })],
    [PREFIX + USER + ".logs", JSON.stringify({ format: 1, entries: [] })],
  ]);
  const r = setup({
    disk,
    delayedRead: (key, values) => {
      if (historyUnavailable && key.endsWith(".logs")) throw Error("Storage not ready");
      return values.get(key) || null;
    },
  });
  await r.ready();
  assert.equal(
    r.api.status().persistent,
    true,
    "A history read error cannot change the stored mode",
  );
  await r.api.flush();
  assert.equal(r.writes.length, 0, "Unloaded history must not be overwritten by an empty save");
  historyUnavailable = false;
  r.api.retry();
  await r.ready();
  assert.equal(r.api.status().persistent, true);
  assert.equal(r.api.status().error, "");
  r.api.stop();
}
{
  const r = setup();
  await r.ready();
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  vm.runInContext(source, r.context);
  await r.ready();
  assert.equal(r.api.status().persistent, false);
  assert.equal(
    r.api.entries()[0].message.content,
    "Original text",
    "Replacing a running plugin keeps its session history until the process closes",
  );
  assert.equal(
    r.writes.filter(([, value]) => value !== null).length,
    0,
    "Session-only history is never written to disk during replacement",
  );
  const restarted = setup({ disk: r.disk });
  await restarted.ready();
  assert.equal(restarted.api.entries().length, 0);
  r.api.stop();
  restarted.api.stop();
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: { id: ID, channel_id: CHANNEL, content: "Latest text" },
  });
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  r.background();
  await r.api.flush();
  const saved = { entries: archivedEntries(r.disk) };
  assert.equal(saved.entries[0].edits[0].message.content, "Original text");
  r.api.stop();
  const restored = setup({ disk: r.disk });
  await restored.ready();
  const payload = {
    rows: [{ id: ID, channelId: CHANNEL, content: [{ type: "text", content: "Latest text" }] }],
  };
  restored.chat.updateRows(1, payload);
  const row = restored.calls.at(-1).args[1].rows[0];
  assert.equal(row.textColor, 0xffff6b7a | 0);
  assert.match(row.content[0].content[1].content[0].content, /Original text/);
  assert.equal(row.content[0].content[1].linkColor, 0xffa5a7af | 0);
  restored.api.stop();
  console.log(
    "PASS: background flush and cold restart preserve both deleted text and gray inline edit history",
  );
}
{
  const r = setup();
  await r.ready();
  const cached = message();
  r.caches.set(CHANNEL, new r.Cache([cached]));
  for (let i = 0; i < 25; i++) {
    r.dispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      message: { id: ID, channel_id: CHANNEL, content: "Version " + i },
    });
  }
  assert.equal(r.api.entries()[0].edits.length, 20);
  const many = Array.from({ length: 505 }, (_, i) =>
    message(String(500000000000000000n + BigInt(i)), "Deleted " + i),
  );
  r.caches.set(CHANNEL, new r.Cache(many));
  r.dispatcher.dispatch({
    type: "MESSAGE_DELETE_BULK",
    channelId: CHANNEL,
    ids: many.map((m) => m.id),
  });
  assert.equal(r.api.entries().length, 506);
  await r.api.setPersistent(true);
  assert.equal(archivedEntries(r.disk).length, 506);
  assert([...r.disk.values()].every((value) => Buffer.byteLength(value, "utf8") < 1024 * 1024));
  r.api.stop();
  console.log(
    "PASS: history exceeds the old 500-message limit, with 20 earlier edits per message and bounded disk pages",
  );
}
{
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const r = setup({
    delayedRead: async (key, disk) => {
      if (first) {
        first = false;
        await gate;
      }
      return disk.get(key) || null;
    },
  });
  const pending = r.api.setPersistent(true);
  r.setUser(OTHER);
  const switched = r.ready();
  release();
  await assert.rejects(pending, /account changed/);
  await switched;
  assert.equal(r.api.status().account, OTHER);
  assert(!r.disk.has(PREFIX + USER + ".logs"));
  assert(!r.disk.has(PREFIX + OTHER + ".logs"));
  r.setFail("write");
  await assert.rejects(r.api.setPersistent(true));
  assert.equal(r.api.status().persistent, false);
  assert(!r.disk.has(PREFIX + OTHER + ".logs"));
  r.api.stop();
  console.log(
    "PASS: account changes during loading reject stale mode changes; failed enable removes partial persistence",
  );
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  for (let start = 0; start < 10050; start += 1000) {
    const batch = Array.from({ length: Math.min(1000, 10050 - start) }, (_, i) =>
      message(String(600000000000000000n + BigInt(start + i)), "Archived " + (start + i)),
    );
    r.caches.set(CHANNEL, new r.Cache(batch));
    r.dispatcher.dispatch({
      type: "MESSAGE_DELETE_BULK",
      channelId: CHANNEL,
      ids: batch.map((m) => m.id),
    });
    await r.api.flush();
  }
  assert.equal(
    archivedEntries(r.disk).length,
    10050,
    "No automatic disk retention limit at 10,000 messages",
  );
  assert.equal(r.api.entries().length, 10000, "The hot cache is bounded after confirmed saves");
  assert(
    r.api.status().hasOlder,
    "Eviction from the live cache exposes older saved pages immediately",
  );
  const olderLive = await r.api.historyPage();
  assert(olderLive.entries.length > 0, "Older saved messages are browsable before restarting");
  await r.api.stop();
  const cold = setup({ disk: r.disk });
  await cold.ready();
  assert(cold.api.entries().length <= 1024, "Cold startup loads only recent pages");
  assert.equal(cold.api.status().persistent, true);
  assert(cold.api.status().hasOlder);
  const seen = new Set(cold.api.entries().map((entry) => entry.message.id));
  let cursor,
    pageSeen = [];
  do {
    const page = await cold.api.historyPage(cursor, pageSeen);
    assert(page.entries.length <= 63, "Archive browsing keeps a bounded page in memory");
    for (const entry of page.entries) {
      assert(
        !seen.has(entry.message.id),
        "Paging does not duplicate a recent or already-browsed message",
      );
      seen.add(entry.message.id);
    }
    cursor = page.cursor;
    pageSeen = page.seen;
  } while (cursor !== null);
  assert.equal(seen.size, 10050, "Every retained message is reachable after restart");
  await cold.api.clear();
  assert(
    ![...r.disk.keys()].some((key) => key.startsWith(PREFIX + USER + ".archive")),
    "Clear erases all pages and journal metadata",
  );
  await cold.api.stop();
  console.log(
    "PASS: 10,050 messages survive restart without disk eviction; startup and browsing are paged, deduplicated and clearable",
  );
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  const content = "漢".repeat(10000) + "🟣".repeat(5000);
  r.caches.set(CHANNEL, new r.Cache([message(ID, content)]));
  for (let i = 0; i < 21; i++)
    r.dispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      message: { id: ID, channel_id: CHANNEL, content: String(i) + content },
    });
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.flush();
  const saved = archivedEntries(r.disk)[0];
  assert(
    Buffer.byteLength(JSON.stringify(saved), "utf8") > 1024 * 1024,
    "One message with edit history can exceed a storage value",
  );
  assert.equal(saved.edits.length, 20);
  await r.api.stop();
  const cold = setup({ disk: r.disk });
  await cold.ready();
  const restored = cold.api.entries()[0];
  for (const field of Object.keys(saved.message))
    assert(
      JSON.stringify(restored.message[field]) === JSON.stringify(saved.message[field]),
      "Restored message field: " + field,
    );
  assert.equal(restored.edits.length, saved.edits.length);
  for (let i = 0; i < saved.edits.length; i++)
    assert(
      JSON.stringify(restored.edits[i]) === JSON.stringify(saved.edits[i]),
      "Restored edit " + i,
    );
  assert.equal(restored.deleted, saved.deleted);
  assert.equal(restored.changedAt, saved.changedAt);
  assert.equal(cold.api.status().error, "");
  await cold.api.stop();
  console.log(
    "PASS: Unicode edit histories larger than 1 MiB span safe chunks and restore without truncation",
  );
}
{
  let failChunk = false,
    failHead = false,
    failErase = false;
  const disk = new Map(),
    r = setup({
      disk,
      storageOperation(operation, key) {
        if (failChunk && operation === "write" && /\.archive\.[a-z0-9-]+\.0$/.test(key)) {
          failChunk = false;
          throw Error("Interrupted page write");
        }
        if (failHead && operation === "write" && key.endsWith(".archive")) {
          failHead = false;
          throw Error("Interrupted index update");
        }
        if (failErase && operation === "remove" && /\.archive\.[a-z0-9-]+\.0$/.test(key)) {
          failErase = false;
          throw Error("Interrupted erase");
        }
      },
    });
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.flush();
  const head = disk.get(PREFIX + USER + ".archive");
  for (const fail of [
    () => {
      failChunk = true;
    },
    () => {
      failHead = true;
    },
  ]) {
    r.caches.set(CHANNEL, new r.Cache([message(ID2, "Not yet saved")]));
    r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID2, channelId: CHANNEL });
    fail();
    await r.api.flush();
    assert(r.api.status().error);
    assert.equal(
      disk.get(PREFIX + USER + ".archive"),
      head,
      "Failed append keeps the last committed history",
    );
    assert.equal(archivedEntries(disk).length, 1);
    assert.equal(r.api.entries().length, 2, "Unsaved entries remain in memory for retry");
  }
  await r.api.flush();
  assert.equal(r.api.status().error, "");
  assert.equal(archivedEntries(disk).length, 2);
  failErase = true;
  await assert.rejects(r.api.clear());
  assert(r.api.status().error);
  assert(
    disk.has(PREFIX + USER + ".archive.pending"),
    "Interrupted cleanup retains its recovery checkpoint",
  );
  const cold = setup({ disk });
  await cold.ready();
  assert.equal(cold.api.status().error, "", "Cold startup resumes interrupted erasure");
  await cold.api.clear();
  assert(![...disk.keys()].some((key) => key.includes(".archive")));
  await cold.api.stop();
  await r.api.stop();
  console.log(
    "PASS: interrupted chunk/index writes retain the previous head and retry dirty entries; interrupted erase resumes cleanup",
  );
}
{
  const legacy = JSON.stringify({
    format: 1,
    entries: Array.from({ length: 65 }, (_, i) => ({
      message: message(String(700000000000000000n + BigInt(i)), "Legacy " + i),
      edits: [],
      deleted: true,
      changedAt: i,
    })),
  });
  const disk = new Map([
    [PREFIX + USER + ".settings", JSON.stringify({ persistent: true })],
    [PREFIX + USER + ".logs", legacy],
  ]);
  let pages = 0,
    interrupt = true;
  const r = setup({
    disk,
    storageOperation(operation, key) {
      if (interrupt && operation === "write" && key.endsWith(".archive") && ++pages === 2)
        throw Error("Migration interrupted");
    },
  });
  await r.ready();
  assert(r.api.status().restoring);
  assert.equal(
    disk.get(PREFIX + USER + ".logs"),
    legacy,
    "Legacy history is retained until every migrated page commits",
  );
  interrupt = false;
  r.api.retry();
  await r.ready();
  assert.equal(r.api.status().error, "");
  assert.equal(r.api.entries().length, 65);
  assert.equal(archivedEntries(disk).length, 65);
  assert(!disk.has(PREFIX + USER + ".logs"));
  await r.api.stop();
  console.log(
    "PASS: interrupted snapshot migration is retryable without deleting the original history",
  );
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.flush();
  await r.api.stop();
  const base = PREFIX + USER + ".archive",
    cursor = JSON.parse(r.disk.get(base)).cursor;
  r.disk.set(
    base + ".pending",
    JSON.stringify({
      format: 1,
      id: "interrupted-page",
      previous: cursor,
      parts: 2,
      operation: "append",
    }),
  );
  r.disk.set(base + ".interrupted-page.0", "partial data");
  const cold = setup({ disk: r.disk });
  await cold.ready();
  assert.equal(cold.api.status().error, "");
  assert.equal(cold.api.entries()[0].message.content, "Original text");
  assert(
    ![...r.disk.keys()].some((key) => key.includes("interrupted-page") || key.endsWith(".pending")),
    "Restart cleans abandoned page chunks without changing committed data",
  );
  await cold.api.stop();
  console.log(
    "PASS: cold restart recovers abandoned append checkpoints and preserves the committed archive",
  );
}
{
  const r = setup();
  await r.ready();
  r.caches.set(CHANNEL, new r.Cache([message(), message(ID2, "Still live")]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.forceDelete(CHANNEL, ID2);
  assert.equal(
    r.store.getMessages(CHANNEL).toArray().length,
    2,
    "Force delete cannot remove a live message",
  );
  await r.api.forceDelete(CHANNEL, ID);
  assert.equal(r.api.entries().length, 0);
  assert.equal(r.api.status().count, 0);
  assert.deepEqual(
    Array.from(r.store.getMessages(CHANNEL).toArray(), (m) => m.id),
    [ID2],
    "The projected deleted row disappears immediately",
  );
  assert(
    !r.writes.some(([, value]) => value !== null),
    "Session-mode force deletion stays memory-only",
  );
  await r.api.stop();
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message()]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE", id: ID, channelId: CHANNEL });
  await r.api.flush();
  r.setFail("write");
  await assert.rejects(r.api.forceDelete(CHANNEL, ID), /Could not save the removal/);
  assert(r.api.status().error, "An unsuccessful persistent removal is reported");
  assert.equal(r.api.entries().length, 0);
  r.setFail(null);
  await r.api.flush();
  assert.equal(r.api.status().error, "");
  assert.equal(archivedEntries(r.disk).length, 0);
  const archive = PREFIX + USER + ".archive",
    head = JSON.parse(r.disk.get(archive)).cursor;
  const markerKey = archive + "." + head + ".0",
    page = JSON.parse(r.disk.get(markerKey));
  page.entries[0].changedAt = 0;
  r.disk.set(markerKey, JSON.stringify(page));
  await r.api.stop();
  const cold = setup({ disk: r.disk });
  await cold.ready();
  assert.equal(
    cold.api.entries().length,
    0,
    "A removal marker wins even when the device clock moved backwards",
  );
  assert.equal(cold.api.status().persistent, true);
  assert.equal((await cold.api.historyPage()).entries.length, 0);
  await cold.api.clear();
  assert(
    ![...r.disk.keys()].some((key) => key.includes(".archive")),
    "Clear removes removal markers along with journal snapshots",
  );
  await cold.api.stop();
  console.log(
    "PASS: local force deletion preserves live messages, repaints immediately, retries failed saves and survives cold restart",
  );
}
{
  const r = setup();
  await r.ready();
  await r.api.setPersistent(true);
  r.caches.set(CHANNEL, new r.Cache([message(), message(ID2, "Retained neighbor")]));
  r.dispatcher.dispatch({ type: "MESSAGE_DELETE_BULK", ids: [ID, ID2], channelId: CHANNEL });
  await r.api.flush();
  await r.api.forceDelete(CHANNEL, ID);
  for (let start = 0; start < 1050; start += 1000) {
    const batch = Array.from({ length: Math.min(1000, 1050 - start) }, (_, i) =>
      message(String(800000000000000000n + BigInt(start + i)), "Newer " + (start + i)),
    );
    r.caches.set(CHANNEL, new r.Cache(batch));
    r.dispatcher.dispatch({
      type: "MESSAGE_DELETE_BULK",
      channelId: CHANNEL,
      ids: batch.map((m) => m.id),
    });
    await r.api.flush();
  }
  await r.api.stop();
  const cold = setup({ disk: r.disk });
  await cold.ready();
  const found = new Set(cold.api.entries().map((entry) => entry.message.id));
  let cursor,
    seen = [];
  do {
    const page = await cold.api.historyPage(cursor, seen);
    for (const entry of page.entries) found.add(entry.message.id);
    cursor = page.cursor;
    seen = page.seen;
  } while (cursor !== null);
  assert.equal(found.size, 1051);
  assert(found.has(ID2));
  assert(
    !found.has(ID),
    "A removal older than the startup cache still prevents resurrection while paging the archive",
  );
  await cold.api.stop();
  console.log(
    "PASS: force-deleted messages stay absent while paging beyond the startup cache; neighboring messages remain available",
  );
}
