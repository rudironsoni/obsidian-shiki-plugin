# Advanced Code Block Migration Plan v0.9.0

## Decisions Log

| #   | Decision                                                                                         | Date       |
| --- | ------------------------------------------------------------------------------------------------ | ---------- |
| 1   | Remove Monaco entirely, use direct Shiki                                                         | 2026-06-28 |
| 2   | Plugin ID: `advanced-code-block` (was `shiki-highlighter`)                                       | 2026-06-28 |
| 3   | Display name: `Advanced Code Block` (was `Shiki Highlighter`)                                    | 2026-06-28 |
| 4   | Version: `0.9.0` (was `0.8.0-beta.186`)                                                          | 2026-06-28 |
| 5   | Settings renamed: `showLineNumbers`/`wrapLines` (was `ecDefaultShowLineNumbers`/`ecDefaultWrap`) | 2026-06-28 |
| 6   | Keep backward-compatible BRAT: no (change the ID)                                                | 2026-06-28 |
| 7   | Script naming: `obsidian-advanced-codeblock-*` (abstract, not Monaco-specific)                   | 2026-06-28 |

## Completed

### Commit 1: Replace Monaco with Shiki

- Deleted Monaco files (`monaco/*`, `ModernMonacoLoader.ts`, `modern-monaco-entry.ts`, etc.)
- Created `ShikiHighlighter.ts`
- Rewrote `LivePreviewAdapter.ts` with `ShikiLivePreviewWidget`
- Rewrote `ReadingViewAdapter.ts` with Shiki token enhancement
- Cleaned `SourceModeAdapter.ts`
- Updated `Settings.ts` and `SettingsTab.ts`
- Rewrote `styles.css`
- Updated `package.json`, `vite.config.mts`
- Updated tests

### Commit 2: Fix line numbers, raw line hiding, reading mode header

- Fixed line number position (left side, before scroll container)
- Added `.shiki-editing-codeblock-closing-fence` class
- CSS: hide raw code lines and closing fence with `display: none`
- Reading Mode: added header and scroll wrapper

### Commit 3: Plugin rename v0.9.0 + Runtime script migration

- Renamed plugin ID: `shiki-highlighter` → `advanced-code-block`
- Renamed display name: `Shiki Highlighter` → `Advanced Code Block`
- Bumped version: `0.8.0-beta.187` → `0.9.0`
- Renamed settings: `ecDefaultShowLineNumbers`/`ecDefaultWrap` → `showLineNumbers`/`wrapLines`
- Deleted `obsidian-monaco-edit.mjs`
- Renamed 6 runtime scripts to `obsidian-advanced-codeblock-*`
- Rewrote all 6 scripts (Monaco→Shiki selectors, assertions, gestures)
- Updated all skills/rules/workflows that referenced old script names
- Build passes, all 39 tests pass

## Status: COMPLETE
