# Invisible Typing

Import `src/invisible-typing.js` through Nitracord's Plugins page and restart the client. Requires runtime 0.0.1.

Updated clients use Nitracord's shared typing, selected-chat and scoped storage APIs. Existing settings migrate into the plugin's storage scope on first use. Older clients keep the dispatcher/storage compatibility path; update the installed runtime to enable the shared bridge.

The plugin hides outgoing typing by default and offers global and per-channel controls. Incoming typing, outgoing messages and typing-stop events continue through the dispatcher. Discovery retries for a bounded period; use Refresh / retry hook if the dispatcher becomes available later.

Preferences use compatible client storage under `nitracord.plugin.invisible-typing.v1`. If storage is unavailable, the page reports session-only settings. The plugin does not send network requests or store chat content or account tokens.

Disable or remove it in Nitracord and restart to unload it. Run `node tests/invisible-typing.test.mjs` for mocked regression checks; live hook coverage still needs device verification.
