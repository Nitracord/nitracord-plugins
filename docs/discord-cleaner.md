# Discord Cleaner

Preview and delete matching messages from a channel, server or your direct messages. Requires Nitracord runtime **0.0.1**.

Updated clients use the shared Nitracord bridge for the active account and selected channel/guild. Preview, ownership/permission checks and confirmed deletion remain in Cleaner. Older clients keep the existing context-discovery fallback.

## Install and open

Import [src/discord-cleaner.js](../src/discord-cleaner.js) through **Nitracord > Plugins** and restart the client. Open a chat, then tap the trash action in the header to open **Message cleanup**.

Importing the plugin does not delete messages. Deletion requires a preview and confirmation, and cannot be undone.

## Clean up messages

1. Choose **Channel**, **Server** or **All DMs**. Channel and server modes can use the current conversation or a pasted ID.
2. Set the author, date and text filters. **Only mine** and **Protect pinned messages** are the defaults.
3. Tap **Preview matches**. This reads message history and shows the scanned and matching counts without deleting anything.
4. Review the scope and count, then tap **Delete reviewed messages**. Confirm the deletion in the dialog.

Changing filters invalidates the preview. Starting another deletion requires a fresh preview; an old plan cannot be reused.

## Scope and filters

| Control                  | Behavior                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel                  | Scan one server channel or DM using its channel ID.                                                                                                                 |
| Server                   | Scan supported channels returned by Discord for the selected server.                                                                                                |
| All DMs                  | Scan available one-to-one and group DM conversations. Closed conversations may be absent.                                                                           |
| Whose messages           | **Only mine**, **Everyone**, or **Specific user** with an author user ID. Other authors are included only where the client confirms **Manage Messages** permission. |
| After date / Before date | Use `YYYY-MM-DD` in UTC. The after date starts at midnight; the before date includes the entire selected day.                                                       |
| Contains text            | Case-insensitive substring match against message text. An empty value accepts any text.                                                                             |
| Protect pinned messages  | Exclude pinned messages; enabled by default.                                                                                                                        |

Only ordinary messages and replies are eligible. Text matching does not search attachment names or file contents.

## Progress and controls

**Pause** suspends new work; **Resume** continues it. **Stop** prevents further requests from starting. A request already in progress may still finish. Closing an active cleanup asks whether to stop it.

Before each deletion, the plugin rereads the message from history and checks its author, filters and permission again. Missing or changed messages are skipped. An account change or a failed verification stops the operation. Messages already deleted are not restored by stopping.

The plugin waits between requests and follows Discord's rate-limit responses. Repeated rate limits or request failures stop the operation rather than continuing through the remaining messages.

## Limits and troubleshooting

- A preview contains at most **5,000 matching messages**. Narrow the scope or dates, or run another preview after completing a batch.
- Server scope uses the channels returned by Discord; it does not separately enumerate archived threads.
- If the current channel cannot be detected, open a chat and retry or paste its channel ID. Server mode needs a server channel or a server ID.
- If the signed-in session or required client modules are unavailable, reopen Discord and try again. A client change may require a plugin update.
- Deleted or inaccessible channels can be skipped during scanning. Review the status and skipped count rather than treating a preview as a complete account archive.

Filters and preview plans are kept for the current cleanup screen. Closing it discards the plan. Disable or remove the plugin in Nitracord and restart to unload it.

## Development

Run `node tests/discord-cleaner.test.mjs` from the plugins repository for mocked checks covering filters, permissions, confirmation, account changes, rate limits and request handling.
