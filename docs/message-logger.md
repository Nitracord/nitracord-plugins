# Message Logger

Message Logger **0.0.1** keeps deleted messages visible in their chat position and saves the earlier text of edited messages. It requires Nitracord runtime **0.0.1** and the plugin loader.

Use a runtime build with **Nitracord message bridge API 1**, shown on the plugin page. Update the patcher and use **Update installed** to add the bridge to an existing client; importing the plugin alone does not install it. The bridge observes messages and chat rendering before Discord caches module references, and provides app-private storage. Older runtimes use a compatibility fallback whose availability depends on the Discord build. Existing fallback storage is not migrated into bridge storage.

## Install and open

Open **Nitracord > Plugins** and install **Message Logger** from the catalog, or import [`src/message-logger.js`](../src/message-logger.js) as a local file. Restart Discord, then use **Open plugin** on its installed entry.

The plugin page contains storage choices, history search, deleted/edited filters and **Clear history**. Confirmation appears within the page.

## In chat

- Deleted messages remain in their original position, with a **Deleted · date and time** label and red text.
- Earlier text versions appear in gray above the current message. Chat shows the five most recent earlier versions; the plugin page shows all retained versions.
- A message edited and then deleted retains both its gray edit history and its red deleted text.

Deletion and earlier-edit labels use Discord's smaller, muted subtext style. Earlier versions and the current message have no extra blank paragraph between them.

Edit and deletion labels show the date and time in your device's local timezone and date format, without ISO separators or milliseconds. Deletion labels use the time the logger observed the deletion. The history page uses the same readable format; saved timestamps remain in UTC.

Deleted rows are display-only. Holding one opens Discord's native action sheet with only **Force delete**, which removes that retained message from the local chat projection and logger history. Normal menu actions, including reactions, replies, editing, forwarding, copying, pinning and reporting, are blocked for retained deleted messages. Cached menu callbacks and reply shortcuts are guarded as well. Live and edited-but-not-deleted messages retain Discord's normal actions.

This requires a runtime with `messages.actions` support: update the patcher, use **Update installed**, and import the matching logger plugin. An older runtime only supplies the existing edit guard. The display copy includes a deletion label so Discord refreshes a cached row immediately; saved history keeps the original text.

Only messages already present in Discord's message cache can be captured. The logger handles single and bulk deletions and ignores local cleanup of pending messages. Repeated updates and embed-only changes do not create text history. It does not request older messages or prevent Discord from processing a deletion.

Restored messages stay within the loaded chat history window. Open the relevant channel and history range to see them. The plugin page reports whether it can read a loaded message from the live chat cache. It also shows counts for changes received, messages not in cache, chat updates and highlighted messages; these counters cover the current plugin session and contain no message content. If this Discord version's inline hook is unavailable, retained history is still accessible from the plugin page. Discord's edit-last-message shortcut excludes retained deleted messages. Recording remains available when a read-only client method prevents inline restoration.

## Storage

| Choice                        | Behavior                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove on close** — default | History lives in memory until Discord's process ends. Switching apps or locking the phone keeps the current session; Android may keep the process alive after leaving Discord.                                      |
| **Persistent**                | History is saved locally and restored after restarting Discord. Saves are queued after changes and flushed when the app goes into the background. An abrupt process termination can lose the latest unsaved change. |

Storage and settings are separate for each Discord account. Switching accounts or logging out clears the previous account's history from memory. Persistent history remains on the device for that account until cleared.

Your storage choice and persistent history survive replacing the plugin or installing an updated Nitracord APK over the existing app. Updating the plugin while Discord is running also preserves its current session history. **Remove on close** still clears session-only history when Discord's process ends, including a restart for an APK update.

If storage is not ready during startup, the logger retries restoration instead of selecting the default mode. It waits for saved history before allowing a storage-mode change or writing a new copy. A history read failure does not change your saved storage choice.

Switching back to **Remove on close** erases the saved history while preserving the current session's view. **Clear history** removes both the saved copy and the in-memory history for the current account. If storage fails, the page displays an error and does not claim that an unsuccessful erase completed. Clear saved history before removing the plugin if you want to erase it as well.

**Persistent history has no automatic message-count or total-size limit.** Available device storage is the practical limit. Records are saved in small journal pages, so the bridge's per-value storage limit does not cap the entire history. If a save fails, the plugin reports the error and keeps unsaved records in memory for retry; it does not delete older saved messages to make room. Clear history when you want to reclaim the space.

The live cache holds up to **10,000 messages** after successful saves. Startup loads up to 32 recent pages (at most 1,024 records); **Older saved messages** browses the remaining archive without loading all of it into memory. **Back to recent messages** returns to the live view. Search and filters apply to the current loaded page. Older saved messages remain on disk when they leave the live cache; inline restoration uses the messages currently loaded in that cache.

**Remove on close** keeps up to **10,000 messages** in memory and discards the oldest when that session limit is reached. Both modes keep **20 earlier edits per message**. Existing saved snapshots migrate automatically into the journal; the original snapshot is removed only after all of its pages have been saved successfully.

Persistent **Force delete** writes a removal marker, so the message stays absent after restart and while browsing older pages. It makes no Discord deletion request. Earlier journal snapshots remain on disk until **Clear history** erases the archive; Force delete is a logical removal, not secure erasure. Save failures remain visible on the logger page and can be retried.

## Captured information

Records contain message text, message/channel IDs, the author's ID and displayed name, timestamps, and attachment filenames and HTTPS URLs. Attachment files, embeds and media are not downloaded or archived; an old attachment URL may expire. Text is limited to 20,000 characters per version.

History stays on this device. The plugin performs no network requests and cannot recover messages or versions that disappeared before it observed them. Disabling the plugin stops future recording after restarting Discord.

## Development

Run `npm test` for capture, native row payload, storage, account-switching and cleanup checks. These checks use mocked client modules; inline appearance also needs verification on the target Discord version. Regenerate `catalog.json` with `node tools/build-catalog.mjs` after source changes, and publish the matching catalog and source together.
