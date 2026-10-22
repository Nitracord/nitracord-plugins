import vm from "node:vm";
import fs from "node:fs";
import assert from "node:assert/strict";
const dc = {
  registerTool(t) {
    this.tool = t;
  },
  findModule() {
    return null;
  },
  ui: {},
};
vm.runInNewContext(fs.readFileSync("src/discord-cleaner.js", "utf8"), {
  Nitracord: dc,
  console,
  setTimeout,
  fetch: async () => {
    throw Error("No live network in tests");
  },
});
const create = dc.bulkCleaner.createEngine,
  channel = "100000000000000001",
  user = "100000000000000002",
  other = "100000000000000003";
const message = (n, author = user, extra = {}) => ({
  id: "20000000000000000" + n,
  channel_id: channel,
  author: { id: author },
  type: 0,
  content: "hello world",
  timestamp: "2026-10-20T12:00:00Z",
  ...extra,
});
const opts = { channelId: channel, mode: "channel" },
  noWait = async () => {};
let calls = [],
  deleted = [],
  items = [
    message(1),
    message(2, other),
    message(3, user, { pinned: true }),
    message(4, user, { type: 6 }),
    message(5, user, { timestamp: "2026-01-01T00:00:00Z" }),
  ];
const adapter = {
  user: () => user,
  async request(method, path, query) {
    calls.push({ method, path, query });
    if (method === "del") {
      deleted.push(path);
      return { status: 204 };
    }
    if (path.endsWith("/messages"))
      return {
        status: 200,
        body: query.around ? items.filter((m) => m.id === query.around) : query.before ? [] : items,
      };
    return { status: 200, body: items.find((m) => path.endsWith("/" + m.id)) };
  },
};
let engine = create(adapter, null, noWait),
  planId = await engine.preview({ ...opts, after: "2026-10-01", before: "2026-10-31" });
assert.equal(engine.plan().items.length, 1);
assert(calls.every((c) => c.method === "get"));
assert.equal(deleted.length, 0);
await engine.remove(planId);
assert.equal(deleted.length, 1);
assert.equal(engine.state().deleted, 1);
await assert.rejects(engine.remove(planId), /fresh preview/);
console.log(
  "PASS: preview is read-only; author, type, pinned and date filters; confirmed deletion; no plan reuse",
);
engine = create(adapter, null, noWait);
planId = await engine.preview(opts);
items[0] = { ...items[0], author: { id: other } };
deleted = [];
await engine.remove(planId);
assert(deleted.every((p) => !p.endsWith("/200000000000000001")));
console.log("PASS: ownership rechecked before deletion");
engine = create(adapter, null, noWait);
planId = await engine.preview(opts);
engine.invalidate();
await assert.rejects(engine.remove(planId), /fresh preview/);
let currentUser = user;
engine = create({ ...adapter, user: () => currentUser }, null, noWait);
planId = await engine.preview(opts);
currentUser = other;
await assert.rejects(engine.remove(planId), /Account changed/);
console.log("PASS: filter changes and account switches invalidate confirmation");
let attempts = 0,
  waited = 0;
engine = create(
  {
    user: () => user,
    async request() {
      attempts++;
      return attempts === 1 ? { status: 429, body: { retry_after: 1 } } : { status: 200, body: [] };
    },
  },
  null,
  async (ms) => {
    waited += ms;
  },
);
await engine.preview(opts);
assert.equal(attempts, 2);
assert(waited >= 1300);
console.log("PASS: rate-limit retry waits for retry_after");
let release;
calls = [];
engine = create(
  {
    user: () => user,
    async request(method) {
      calls.push(method);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  },
  null,
  noWait,
);
const pending = engine.preview(opts);
await new Promise((resolve) => setImmediate(resolve));
engine.stop();
release({ status: 200, body: [message(1)] });
await pending;
assert.equal(engine.plan(), null);
assert.deepEqual(calls, ["get"]);
assert.equal(engine.state().phase, "stopped");
console.log("PASS: stopping during a request prevents subsequent requests and confirmation");
let scopeCalls = [];
engine = create(
  {
    user: () => user,
    async request(method, path, query) {
      scopeCalls.push(path);
      if (path === "/users/@me/channels")
        return {
          status: 200,
          body: [
            { id: channel, type: 1 },
            { id: "100000000000000004", type: 0 },
          ],
        };
      return { status: 200, body: [] };
    },
  },
  null,
  noWait,
);
await engine.preview({ mode: "dms" });
assert.deepEqual(scopeCalls, ["/users/@me/channels", "/channels/" + channel + "/messages"]);
engine = create(adapter, null, noWait);
await assert.rejects(engine.preview({ ...opts, after: "2026-02-31" }), /Invalid date/);
await assert.rejects(engine.preview({ ...opts, channelId: "bad" }), /channel or DM ID/);
assert.throws(() => dc.tool.open(), /React Native UI/);
assert.equal(dc.tool.id, "discord-cleaner");
console.log("PASS: scope filtering, input validation and unsupported runtime guard");

const client = {
  get: async () => ({ status: 200, body: [] }),
  del: async () => ({ status: 204 }),
  post() {},
};
let readCalls = 0;
const candidates = [
  {
    getCurrentUser() {
      return null;
    },
  },
  {
    getCurrentUser() {
      return Promise.resolve({ id: user });
    },
  },
  {
    getCurrentUser() {
      return { id: user };
    },
  },
  {
    getToken() {
      return "test-session";
    },
  },
];
dc.findModule = (predicate) => candidates.find(predicate) || null;
client.get = async () => {
  readCalls++;
  return { status: 200, body: [] };
};
assert.equal(dc.bulkCleaner.availability().ready, true);
assert.equal(readCalls, 0);
candidates.splice(2, 1);
const unavailable = dc.bulkCleaner.availability();
assert.equal(unavailable.ready, false);
assert(!/sign in|login/i.test(unavailable.message));
assert.equal(readCalls, 0);
assert.equal(dc.tool.header, true);
assert.equal(dc.tool.floating, undefined);
assert.equal(dc.tool.icon, "trash");
console.log(
  "PASS: skip empty and async user modules, find active user store, no login misdiagnosis or network probe, floating trash registration",
);

const guild = "100000000000000099";
let contextModules = [
  {
    getChannelId() {
      return null;
    },
  },
  {
    getChannelId() {
      throw Error("unavailable");
    },
  },
  {
    getCurrentlySelectedChannelId() {
      return channel;
    },
  },
  {
    getChannel() {
      return { id: channel, guildId: guild };
    },
  },
];
dc.findModule = (p) => contextModules.find(p) || null;
assert.equal(dc.bulkCleaner.currentContext().channelId, channel);
assert.equal(dc.bulkCleaner.currentContext().guildId, guild);
contextModules = [
  {
    getChannelId() {
      return { channel_id: channel };
    },
  },
];
assert.equal(dc.bulkCleaner.currentContext().channelId, channel);
assert.equal(dc.bulkCleaner.currentContext().guildId, null);
console.log(
  "PASS: current channel skips empty/throwing stores, accepts object IDs and camelCase guild IDs",
);
{
  const previousFind = dc.findModule;
  let activeUser = user;
  dc.context = {
    apiVersion: 1,
    currentUser: () => activeUser,
    current: () => ({ channelId: channel, guildId: guild }),
  };
  const localSession = { getToken: () => "fixture-session" };
  dc.findModule = (predicate) => (predicate(localSession) ? localSession : null);
  assert.equal(dc.bulkCleaner.availability().ready, true);
  assert.equal(dc.bulkCleaner.currentContext().channelId, channel);
  assert.equal(dc.bulkCleaner.currentContext().guildId, guild);
  activeUser = null;
  assert.equal(dc.bulkCleaner.availability().ready, false);
  delete dc.context;
  dc.findModule = previousFind;
  console.log(
    "PASS: shared bridge account/context work without raw user/channel stores and logout stays authoritative",
  );
}

engine = create(
  {
    user: () => user,
    async request() {
      return { response: { statusCode: 200, data: [] } };
    },
  },
  null,
  noWait,
);
await engine.preview(opts);
assert.equal(engine.state().phase, "preview");
engine = create(
  {
    user: () => user,
    async request() {
      throw { response: { status: 401, body: {} } };
    },
  },
  null,
  noWait,
);
await assert.rejects(engine.preview(opts), /HTTP 401/);
engine = create(
  {
    user: () => user,
    async request() {
      throw new TypeError("request options are invalid token=secret-should-not-appear");
    },
  },
  null,
  noWait,
);
await assert.rejects(
  engine.preview(opts),
  (e) =>
    /TypeError/.test(e.message) &&
    /options are invalid/.test(e.message) &&
    !e.message.includes("secret-should-not-appear"),
);
assert.equal(engine.plan(), null);
console.log(
  "PASS: nested REST responses/errors normalize and exception diagnostics redact credentials",
);

let nativeCalls = [];
const stringClient = {
  get(url, options) {
    assert.equal(this, stringClient);
    assert.equal(typeof url, "string");
    nativeCalls.push({ method: "get", url, options });
    return { status: 200, body: [] };
  },
  del(url, options) {
    assert.equal(typeof url, "string");
    nativeCalls.push({ method: "del", url, options });
    return { status: 204 };
  },
};
await dc.bulkCleaner.nativeRequest(stringClient, "get", "/channels/" + channel + "/messages", {
  limit: 100,
  before: "200000000000000001",
});
assert.equal(
  nativeCalls[0].url,
  "/channels/" + channel + "/messages?limit=100&before=200000000000000001",
);
assert.equal(nativeCalls[0].options.url, undefined);
assert.equal(nativeCalls[0].options.query, undefined);
await dc.bulkCleaner.nativeRequest(
  stringClient,
  "del",
  "/channels/" + channel + "/messages/200000000000000001",
);
assert.equal(nativeCalls[1].method, "del");
assert.throws(
  () => dc.bulkCleaner.nativeRequest(stringClient, "get", "https://example.com"),
  /route/,
);
assert.throws(
  () =>
    dc.bulkCleaner.nativeRequest(
      stringClient,
      "del",
      "/channels/" + channel + "/messages/200000000000000001",
      { limit: 1 },
    ),
  /delete query/,
);
assert.equal(nativeCalls.length, 2);
console.log(
  "PASS: native Android client receives URL string, encoded pagination and separate options; invalid routes never requested",
);

let fetchCalls = [];
const mockFetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return { status: 200, url, headers: {}, text: async () => "[]" };
};
const session = { getToken: () => "mock-session-only" };
const apiResponse = await dc.bulkCleaner.sessionRequest(
  mockFetch,
  session,
  "get",
  "/channels/" + channel + "/messages",
  { limit: 100 },
);
assert.equal(apiResponse.status, 200);
assert.equal(
  fetchCalls[0].url,
  "https://discord.com/api/v9/channels/" + channel + "/messages?limit=100",
);
assert.equal(fetchCalls[0].options.headers.Authorization, "mock-session-only");
assert.equal(fetchCalls[0].options.redirect, "error");
assert.equal(fetchCalls[0].options.credentials, "omit");
await assert.rejects(
  dc.bulkCleaner.sessionRequest(mockFetch, session, "get", "https://example.com"),
  /route/,
);
await assert.rejects(
  dc.bulkCleaner.sessionRequest(
    mockFetch,
    { getToken: () => null },
    "get",
    "/channels/" + channel + "/messages",
  ),
  /session is not ready/,
);
assert.equal(fetchCalls.length, 1);
console.log(
  "PASS: fixed Discord API origin, local session header, no redirects, missing session and foreign routes rejected before fetch",
);

let writes = 0,
  rechecks = 0;
engine = create(
  {
    user: () => user,
    async request(method, path, query) {
      if (method === "del") {
        writes++;
        return { status: 204 };
      }
      if (query.around) {
        rechecks++;
        return { status: 403, body: {} };
      }
      return { status: 200, body: query.before ? [] : [message(9)] };
    },
  },
  null,
  noWait,
);
planId = await engine.preview(opts);
await assert.rejects(engine.remove(planId), /ownership.*HTTP 403/);
assert.equal(writes, 0);
assert.equal(rechecks, 1);
assert.equal(engine.state().phase, "error");
assert.equal(engine.state().skipped, 0);
console.log(
  "PASS: history-based ownership recheck; denied verification stops instead of silently skipping all messages",
);

let displayed;
const element = (type, props, ...children) => ({ type, props: props || {}, children });
dc.config = {
  theme: { background: "#101010", surface: "#202020", text: "#eeeeee", accent: "#abcdef" },
};
dc.React = {
  createElement: element,
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect() {},
};
dc.Native = {
  Modal: "Modal",
  TextInput: "TextInput",
  Alert: { alert() {} },
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  SafeAreaView: "SafeAreaView",
  Switch: "Switch",
};
dc.ui = { present: (e) => (displayed = e), close() {} };
dc.tool.open();
const tree = displayed.type();
const all = [];
function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  all.push(node);
  walk(node.children);
}
walk(tree);
const strings = all.flatMap((n) => n.children.filter((v) => typeof v === "string"));
assert(strings.includes("Message cleanup"));
assert(strings.includes("SCOPE"));
assert(strings.includes("FILTERS"));
assert(strings.includes("PREVIEW"));
assert(all.some((n) => n.type === "Switch"));
assert(all.some((n) => n.props.accessibilityLabel === "Back"));
const inputs = all.filter((n) => n.type === "TextInput");
assert.equal(inputs.length, 2);
assert.equal(
  all.find(
    (n) =>
      n.type === "View" &&
      n.props.style &&
      n.props.style.flex === 1 &&
      n.props.style.backgroundColor,
  ).props.style.backgroundColor,
  "#101010",
);
assert.equal(dc.tool.version, "0.0.1");
assert(dc.tool.author);
assert(dc.tool.website.startsWith("https://"));
dc.ui.Page = function Page() {};
dc.ui.Section = function Section() {};
dc.ui.Row = function Row() {};
dc.ui.Field = function Field() {};
dc.ui.colors = () => ({ background: "#101725", surface: "#202735" });
dc.tool.open();
const builderPage = displayed.type().children[0];
assert.equal(builderPage.type, dc.ui.Page);
assert.equal(builderPage.props.title, "Message cleanup");
assert.equal(builderPage.props.style.backgroundColor, "#101725");
console.log(
  "PASS: Discord-style cleaner header, grouped scope/filters/preview, native switch, themed surface and plugin metadata",
);

let moderator = true,
  authorWrites = [];
const authorMessages = [message(1, user), message(2, other)];
const moderationAdapter = {
  user: () => user,
  canDeleteOthers: () => moderator,
  async request(method, path, query) {
    if (method === "del") {
      authorWrites.push(path);
      return { status: 204 };
    }
    return {
      status: 200,
      body: query.around
        ? authorMessages.filter((m) => m.id === query.around)
        : query.before
          ? []
          : authorMessages,
    };
  },
};
let moderation = create(moderationAdapter, null, noWait);
let moderationId = await moderation.preview({ ...opts, authors: "everyone" });
assert.equal(moderation.plan().items.length, 2);
assert.equal(authorWrites.length, 0);
assert.equal(moderation.plan().items[1].authorId, other);
await moderation.remove(moderationId);
assert.equal(authorWrites.length, 2);
moderator = false;
moderation = create(moderationAdapter, null, noWait);
await moderation.preview({ ...opts, authors: "everyone" });
assert.equal(moderation.plan().items.length, 1);
moderation = create(moderationAdapter, null, noWait);
await moderation.preview({ ...opts, authors: "user", authorId: other });
assert.equal(moderation.plan().items.length, 0);
moderator = true;
moderation = create(moderationAdapter, null, noWait);
moderationId = await moderation.preview({ ...opts, authors: "user", authorId: other });
assert.equal(moderation.plan().items.length, 1);
moderator = false;
authorWrites = [];
await moderation.remove(moderationId);
assert.equal(authorWrites.length, 0);
assert.equal(moderation.state().skipped, 1);
moderation = create(moderationAdapter, null, noWait);
await assert.rejects(
  moderation.preview({ ...opts, authors: "user", authorId: "bad" }),
  /valid author/,
);
await assert.rejects(moderation.preview({ ...opts, authors: "unknown" }), /whose messages/);
console.log(
  "PASS: mine/everyone/specific-author filters, read-only preview, moderator permission required and permission loss rechecked",
);
