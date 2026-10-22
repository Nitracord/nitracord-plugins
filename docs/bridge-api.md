# Plugin bridge API reference

Public API for Nitracord runtime **0.0.1**, bridge API **1**. Check each capability's presence and `apiVersion`: older builds also use version 0.0.1. To add runtime capabilities, update the patcher and update the installed client's runtime; importing a new plugin alone is insufficient.

For a complete plugin, see [Creating plugins](creating-plugins.md) and [Channel Activity](../examples/channel-activity.js). The runtime owns discovery and interception; plugins own their feature state and disposal.

## Context

| Method | Result |
| --- | --- |
| `context.currentUser()` | Active account ID, or `null`. No account request. |
| `context.current()` | `{ channelId, guildId }`; either field can be `null`. |
| `context.currentChannel()` | Selected channel/DM ID, or `null`. |
| `context.currentGuild()` | Selected channel's guild ID, or `null` for a DM/missing context. |

`context.apiVersion` is `1`. IDs are strings. Context is read live; it is not a subscription or an ownership guarantee for later work.

## Message events and cache

`messages.apiVersion` is `1`.

| Method | Result |
| --- | --- |
| `messages.subscribe(listener)` | Synchronous observer; returns an unsubscribe function. |
| `messages.currentUser()` | Account ID or `null`; equivalent to `context.currentUser()`. |
| `messages.get(channelId, messageId)` | Cached client record, or `null`. Does not fetch a message. |
| `messages.createRecord(raw)` | Hydrated client record. Throws if the record factory is unavailable. |
| `messages.repaint()` | Requests store updates; memoized rows still need changed display data. |
| `messages.status()` | `{ apiVersion, account, stores, events, chatUpdates, cacheReads, cacheHits }`. |
| `messages.canEdit(channelId, messageId)` | Whether registered plugin guards allow editing. Discord's own permissions still apply. |

Observers receive the original Flux action before store handlers. Do not mutate it. Listener failures are isolated and return values cannot block dispatch. Not every action is a message action; filter by `event.type`.

Common message actions:

| Action | Useful fields |
| --- | --- |
| `MESSAGE_CREATE` | `message` with `id`, `channel_id`, `author`, `content`. |
| `MESSAGE_UPDATE` | `message`; fields may be partial. Read/copy the cached version before the update is applied. |
| `MESSAGE_DELETE` | `id`, `channelId` or `channel_id`; local pending-message cleanup may include `local: true`. |
| `MESSAGE_DELETE_BULK` | `ids`, `channelId` or `channel_id`. |
| `LOAD_MESSAGES_SUCCESS` | `messages`, `channelId` or `channel_id`. Client builds can also use cached/local load actions. |
| `LOGOUT` | Clear account-specific in-memory state. The user store may still contain the outgoing account during this pre-store callback. |

Client payloads can change. Validate IDs, handle missing fields, and never assume a partial update contains a complete author or attachment record. The bridge does not retain history by itself.

## Message rendering

```js
const dispose = dc.messages.render(transform, project, editable);
```

- `transform(payload)` receives a decoded native chat payload and returns the original or a replacement. Both row arrays and object payloads can occur. The bridge handles Android JSON encoding and preserves native call arguments/return values.
- `project(cache, channelId)` is optional. Return the original cache or an immutable display projection. Preserve the client's cache interface and loaded-history boundaries. The edit-last-message shortcut reads the original live cache.
- `editable(channelId, messageId)` is optional. Return `false` to prevent editing a retained row. It affects the client edit predicate, edit actions and direct `MESSAGE_START_EDIT` dispatch. Return values other than `false` allow Discord's normal checks.
- `dispose()` removes all three registrations and requests a repaint.

Transform/projection errors are isolated. Never replay native incremental row operations to force a refresh: doing so can duplicate insertions. Change the display record instead, and keep saved originals separate. Native content nodes and row-diff behavior remain Discord-build dependent; verify appearance on a phone.

## Message actions

Check `typeof dc.messages.actions === "function"` before using this capability; earlier runtime builds also report API version 1.

```js
const disposeActions = dc.messages.actions((channelId, messageId) => {
  if (!isRetainedDeletion(channelId, messageId)) return null;
  return [{
    id: "my-plugin-remove-local",
    label: "Force delete",
    isDestructive: true,
    onPress: () => removeLocalCopy(channelId, messageId),
  }];
});
```

Return `null` to leave normal Discord actions available, `[]` to block every action, or an array of local action descriptors to replace the long-press menu. IDs, labels and callbacks are required. The bridge uses Discord's native simple action sheet and blocks the original menu/option handler, forwarding and reply entry points, editing, and direct reply/editor dispatches for restricted messages. It does not block incoming message updates or deletions. `messages.canInteract(channelId, messageId)` reports whether native actions remain unrestricted; it does not grant Discord permissions.

Menu callbacks recheck the current account and current policy before execution. Multiple policies intersect by action ID. A missing or failed native sheet leaves the original actions blocked. Catch asynchronous action failures and surface useful state in your plugin. Call `disposeActions()` when stopping the plugin.

## Scoped storage

```js
const storage = dc.storage.scope("my-plugin");
await storage.setItem("settings", JSON.stringify({ enabled: true }));
const raw = await storage.getItem("settings");
await storage.removeItem("settings");
```

`storage.apiVersion` is `1`; each method returns a promise. `getItem` resolves to a string or `null`. `setItem` accepts strings only. Read/write/erase failures reject and must be handled.

| Constraint | Allowed value |
| --- | --- |
| Namespace | 1–64 lowercase letters/digits/hyphens; first character must be a letter or digit. |
| Key | 1–160 letters, digits, underscores, dots, colons or hyphens. |
| Value | At most 1 MiB measured as UTF-8 per value. Split larger datasets into pages and serialize dependent writes; handle interrupted updates before advancing an index. |

Supported React builds use Nitracord's serial, atomic app-private storage. Optimized builds use Discord's persistent storage under a Nitracord/plugin prefix, with a compatible AsyncStorage adapter for older clients. The current storage adapter waits for initialization, reads from disk rather than a synchronous cache, and verifies writes and erasures before reporting success. Backend choice is an implementation detail; plugins use the same API. Scope is not account isolation or a sandbox. Include the current account ID in keys when needed, and validate restored data before using it.

## Typing

`typing.apiVersion` is `1`.

| Method | Behavior |
| --- | --- |
| `typing.suppress(predicate)` | Calls `predicate(channelId)` for outgoing `TYPING_START_LOCAL`. `true` suppresses that action; returns a disposer. |
| `typing.stopLocal(channelId)` | Dispatches local typing-stop state; returns `false` for invalid IDs or an unavailable dispatcher. |
| `typing.status()` | `{ available, suppressors }`. Availability can become true after client discovery. |

Suppression is synchronous and scoped to local typing-start actions. Incoming typing, sent messages and local stop events are preserved. A failed predicate does not suppress the action. Disposing a registration restores behavior unless another active suppressor still blocks it.

## Tools, UI and diagnostics

| API | Behavior |
| --- | --- |
| `registerTool({ id, title, open, author?, version?, website? })` | Adds a plugin tool; returns a disposer. Use a stable, unique ID. |
| `React`, `Native` | Captured client React and React Native exports; may be unavailable before their modules load. |
| `ui.present(element)` | Opens a child page in the Discord Nitracord page host. Call from a tool's `open`. |
| `ui.close()` | Returns to the parent page, or closes the outer page. |
| `ui.apiVersion` | Shared page builder API version, currently `1`. |
| `ui.createPage(definition)` | Creates a React component from a page definition or a render callback returning one. See [settings pages](settings-pages.md). |
| `ui.Page`, `ui.Section`, `ui.Row`, `ui.Field`, `ui.Text` | Shared components for custom settings layouts. Native rows/groups and controls have compatible fallbacks. |
| `ui.colors()` | Fresh palette using Discord semantic colors and the active custom theme. No React hook required. |
| `ui.safeInsets()` | `{ top, bottom }` for page padding. |
| `ui.Header({ title, onBack? })` | React component for a settings page header with a back arrow. Defaults to `ui.close`. Keep it outside the scroll view and inside your safe-inset page. |
| `ui.Switch({ value, onValueChange, disabled?, accessibilityLabel? })` | React component using Discord's loaded `FormSwitch`, with a compact fallback. Use this for plugin switches instead of the platform switch. |
| `ui.Radio({ selected, disabled? })` | Noninteractive radio indicator using Discord's loaded `FormRadio`. Place it at the right of a pressable row with `accessibilityRole: "radio"`, a label, and `accessibilityState: { checked, disabled }`. Handle selection on the row. |
| `ui.setBackHandler(handler)` | Overrides the current page's Back handler; clear with `null` when appropriate. |
| `config.theme` | Active theme colors; supply defaults for missing tokens. |
| `log(level, ...values)` | Use `info`, `warn` or `error` for bounded session diagnostics with redaction. Do not log sensitive payloads. |
| `diagnostics.entries()` | Copies up to 100 retained entries: `{ id, time, level, message }`; `time` is ISO UTC and messages are redacted. |
| `diagnostics.subscribe(listener)` | Change notifications for new entries and Clear; returns a disposer. Fetch a fresh snapshot from `entries()`. |
| `diagnostics.clear()` | Clears the session buffer and notifies subscribers. |

The Logs page displays timestamps in device local time. Its live/pause control affects the viewer, while collection continues within the same 100-entry bound. Session entries reset on client restart. Startup logs identify plugins by their metadata names rather than private installation filenames.

`findModule(predicate)` returns a matching loaded client export or `null`; it does not import arbitrary files. Prefer the public bridge. For uncovered internals, `patches.before(object, key, callback)` can return replacement arguments, and `patches.after(object, key, callback)` returns the function's final result from its callback `(args, result)`. Both preserve `this` and return a disposer. Keep and call that disposer; return the original result when observing an `after` call.

## Current first-party usage

| Plugin | Shared APIs |
| --- | --- |
| Discord Cleaner | Account and selected channel/guild context; its existing preview/permission/request checks remain in the plugin. |
| Invisible Typing | Context, outgoing typing suppression, local typing-stop and scoped settings storage. Existing settings migrate on first use. |
| Message Logger | Message events/cache/projection, native row transforms, edit guards and scoped account-specific storage. |

First-party plugins retain compatibility paths for older runtimes. New plugins can require the capabilities they need and show a clear update requirement instead of duplicating client-store discovery.
