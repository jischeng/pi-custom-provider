# Runtime catalog validation and provider navigation

The reported `Configuration validation failed` error was reproduced with the installed Pi **0.85.1 bundled CLI** and the provider's actual list of **198 model IDs**, replayed through a local HTTP fixture in an isolated agent directory. The same batch passed under the previously pinned Pi 0.82.0, exposing a gap in the earlier tests.

The failure came from `/compat/thinkingFormat`. Pi 0.85.1 advertises models with `thinkingFormat: "baseten"`; this extension's manually copied enum rejected that format during draft discovery. The error was not caused by `pi-cache-graph` or an invalid credential.

The enum now incorporates formats advertised by the hosting Pi catalog, in addition to the existing base formats. The dependency/test baseline matches the installed Pi 0.85.1. The RPC launcher and tests resolve the package's public `bin.pi` entry rather than assuming an unbundled `dist/cli.js` path. OAuth uses the current SDK interaction type, which requires an abort signal.

After the fix, the same installed CLI and the same 198-model batch pass draft open, validation, editing, and discovery. No provider configuration or credential was changed. The diagnostic made only model-list GET requests; no model inference was performed. Automated regression tests use fake credentials and local fixtures.

Provider navigation now opens directly on the model list. The first selected row is the first model, so Enter opens that model immediately. Add/discover/select actions stay on this page. Provider fields and the authentication-method selector live under `Provider settings`; saved credentials have their own action. All rendering, searching and key handling remain Pi-owned.

Operation errors now include the operation title and unique field paths so a future failure does not lose its actionable context in the UI.

Validation covers the complete RPC/service/native-component suite, the updated PTY flow on the installed bundled CLI, strict frozen dependency installation, TypeScript, and package contents. The PTY test supports `PI_TEST_CLI=/absolute/path/to/pi/cli.js` to exercise a host installation explicitly instead of silently assuming its version matches the development dependency.
