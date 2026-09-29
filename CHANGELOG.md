# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses Semantic Versioning. The initial public beta keeps version `0.1.0` without a prerelease suffix.

## [Unreleased]

### Added

- Public beta preparation for `0.1.0`, with GitHub CI on Node 22 and 24 and a local publication checklist.
- MIT license approved by the project owner.

- Working Prompt Improver extension with fixed shortcuts, isolated model invocation, cancellable loader, improved-only preview, secure global settings, model/thinking/rewrite-guidance/context configuration, status/reset commands, warnings, redaction, and automated tests.

### Changed

- Tested against Pi **0.99.1** and raised the supported minimum to that version. Direct provider calls now normalize contexts into Pi's transcript format before dispatch, preserving fixed protocol and rewrite guidance.
- Updated development dependencies to Pi 0.99.1 and Vitest 4.1.11. The current lockfile has no known npm audit vulnerabilities.
- Added package-discovery keywords and included the changelog and MIT license in the package. npm publication remains disabled; GitHub-tag installation is the initial distribution target.
- Contributor and privacy guidance live in the README instead of separate documents in the release package.

- Consolidated model resolution, capability inspection, settings transition planning, and isolated provider dispatch into one Improver model runtime module. Prompt Improver routes completion through Pi's composed provider seam instead of direct `@earendil-works/pi-ai/compat` calls.
- Model-default thinking uses a registered native extension provider's raw stream when one exists; otherwise it uses Pi's built-in `ModelRegistry.complete()` path. Model default fails closed when a legacy provider config registers a matching `streamSimple` overlay for the resolved model API; choose an explicit thinking level instead. Explicit thinking and Codex Fast mode use the composed provider paths appropriate to each request.
- Cursor SDK models (`cursor-sdk` API) fail closed for isolated prompt improvement because they share Pi's active session provider state.
- Model selection in settings reconciles dependent thinking and Fast mode in one explicit confirmation before a single atomic save. Compatible selections save immediately; cancellation preserves all previous settings.
- Loader and confirmation preview now render inside a Prompt Improver frame: a `borderAccent` box whose top border carries the live status (`Improved prompt · … · N chars (+Δ)` / `Improving prompt · model`) with primary/secondary/count color tiers, replacing the unbordered preview text and the generic bordered loader.
- Preview scroll state now renders as border arrows instead of the `Lines X–Y of Z` body row: `↑ N` at the right edge of the top border and `↓ N` at the right edge of the bottom border each show the hidden wrapped lines on that side, appear only while that side is clipped, and vanish when the body is fully visible. An arrow claims the border's right edge before the status label, shrinking the label budget; dropped status tiers still re-home inside the frame so the delta stays visible.
- Preview actions now render inside the bottom border (`↵ Replace · R ⌘I ^I Retry · Esc Keep`) instead of a body action bar. On narrow widths the border label degrades right-first — dropping `Retry`/`Keep` words, then the `Replace` word — and never drops a retry key; when even the glyph form exceeds the border budget the actions re-home to wrapped body rows. The scroll-key hint was removed because the border arrows communicate scrollability.
- Status labels now degrade in priority order on narrow widths (count, then thinking, then ellipsized model; primary last), and any dropped header part reappears on the first line inside the frame so the character-count delta is always displayed. The loader mirrors the same degradation and wraps detail rows instead of truncating them.
- All frame colors resolve from the user's Pi theme tokens, with a literal cyan fallback used only when the theme provides no border color. Wide-character text is measured by display width so the frame never misaligns.
- Model resolution now uses Pi's cached authenticated-model snapshot instead of refreshing the registry from extension startup, settings, status, or invocation paths.
- Model picker now uses fuzzy, case-insensitive search across provider, model ID, and display name.
- Thinking choices now reflect only selected model capabilities, and confirmation status shows effective thinking effort.
- Loader and confirmation preview now render above Pi's unchanged input box so original and improved prompts remain visible for comparison.
- Confirmation preview now supports repeated retries using `R` or either configured invocation shortcut (`Cmd+I`, `Ctrl+Shift+I`) with the same captured request inputs and unchanged original draft.
- Improver requests now use a fixed provider-agnostic transformation protocol: recent messages become labeled reference data, the draft receives collision-free boundaries, and custom settings control rewrite guidance without removing anti-answer rules.
- Improvement can now run while Pi is active using an invocation-time finalized context/model snapshot, modal key ownership, main-run-safe cancellation, and compare-before-replace protection; it remains replacement-only and never auto-submits steering.
- Added an OpenAI Codex-only Fast mode setting that requests Fast mode for generation and retries, reports it only when enabled, and preserves standard behavior when disabled.

### Fixed

- Raw thrown provider and credential errors no longer reach user notifications, where echoed drafts or rewrite guidance could leak.
- Cancellation immediately after authentication resolves no longer starts a provider request, including the microtask handoff between auth and dispatch.
- JSON syntax diagnostics no longer include excerpts from malformed private settings files.
- Failed setup no longer leaves the operation coordinator locked against subsequent invocations.
- Error redaction handles undefined and other values that JSON cannot serialize instead of throwing a second error.

- Top border now keeps its theme color on both sides of the styled status label: each border segment is colored separately, so the label's own ANSI resets can no longer strip color from the trailing dashes and corner.
- Actions now render as a single bottom bar that stays on one line inside the border and never wraps or truncates a retry key; the pre-frame stacked list is gone.
- Model output is sanitized before framing: escape sequences and control characters are stripped and tabs expanded, so raw ANSI in an improved prompt can no longer corrupt the frame.
- Re-homed status tiers, loader detail chips, the non-idle warning, re-homed action rows, and the footnote now wrap instead of truncating, and the loader re-homes dropped status tiers like the preview.
- Framed rows no longer overflow at degenerate sub-4-column widths.
- Prevented Prompt Improver from blocking Pi startup or trapping terminal input while setup, credential, or provider work is stalled.
- Prevented credential resolution that finishes after cancellation from starting a provider request.
