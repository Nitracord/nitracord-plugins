# Creating Nitracord plugins

Nitracord loads enabled JavaScript plugins into the Discord Android client. Plugins use the global `Nitracord` object; the shared bridge handles client discovery before Discord caches module references.

Start with the runnable [Channel Activity example](../examples/channel-activity.js), then use the [bridge API reference](bridge-api.md). Runtime implementation and engine details live in [nitracord-patches](https://github.com/Nitracord/nitracord-patches/blob/main/docs/plugin-bridge.md).

## Prepare a client

1. Build or update Nitracord with the **plugin loader** and **Nitracord settings** selected.
2. Use an updated patcher and **Update installed** when adding bridge capabilities to an older client. Installing a plugin cannot install a missing runtime bridge.
3. Import a JavaScript file from **Nitracord > Plugins > Add plugin**, then restart Discord. Open its registered tool with **Open plugin**.

Runtime and plugin releases currently use **0.0.1**. Builds with that version can expose different capabilities, so check the methods you need rather than comparing the version string alone.

## File format

Distribute one plain JavaScript file with a metadata header:

```js
// ==NitracordPlugin==
// @name My Plugin
// @author Your name
// @version 0.0.1
// @description A short explanation of what this plugin does.
// @website https://github.com/your-name/your-plugin
// ==/NitracordPlugin==
(function (g) {
  "use strict";
  const dc = g.Nitracord;
  if (!dc || !dc.messages || typeof dc.messages.subscribe !== "function") {
    throw new Error("My Plugin requires an updated Nitracord message bridge");
  }
  // Register behavior here.
})(globalThis);
```

The header supports `@name`, `@author`, `@version`, `@description` and an optional HTTPS `@website`. A plugin does not need an npm package or a build step. If your source uses TypeScript, JSX or source modules, compile/bundle it into one plain JavaScript file first. The client does not provide Node's `require`, filesystem APIs or an ES-module import loader.

Use an IIFE to keep variables private. Reserve one clearly named property, such as `dc.myPlugin`, only if you need to expose a development API or replace an earlier instance on reload.

## Read account and chat context

```js
const accountId = dc.context.currentUser();
const { channelId, guildId } = dc.context.current();
```

IDs are strings. Missing context returns `null`; a direct message has no guild ID. Read context when an action runs, since the account or selected chat may have changed. Do not assume the account that opened your screen still owns a later asynchronous operation.

Use `dc.context` instead of repeatedly searching for user/channel stores. Feature-check it when supporting older clients. Never turn a missing bridge value into a guessed account or channel.

## Observe messages

```js
const unsubscribe = dc.messages.subscribe(function (event) {
  if (event.type !== "MESSAGE_CREATE" || !event.message) return;
  const channelId = event.message.channel_id || event.message.channelId;
  if (channelId !== dc.context.currentChannel()) return;
  // Update your own state. Leave the event and client record unchanged.
});
```

The observer runs before the client handles the action. It is synchronous: use it to capture a snapshot or update small local state, and perform asynchronous work afterward. Returning `true` does **not** block an action. Use the dedicated typing API for typing suppression.

`dc.messages.get(channelId, messageId)` reads an already cached message; it does not fetch history. A record can disappear after a deletion, so copy the fields you need while observing it. Keep client records and event objects immutable.

## Store settings

```js
const storage = dc.storage.scope("my-plugin");
async function loadSettings() {
  try {
    const saved = await storage.getItem("settings");
    return saved ? JSON.parse(saved) : { enabled: true };
  } catch (error) {
    dc.log("warn", "My Plugin settings could not be loaded");
    return { enabled: true };
  }
}
async function saveSettings(settings) {
  await storage.setItem("settings", JSON.stringify(settings));
}
```

Call these async helpers from your plugin's initialization or UI handlers and handle rejected saves. Storage values are strings or `null`; encode JSON yourself and validate it after decoding. Keep values below the 1 MiB UTF-8 limit. Serialize dependent writes and prevent an old read from overwriting a newer user change.

Scopes separate plugin keys, not Discord accounts. For account-specific data, use a key such as `settings:<accountId>`, skip writes when the account is unavailable, and reject stale work after account changes. All plugins share the client process; a scope is not a security sandbox.

## Control outgoing typing

```js
const stopSuppressing = dc.typing.suppress(function (channelId) {
  return settings.hideTyping === true && channelId === dc.context.currentChannel();
});
```

Only `TYPING_START_LOCAL` is suppressed. Incoming typing indicators, sent messages and local typing-stop actions continue normally. `dc.typing.stopLocal(channelId)` clears the current local typing state. Unsubscribe when your plugin stops; do not wrap the dispatcher independently when this API is available.

## Register a screen

For settings, prefer the [page builder](settings-pages.md) and its [runnable example](../examples/settings-page.js). It supplies Discord rows, shared controls, native/custom-theme colors and Back navigation. Use raw React Native content when a plugin needs a custom tool layout.

```js
const unregister = dc.registerTool({
  id: "my-plugin",
  title: "My Plugin",
  author: "Your name",
  version: "0.0.1",
  open() {
    const R = dc.React;
    const N = dc.Native;
    if (!R || !N || !N.View || !N.Text) throw new Error("Discord UI is not ready");
    const colors = dc.config.theme || {};
    const insets = dc.ui.safeInsets();
    dc.ui.present(R.createElement(N.View, {
      style: {
        flex: 1,
        padding: 20,
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 16,
        backgroundColor: colors.background || "#1c1d22",
      },
    }, R.createElement(N.Text, {
      style: { color: colors.text || "#f2f3f5", fontSize: 16 },
    }, "Hello from My Plugin")));
  },
});
```

Open a screen from the registered tool inside Discord's Nitracord settings. `ui.present` needs that page host; do not open UI during plugin startup. Use the client's React/React Native exports, theme colors and safe insets. Put React hooks inside a component function, and return cleanup functions from effects. `dc.ui.close()` returns to the parent page or closes the outer page.

The [Channel Activity example](../examples/channel-activity.js) includes a screen that updates from bridge events and cleans up its listener.

## Lifecycle and cleanup

Enabled scripts load after the main Discord bundle. The bridge's internal hooks are installed earlier, before client modules cache their dependencies. React Native exports or individual client stores can still be unavailable; feature-check them and handle `null` context.

Keep every disposer returned by `messages.subscribe`, `messages.render`, `typing.suppress`, `registerTool` and `patches.before/after`. A `stop()` function should call them, clear timers and remove UI listeners. Call the previous instance's `stop()` before replacing it during development. Registering a tool does not automatically register a plugin shutdown callback.

Enable/disable and removal changes apply fully after restarting Discord. Do not rely on a navigation event or JavaScript unload event to save important state. For settings/history, save changes deliberately and account for Android terminating the process.

## Advanced rendering and client internals

Use `messages.render(transform, project, editable)` only when you need native chat rendering or a display-only cache projection. Return fresh values when changing content; preserve unknown fields, cache methods, native arguments and return values. Keep rendering fast and test the target Discord build. Use the edit guard when adding a retained row that must be read-only. See [the reference](bridge-api.md#message-rendering).

`findModule` and `patches.before/after` remain available for capabilities the bridge does not expose. They access client internals that can change between Discord builds. Keep those fallbacks isolated, validate their shapes, and undo every patch. Internal properties such as `_creator`, `bridge.inspect`, `_nativeReply` and UI tokens are not plugin APIs.

## Test and distribute

- Run `npm test` and `npm run format:check` in this repository.
- Test the plugin on a phone: restart, switch chats/accounts, exercise missing data, disable/reload it, and verify cleanup. Mocked tests cannot confirm native appearance.
- Keep a local import under the same filename when updating it, so Nitracord replaces that installation.
- Add an official plugin to `tools/build-catalog.mjs`, then run `node tools/build-catalog.mjs` from the repository root. Publish `catalog.json` with its matching source files; changing source after generating a catalog invalidates its hash.
- Retain applicable licenses and attribution for reused code. This repository's current notices are in [THIRD_PARTY.md](../THIRD_PARTY.md).

Plugins run with the client's access. Store only what the feature needs, avoid logging message bodies or credentials, and do not make network calls during installation just to discover account state. The bridge supplies account/cache context without an account request.
