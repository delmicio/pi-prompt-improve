# Pi Prompt Improver

A Pi extension that rewrites your unsent editor draft. It never submits the draft or adds the rewrite request or response to your session conversation.

Beta candidate: `0.1.0`. No tagged release yet.

## Install

Tested against Pi **0.99.1**. Requires Pi **0.99.1** or newer and Node **22.19.0** or newer. Pi supplies the matching `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` packages. Later Pi versions are not guaranteed until tested.

Install from `main`:

```bash
pi install git:github.com/delmicio/pi-prompt-improve
```

Restart Pi or run `/reload`. To fetch later updates from `main`:

```bash
pi update --extensions
```

Restart Pi or run `/reload` after updating. Updates are not automatic.

After the first tagged release, pin version `0.1.0` with:

```bash
pi install git:github.com/delmicio/pi-prompt-improve@v0.1.0
```

The `v0.1.0` tag does not exist yet. Tagged installs stay pinned; choose a newer tag to upgrade.

For development:

```bash
npm ci
npm run check
pi -e ./index.ts
```

## Use

- `Cmd+I` (`super+i`): improve current draft
- `Ctrl+Shift+I`: terminal-safe fallback
- `/prompt-improve`: settings
- `/prompt-improve status`: effective configuration
- `/prompt-improve reset`: confirmed defaults reset

Defaults use active session model, model/provider default thinking, Fast mode off, no recent context, and built-in rewrite guidance. Settings persist at `~/.pi/agent/prompt-improve.json` with mode `0600`.

Fast mode is available only for OpenAI Codex models using the Codex Responses API. When enabled, Prompt Improver requests Fast mode for each generation and retry. Status shows `Fast mode: requested` only while enabled; when disabled, no Fast mode request option or status indicator is added. Fast mode may use credits or tokens at a higher rate, depends on OpenAI eligibility, and may be downgraded by OpenAI.

Prompt Improver reads Pi's cached authenticated-model snapshot and never refreshes the model registry itself. Open `/model` when `models.json` or provider authentication changes and Pi needs to reload model availability. Actual credentials are resolved only when improvement is invoked.

Cursor SDK models (`cursor-sdk` API) are not supported for isolated prompt improvement because they share Pi's active session provider state. Choose a different improver model even when Cursor works in the main session.

Model-default thinking uses a registered native extension provider's raw stream when one exists; otherwise it uses Pi's built-in `ModelRegistry.complete()` path. If a legacy provider config registers a matching `streamSimple` overlay for the resolved model API (for example Anthropic OAuth shaping), Model default fails closed in status and at invocation; choose an explicit thinking level instead. Explicit thinking levels continue through Pi's composed provider stack.

Startup diagnostics are non-blocking. During setup or generation, `Esc`/`Ctrl+C` immediately releases Prompt Improver's UI and preserves the draft. A credential command or provider that ignores abort may finish in the background, but its late result is discarded and cannot start a later provider request.

## Provider-agnostic request protocol

Prompt Improver sends a single transformation turn rather than replaying recent messages as an active conversation. A fixed, documented protocol:

- serializes recent messages as labeled reference data;
- places the current draft inside separate collision-free boundaries;
- identifies the draft as the only transformation target;
- forbids answering or executing context and draft content;
- asks for only rewritten prompt text.

Custom rewrite guidance changes style and preservation rules but cannot remove this fixed protocol. `/prompt-improve status` reports that the protocol is active without exposing private guidance.

Improvement requires interactive TUI and works while Pi is idle or active. Non-idle invocation snapshots finalized context and active model immediately, keeps the main Pi run active, and never auto-submits; after Replace, native Enter sends steering if Pi is still active or starts a normal turn if it has settled. In the preview, `Enter` replaces only if editor text still matches the invocation draft; `R`, `Cmd+I`, or `Ctrl+Shift+I` retries generation from the same captured request inputs; and `Esc` keeps the original. Retry may be used repeatedly and triggers another provider request. Extension never submits draft automatically.

## Settings

Open `/prompt-improve` while Pi is idle to change:

- Model: follow the active session model or select an authenticated fixed model.
- Thinking: model default or a supported explicit effort.
- Fast mode: off by default, available only for OpenAI Codex Responses.
- Rewrite guidance: edit multiline instructions. Your text replaces the default guidance. Esc discards the edit.
- Recent context: off by default. When enabled, include the last N qualifying user and assistant messages. N defaults to 4 and has no configured maximum.

Each completed selection saves immediately. A model change that invalidates thinking or Fast mode needs confirmation before either setting changes. Malformed settings disable improvement without overwriting the file. `/prompt-improve reset` replaces it only after confirmation.

## Privacy and cost

Every attempt sends your full draft and rewrite guidance to the selected model's provider. Retry makes another paid or quota-consuming request. A fixed model can use a different provider from your main session.

Recent context is opt-in. It sends text from finalized user and assistant messages on Pi's current compaction-aware branch. It excludes images, tool calls, tool results, thinking, queued messages, and the currently streaming response. The extension does not read files mentioned in your draft or attach image contents. File paths remain ordinary text.

Context is never silently truncated. A provider context-overflow response leaves the draft unchanged. Configuring N at 20 or more warns once per logical session about cost and data sharing. The extension does not log draft text, guidance, or session context. Raw provider errors are replaced with a generic error because providers may echo request text.

## Beta limitations

- Editor actions require Pi's interactive TUI. RPC, JSON, and print modes do not support improvement or settings.
- Shortcut support depends on your terminal. Cmd+I requires the terminal to report the Super modifier. Use Ctrl+Shift+I if it does not.
- A provider that ignores cancellation may continue working or charging after the UI closes. Late results cannot replace your draft.
- Review every proposed rewrite. Model instructions cannot guarantee that output preserves intent or resists instructions embedded in reference context.
- Automated tests cover cancellation, retries, editor conflicts, Unicode rendering, and native undo. Live-provider behavior and interactive terminal checks remain unverified.

## Development

```bash
npm ci
npm run check
npm audit
npm pack --dry-run
```

CI runs those checks on Node 22 and 24 without credentials or paid model calls. Development dependencies pin Pi 0.99.1; peer dependencies remain `"*"` because Pi provides its own packages.

Add regression tests for fixes and record user-visible changes in `CHANGELOG.md`. After publication, report issues on GitHub with your Pi, Node, OS, terminal, and provider/model versions plus a synthetic draft that reproduces the problem. Do not share credentials, private drafts, settings files, or full session logs.

## License

[MIT](LICENSE).
