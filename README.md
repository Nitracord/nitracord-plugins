# Nitracord plugins

Repository: https://github.com/Nitracord/nitracord-plugins. Release **0.0.1**.

JavaScript extensions under `src/`. [catalog.json](catalog.json) lists versions, paths and SHA-256 hashes. Build integrated settings with the [page builder API](docs/settings-pages.md).

| Plugin                                      | Purpose                                                                        | Documentation                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| [Discord Cleaner](src/discord-cleaner.js)   | Preview and confirm bulk deletion with ownership/permission checks             | [Usage and filters](docs/discord-cleaner.md)   |
| [Invisible Typing](src/invisible-typing.js) | Outgoing typing suppression with global and per-channel settings               | [Usage and settings](docs/invisible-typing.md) |
| [Message Logger](src/message-logger.js)     | Deleted messages in red and earlier edits in gray, with optional saved history | [History and storage](docs/message-logger.md)  |

Use Nitracord runtime 0.0.1. Open **Nitracord > Plugins**, browse **Available plugins**, tap **Install**, then restart Discord. You can also import a local JavaScript file. Installed plugins have enable/disable and remove controls. Plugins run with the runtime's access. Cleaner performs no deletion on install; preview and confirmation are required.

Message Logger defaults to **Remove on close**. Open its plugin page to choose persistent storage or clear history. It records deletions and text edits observed while enabled; it cannot recover messages deleted before it was running.

The browser reads this repository's `main/catalog.json` and verifies downloads against its SHA-256 hashes. Publish the catalog and matching sources together. If the catalog is unavailable, existing plugins keep working and file import remains available.

To build a plugin, read [Creating plugins](docs/creating-plugins.md) and the [bridge API reference](docs/bridge-api.md). Start with the runnable [Channel Activity example](examples/channel-activity.js), or [Hello Nitracord](examples/hello.js) for a minimal metadata/logging example.

The shared bridge provides account/chat context, message events and rendering, typing controls and scoped storage. Cleaner uses its account/context API; Invisible Typing uses context, typing and settings storage; Message Logger uses messages, rendering, edit guards and storage. Older runtimes retain compatibility fallbacks. Updated capabilities require a client runtime update even when the version still reads 0.0.1.

Run `node tests/run.mjs` with Node 18+. Tests use mocked modules and do not operate a live account. Regenerate the catalog after source edits with `node tools/build-catalog.mjs`.

The repository uses one [LICENSE](LICENSE); included material is documented in [THIRD_PARTY.md](THIRD_PARTY.md). Runtime changes belong in `nitracord-patches`.

## Source style

Run `npm ci`, then `npm run format` or `npm run format:check` for JavaScript and JSON. Run `npm test` for module checks. Development tools are pinned in `package-lock.json`.
