import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
let user = "111111111111111111",
  channel = "222222222222222222",
  tool,
  presented,
  unregistered = 0;
const subscriptions = new Set(),
  effects = [];
const dc = {
  version: "0.0.1",
  config: { theme: {} },
  messages: {
    subscribe(callback) {
      subscriptions.add(callback);
      return () => subscriptions.delete(callback);
    },
  },
  context: {
    currentUser: () => user,
    currentChannel: () => channel,
    current: () => ({ channelId: channel, guildId: null }),
  },
  registerTool(value) {
    tool = value;
    return () => unregistered++;
  },
  ui: {
    present(value) {
      presented = value;
    },
    safeInsets: () => ({ top: 24, bottom: 24 }),
    close() {},
  },
  React: {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (value) => [value, () => {}],
    useEffect(callback) {
      effects.push(callback());
    },
  },
  Native: { View: "View", Text: "Text", Pressable: "Pressable" },
  log() {},
};
const context = vm.createContext({ Nitracord: dc });
const source = fs.readFileSync("examples/channel-activity.js", "utf8");
const emit = (event) => [...subscriptions].forEach((callback) => callback(event));
vm.runInContext(source, context);
emit({ type: "MESSAGE_CREATE", message: { channel_id: channel } });
emit({ type: "MESSAGE_UPDATE", message: { channel_id: channel } });
assert.equal(dc.channelActivity.getCount(), 1);
tool.open();
const page = presented.type();
assert.equal(page.props.style.paddingTop, 40);
assert.equal(page.children[1].children[0], "1 message observed in this chat during this session.");
user = "333333333333333333";
assert.equal(dc.channelActivity.getCount(), 0);
vm.runInContext(source, context);
assert.equal(subscriptions.size, 1, "Reload stops the old instance");
dc.channelActivity.stop();
assert.equal(subscriptions.size, 0);
assert.equal(unregistered, 2);
effects.forEach((dispose) => dispose());
vm.runInContext(fs.readFileSync("examples/hello.js", "utf8"), context);
console.log(
  "PASS: documented starter runs, renders with safe insets, counts only creates, isolates accounts and cleans up on reload/stop",
);
