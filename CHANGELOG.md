# Changelog

All notable changes to this project are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-09-30

### Added

- Improve unsent drafts through `Cmd+I` or `Ctrl+Shift+I` using an isolated model request outside Pi's main conversation.
- Preview the rewrite above the original draft. Replace with `Enter`, retry with `R` or either shortcut, or keep the original with `Esc`. Replacement never submits and supports Pi's native undo.
- Cancel setup or generation with `Esc` or `Ctrl+C` without losing the draft. Improvement can run while the main Pi run continues.
- Configure active or fixed models, supported thinking levels, custom rewrite guidance, optional recent context, and OpenAI Codex Fast mode.
- Global settings with atomic saves and private file permissions. Malformed files remain untouched until a confirmed reset.
- `/prompt-improve` settings, status, and reset commands, with explicit confirmation for dependent model-setting changes.
- A fixed rewrite protocol that treats recent messages as reference data and the draft as the sole rewrite target. Custom guidance replaces only the default guidance.
- Compaction-aware, text-only context snapshots that exclude tools, images, thinking, queued messages, and streaming responses. Context is off by default and is never silently truncated.
- Native, theme-aware previews with Unicode character counts, scrolling indicators, and action hints that adapt to narrow terminals.
- Codex Fast mode requests captured across retries, with status reporting the requested tier rather than promising provider delivery.
- README instructions for installation, manual updates, and trying the extension without a saved installation. A GIF demo links to a sharper MP4.
- MIT license, 163 automated tests, and GitHub CI on Node 22 and 24. Supported minimums are Pi 0.99.1 and Node 22.19.0.

### Fixed

- Provider dispatch preserves rewrite guidance through Pi's transcript normalization and composed provider stack.
- Unsupported models, thinking levels, and Fast mode settings fail closed without silently falling back. Cursor SDK models are unsupported for isolated requests.
- Model-default thinking uses native provider streams or Pi's built-in completion path. Legacy `streamSimple` overlays without a native provider require an explicit thinking level.
- Cancellation after authentication cannot start a provider request. Failed setup releases the coordinator so later attempts can proceed.
- Draft conflicts prevent replacement of text changed during improvement. Late results after cancellation cannot replace the draft.
- Provider errors, credential errors, and malformed-settings diagnostics do not expose draft or guidance text. Redaction handles values that cannot be serialized.
- Output sanitization and display-width-aware rendering prevent control sequences and wide characters from corrupting the preview.
