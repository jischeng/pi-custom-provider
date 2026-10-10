# Runtime catalog validation and provider navigation

The reported `Configuration validation failed` error was reproduced with the installed Pi **0.85.1 bundled CLI** and the provider's actual list of **198 model IDs**, replayed through a local HTTP fixture in an isolated agent directory. The same batch passed under the previously pinned Pi 0.82.0, exposing a gap in the earlier tests.

The failure came from `/compat/thinkingFormat`. Pi 0.85.1 advertises models with `thinkingFormat: "baseten"`; this extension's manually copied enum rejected that format during draft discovery. The error was not caused by `pi-cache-graph` or an invalid credential.

The enum now is gone: `/compat/thinkingFormat` is an unconstrained string. `compat` already preserves unknown fields, and Pi owns the value set and validates it at request time, so the extension no longer maintains a copy that drifts from the hosting Pi version. The dependency/test baseline matches the installed Pi 0.85.1. The RPC launcher and tests resolve the package's public `bin.pi` entry rather than assuming an unbundled `dist/cli.js` path. OAuth uses the current SDK interaction type, which requires an abort signal.

After the fix, the same installed CLI and the same 198-model batch pass draft open, validation, editing, and discovery. No provider configuration or credential was changed. The diagnostic made only model-list GET requests; no model inference was performed. Automated regression tests use fake credentials and local fixtures.

Provider navigation now opens directly on the model list. The first selected row is the first model, so Enter opens that model immediately. Add/discover/select actions stay on this page. Provider fields and the authentication-method selector live under `Provider settings`; saved credentials have their own action. All rendering, searching and key handling remain Pi-owned.

Operation errors now include the operation title and unique field paths so a future failure does not lose its actionable context in the UI.

Validation covers the complete RPC/service/native-component suite, the updated PTY flow on the installed bundled CLI, strict frozen dependency installation, TypeScript, and package contents. The PTY test supports `PI_TEST_CLI=/absolute/path/to/pi/cli.js` to exercise a host installation explicitly instead of silently assuming its version matches the development dependency.

## Agent tool schemas must be object-rooted

The agent tool `provider_model_discover` (operation `model.discover`) used a top-level `Type.Union` for its input. Providers validate each function's `parameters` as a JSON Schema object and rejected the root `anyOf` (`Invalid schema for function 'provider_model_discover': null is not of type "object"`), so model preset discovery and recommendation could not run.

The operation now exposes a single object schema with optional `providerId`, `draftId`, and `revision` properties and resolves the target explicitly: a draft requires `draftId` plus `revision`, a provider requires `providerId`, and mixing both or omitting both returns `VALIDATION_ERROR`. Regression tests assert that every operation input schema has `type: "object"` and that preset application and recommendation still enrich model metadata while preserving the model ID.
