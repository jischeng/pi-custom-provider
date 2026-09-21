# Provider management: direct settings, shared operations

## Thesis

Replace the procedural menu wizard with a native settings editor. Provider and model operations belong to the domain; TUI, RPC, and agent tools are adapters over that contract. UI labels and errors are English.

## Confidence

High for the component and operation boundaries: Pi exports SettingsList, ExtensionEditorComponent, and BorderedLoader, and the existing RPC already executes the shared operations. Actual usability still needs the user's feedback; passing tests does not establish that every workflow is pleasant.

## The trap

The previous implementation treated “native” as “call select repeatedly.” That retained the wizard's structure and exposed implementation details such as optional drafts as seven menu steps. Keeping those menus is not a contract. Preserving saved configuration and using native components are real requirements.

## Clean target

- `domain/` owns configuration validation, draft revisions, discovery, credentials, writes, and runtime synchronization.
- `operations/` owns execution, results, cancellation, and interaction messages. Descriptors contain JSON schemas and no executable functions.
- `ui.ts` consumes an operation client and renders workflows from descriptors and results. It imports neither domain services nor file storage.
- `ui/components.ts` composes Pi components. SettingsList owns search, scrolling, values, nested settings, and key handling. ExtensionEditorComponent owns prefilled editing. No component subclass, renderer, border drawing, or key parser is implemented here.
- `ui/operations.ts` adapts local operations to native progress and authentication dialogs. RPC independently adapts the same definitions through `rpc/extension.ts`.

`ctx.ui.custom` is only the mounting API for existing Pi components. Its name does not imply a custom renderer. The complete Pi ModelSelectorComponent requires host-internal ModelRuntime/SettingsManager objects; it is not used as a fake draft-model selector.

## Frame-opening move

Zero-legacy thought experiment: starting today, this would be a settings editor with searchable models and explicit save, not a sequence of instructions that every client must imitate. Clients need business operations, not a description of which terminal button to press next.

## Delete / preserve / separate

- Delete the seven-action wizard, field-selection menu, manual pagination, and generic authentication advice after arbitrary discovery errors.
- Replace label-based menu dispatch with stable action identifiers.
- Show field values next to labels, retain cursor/search within a screen, and toggle boolean/model selections in place.
- Keep advanced JSON as an escape hatch for structured extension metadata; ordinary fields and known nested settings have controls.
- Preserve authoritative validation, explicit save, conflict handling, and user-controlled authentication.
- Separate pure screen code from operation execution and progress/authentication presentation. Never put business rules in native widgets.

## Options

| Option | Cost | Verdict |
| --- | --- | --- |
| Conservative path: translate and rearrange menus | Small change, same repeated navigation | Rejected |
| Clean target: native settings over a shared operation client | Replace UI orchestration and terminal tests | Implemented |
| Staged clean path: keep both interfaces temporarily | Two user flows and twice the behavior to maintain | Rejected; no caller requires the old wizard |

## What not to do

Do not copy Pi component source, import private UI state, handwrite ANSI/keyboard behavior, introduce a second validation layer in RPC, or add translation infrastructure for an unrequested locale. Do not modify personal credentials to make a UI test pass.

## First proof point

The real Pi PTY test creates a provider, searches directly for a model field, changes and reopens its prefilled editor, toggles reasoning, searches and deselects a model, and verifies save/discard/delete against the isolated config. Native component tests ensure pending edits finish before a save action can return and rejected edits restore the authoritative value. Independent real RPC tests must continue to pass without UI requests or model execution.

## Falsifier

This direction fails if a business operation needs a TUI session, the settings screen requires handwritten rendering/key handling, or edits appear saved before the domain accepts them. These conditions would require changing the boundary rather than adding a UI workaround. No irreversible deployment or data migration is required; personal configuration is not rewritten by the refactor.

## Payoff ledger

| Change | Price now | Concrete payoff | When visible |
| --- | --- | --- | --- |
| Delete the menu wizard | Replace orchestration and PTY steps | Search for a field and edit it directly while seeing its value | First edit |
| Use native searchable settings | Add the matching Pi TUI peer dependency | Scrolling, keyboard behavior, toggles and filtering come from Pi | Large model/provider lists |
| Depend on operation descriptors/results | Add a small local UI adapter | RPC clients execute CRUD and authentication independently of screens | Existing real RPC suite |
| Serialize pending screen edits | Explicit completion queue | Save cannot outrun a field update; rejected edits show stored values | Rapid input and validation failures |
| Restore English product copy | Update labels and assertions | Matches the existing Pi UI and the user's language preference | Reload |

## Validation result

35 tests pass, including real Pi RPC/PTY and native component lifecycle tests. Type checking, frozen dependency installation, package contents, and Git whitespace checks pass. Tests use isolated temporary homes, local HTTP fixtures, and fake credentials. No personal configuration or credentials were rewritten.
