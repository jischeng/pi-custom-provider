# pi-custom-provider

English · [中文](README.zh-CN.md)

Manage custom providers, models, and credentials in **Pi 0.85.1** through a shared service with native terminal controls, programmatic RPC, and confirmed agent tools.

## Native terminal

```bash
pnpm install --frozen-lockfile
pnpm exec pi -e ./src/index.ts
```

Run `/provider-setup`. The English interface uses Pi's native `SelectList`, `Input`, `SettingsList`, `Container`, `Text`, `DynamicBorder`, editors and dialogs. Pi owns rendering, list navigation, search and the overlay stack; the extension only connects operations and switches focus between sections.

Opening a provider keeps its models and grouped actions in one window. Model IDs distinguish matching display names. Up/Down moves continuously through models and actions without switching sections. Typing searches both groups; Enter opens the selected item. Add model opens the complete model form (ID, name, API, context, output limits and other metadata). Confirming adds it to the unsaved provider draft; cancelling leaves no partial model. Closing a child dialog restores the provider window and its selection. Save changes explicitly writes the provider; discard does not write configuration.

Provider settings, discovery, model selection, credentials, save, discard and deletion are direct actions in the provider window. There is no extra Provider actions menu and no navigation metadata value column. Save the provider before configuring credentials. Validation failures appear in a native dialog above the current window.

The interface supports provider renaming, model selection with native search and scrolling, full model metadata including cost tiers, optional-field removal, compatibility settings, and write-only provider/model headers. Changes immediately synchronize with Pi. Switch the active model before renaming or deleting its provider or removing that model.

Pi's native credential input is visible; the interface tells you this and never prefills stored secrets. OAuth supports Pi authentication flows, JSON import, and explicit server-side file references. File-backed refresh updates the selected file. Logging in again, importing, or clearing credentials detaches an old file reference. Changing an endpoint, API, or authentication method detaches previous credentials and headers.

## Programmatic RPC

```bash
node bin/pi-extension-rpc.mjs -e ./src/index.ts --no-session
```

The package also exposes the generic `pi-extension-rpc` executable. It starts a real Pi RPC child process and adds extension operations while preserving native RPC commands. Stock `pi --mode rpc` does **not** implement the added commands.

Discover operations and their JSON Schemas:

```json
{"id":"catalog","type":"get_extension_operations"}
```

Invoke an operation directly:

```json
{"id":"list","type":"invoke_extension_operation","operation":"provider-manager/provider.list","arguments":{"limit":50},"requestId":"list-1"}
```

The response supplies a task ID. Events and task queries provide structured progress/results; cancellation and typed authentication responses are supported. Normal management operations never run the terminal workflow, ask UI questions, or invoke a model. The bridge also supports unrelated extensions through the same registration contract.

See the [RPC protocol and extension registration guide](docs/rpc.md).

## Agent tools

Agent tools expose safe provider/catalog queries, discovery, recommendation, and configuration changes. Writes require native user confirmation; environments without UI return `requires_user_action`. Tools cannot accept credentials, start login, write headers, or edit user-owned drafts.

All entry points share validation and revision checks. Persistence uses a file lock and atomic replacement. Results distinguish committed configuration from failed runtime synchronization; `runtime.sync` retries synchronization. Deleting a provider retains its credentials by default.

## Development

```bash
pnpm typecheck
pnpm test
pnpm pack:check
```

Tests use isolated directories, actual Pi processes, local HTTP fixtures, and fake OAuth credentials. Native terminal tests require Python 3 and PTY support.

- [Implementation and validation](docs/implementation.md)
- [Original design](docs/refactor-requirements.md)
- [Pi interface audit and corrections](docs/pi-0.85.1-interface-audit.md)

Pi upstream and Pixle are unchanged. No actual native client integration is claimed; clients can implement the documented generic protocol independently.

The UI consumes operation descriptors and results through a small client interface. Domain rules and persistence stay outside the UI; RPC and agent tools use the same operations. See [design and tradeoffs](docs/tui-refactor.md).
