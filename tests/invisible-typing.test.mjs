import vm from "node:vm";
import fs from "node:fs";
import assert from "node:assert/strict";
const source = fs.readFileSync("src/invisible-typing.js", "utf8"),
  A = "111111111111111111",
  B = "222222222222222222";
function setup({ late = false, stored = null, load, broken = false, bridge = false } = {}) {
  let available = !late,
    selected = A,
    rendered,
    interval,
    clears = 0,
    modules = [],
    writes = [],
    events = [],
    tool;
  const dispatcher = {
    _interceptors: [],
    addInterceptor(fn) {
      this._interceptors.push(fn);
    },
    dispatch(event) {
      if (this._interceptors.some((fn) => fn(event))) return;
      events.push(event);
    },
  };
  const storage =
    stored !== null || load
      ? {
          getItem: () => load || Promise.resolve(stored),
          setItem: async (key, value) => {
            writes.push({ key, value });
          },
          removeItem() {},
          multiRemove() {},
          mergeItem() {},
        }
      : null;
  const store = { getCurrentlySelectedChannelId: () => selected };
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
    config: {
      theme: { background: "#111111", surface: "#222222", text: "#eeeeee", accent: "#abcdef" },
    },
    React,
    Native: {
      View: "View",
      Text: "Text",
      Switch: "Switch",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Alert: { alert() {} },
    },
    ui: {
      safeInsets: () => ({ top: 28, bottom: 24 }),
      close() {},
      present(element) {
        rendered = element;
      },
    },
    findModule(predicate) {
      for (const module of [
        ...modules,
        ...(bridge ? [] : [store]),
        ...(available && !bridge ? [dispatcher] : []),
        ...(storage ? [storage] : []),
      ])
        try {
          if (predicate(module)) return module;
        } catch {}
      return null;
    },
    registerTool(value) {
      tool = value;
    },
    log() {},
  };
  if (bridge) {
    dc.context = { apiVersion: 1, currentChannel: () => selected };
    dc.storage = {
      apiVersion: 1,
      scope(namespace) {
        assert.equal(namespace, "invisible-typing");
        return {
          async getItem() {
            return null;
          },
          async setItem(key, value) {
            writes.push({ key: namespace + ":" + key, value });
          },
        };
      },
    };
    dc.typing = {
      apiVersion: 1,
      suppress(predicate) {
        const listener = (event) =>
          event.type === "TYPING_START_LOCAL" && predicate(event.channelId);
        dispatcher._interceptors.push(listener);
        return () => dispatcher._interceptors.splice(dispatcher._interceptors.indexOf(listener), 1);
      },
      stopLocal(channelId) {
        dispatcher.dispatch({ type: "TYPING_STOP_LOCAL", channelId });
      },
      status: () => ({ available }),
    };
  }
  const context = {
    Nitracord: dc,
    setInterval(fn) {
      interval = fn;
      return 1;
    },
    clearInterval() {
      interval = null;
      clears++;
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    dc,
    dispatcher,
    events,
    writes,
    context,
    get tool() {
      return tool;
    },
    get rendered() {
      return rendered;
    },
    late() {
      available = true;
    },
    tick() {
      interval?.();
    },
    setChannel(value) {
      selected = value;
    },
    modules,
    clearCount: () => clears,
  };
}
{
  const r = setup({
    bridge: true,
    stored: JSON.stringify({ hide: false, channels: { [A]: true } }),
  });
  await r.dc.invisibleTyping.ready;
  await Promise.resolve();
  assert.equal(r.dc.invisibleTyping.currentChannel(), A);
  assert.equal(r.dc.invisibleTyping.hidden(A), true);
  assert.equal(r.dc.invisibleTyping.hidden(B), false);
  assert(
    r.writes.some((write) => write.key === "invisible-typing:nitracord.plugin.invisible-typing.v1"),
  );
  r.events.length = 0;
  r.dispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId: A });
  assert.equal(r.events.length, 0);
  r.dispatcher.dispatch({ type: "TYPING_START", channelId: A });
  assert.equal(r.events.length, 1);
  r.dc.invisibleTyping.stop();
  assert.equal(r.dispatcher._interceptors.length, 0);
  console.log(
    "PASS: public bridge supplies typing/context/scoped storage, migrates existing settings and disposes suppression without raw store/dispatcher discovery",
  );
}
{
  const r = setup();
  await r.dc.invisibleTyping.ready;
  assert.equal(r.dc.invisibleTyping.status().hook, true);
  assert.equal(r.dispatcher._interceptors.length, 1);
  r.events.length = 0;
  r.dispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId: A });
  assert.equal(r.events.length, 0);
  assert.equal(r.dc.invisibleTyping.status().blocked, 1);
  for (const type of ["TYPING_START", "MESSAGE_CREATE", "TYPING_STOP_LOCAL", "MESSAGE_SEND"])
    r.dispatcher.dispatch({ type, channelId: A });
  assert.equal(r.events.length, 4);
  r.dispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId: "bad" });
  assert.equal(r.events.length, 5);
  r.dc.invisibleTyping.setChannel(A, false);
  r.events.length = 0;
  r.dispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId: A });
  r.dispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId: B });
  assert.equal(r.events.length, 1);
  r.dc.invisibleTyping.setDefault(false);
  assert.equal(r.dc.invisibleTyping.hidden(B), false);
  r.dc.invisibleTyping.setChannel(B, true);
  assert.equal(r.dc.invisibleTyping.hidden(B), true);
  r.dc.invisibleTyping.setChannel(B, null);
  assert.equal(r.dc.invisibleTyping.hidden(B), false);
  assert.throws(() => r.dc.invisibleTyping.setChannel("bad", true));
  assert.throws(() => r.dc.invisibleTyping.setDefault("yes"));
  r.dc.invisibleTyping.retry();
  assert.equal(r.dispatcher._interceptors.length, 1);
  r.dc.invisibleTyping.stop();
  assert.equal(r.dispatcher._interceptors.length, 0);
  assert.equal(r.dc.invisibleTyping.retry(), false);
  console.log(
    "PASS: outgoing typing suppression, untouched incoming/messages/stop events, defaults and channel exceptions, validation, detach and retry",
  );
}
{
  const r = setup({ late: true });
  assert.equal(r.dc.invisibleTyping.status().hook, false);
  r.late();
  r.tick();
  assert.equal(r.dc.invisibleTyping.status().hook, true);
  assert.equal(r.clearCount(), 1);
  vm.runInContext(source, r.context);
  assert.equal(r.dispatcher._interceptors.length, 1);
  console.log("PASS: deferred Metro discovery, bounded retry and duplicate-load cleanup");
}
{
  const r = setup({
    stored: JSON.stringify({ hide: false, channels: { [A]: true, bad: true, [B]: "invalid" } }),
  });
  await r.dc.invisibleTyping.ready;
  assert.equal(r.dc.invisibleTyping.hidden(B), false);
  assert.equal(r.dc.invisibleTyping.hidden(A), true);
  assert.equal(Object.keys(r.dc.invisibleTyping.status().channels).length, 1);
  r.dc.invisibleTyping.setChannel(B, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(r.writes.length);
  assert.equal(JSON.parse(r.writes.at(-1).value).channels[B], true);
  assert.equal(r.writes.at(-1).key, "nitracord.plugin.invisible-typing.v1");
  console.log(
    "PASS: persisted settings restore despite hook status updates; isolated validated writes",
  );
}
{
  let resolveLoad;
  const r = setup({
    load: new Promise((resolve) => {
      resolveLoad = resolve;
    }),
  });
  r.dc.invisibleTyping.setDefault(false);
  resolveLoad(JSON.stringify({ hide: true, channels: {} }));
  await r.dc.invisibleTyping.ready;
  assert.equal(r.dc.invisibleTyping.status().hide, false);
  console.log("PASS: delayed storage load cannot overwrite user changes");
}
{
  const r = setup({ stored: "not JSON" });
  await r.dc.invisibleTyping.ready;
  assert(r.dc.invisibleTyping.status().storage.includes("unavailable"));
  assert.equal(r.dc.invisibleTyping.status().hook, true);
  r.tool.open();
  const page = r.rendered.type();
  assert.equal(page.props.testID, "nitracord-invisible-typing-page");
  assert.equal(page.props.style.paddingTop, 28);
  const nodes = [];
  function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    nodes.push(n);
    walk(n.children);
  }
  walk(page);
  assert(nodes.some((n) => n.props.accessibilityLabel === "Hide typing by default"));
  assert(nodes.some((n) => n.props.accessibilityLabel === "Hide in this channel"));
  assert(nodes.some((n) => n.props.accessibilityLabel === "Refresh / retry hook"));
  r.setChannel(null);
  r.tool.open();
  const noChannel = [];
  function visit(n) {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== "object") return;
    noChannel.push(n);
    visit(n.children);
  }
  visit(r.rendered.type());
  const toggle = noChannel.find((n) => n.props.accessibilityLabel === "Hide in this channel");
  assert.equal(toggle.props.disabled, true);
  assert.equal(toggle.props.value, false);
  r.dc.ui.Page = function Page() {};
  r.dc.ui.Section = function Section() {};
  r.dc.ui.Row = function Row() {};
  r.dc.ui.colors = () => ({ background: "#101725", surface: "#202735" });
  const builderPage = r.rendered.type();
  assert.equal(builderPage.type, r.dc.ui.Page);
  assert.equal(builderPage.props.title, "Invisible Typing");
  assert.equal(builderPage.props.style.backgroundColor, "#101725");
  assert.equal(r.tool.author, "Nitracord");
  console.log(
    "PASS: storage failure stays explicit, themed in-app page, disabled current-channel control and attribution",
  );
}
