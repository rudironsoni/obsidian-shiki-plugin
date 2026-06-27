---
name: plugin-test
description: >-
    Acceptance test workflow for the obsidian-shiki-plugin Obsidian plugin. Use
    when the user asks to test the plugin, smoke test a release, verify before
    release, test BRAT/mobile installs, validate syntax highlighting, or judge
    whether startup and rendering still work. Uses local checks first, then
    Obsidian CLI/runtime checks, then release-asset or BRAT-style verification.
    Does not spend API tokens and does not commit source changes.
metadata:
    author: obsidian-shiki-plugin
    version: '1.1'
---

# Shiki Plugin Acceptance Test

Use this skill for release-level verification of `shiki-highlighter`. Keep the bar high: startup under 50 ms, Shiki highlighting working in reading mode and live preview, settings tab available, desktop and mobile paths covered.

## Guardrails

- Do not run against a production vault unless the user explicitly asks. Prefer a disposable test vault.
- Do not modify source code or commit while executing this skill. Reports may be written under `planning/test-reports/`.
- Treat screenshots as evidence, but also inspect DOM/style state. A screenshot alone is not enough when debugging highlight failures.
- Always turn mobile emulation off after mobile checks.
- If any check is skipped, say so in the report.

## Pass 0: Scope

1. Read `manifest.json`, `package.json`, and relevant recent commits or release notes.
2. Identify changed surfaces since the last tag with `git log <last-tag>..HEAD --oneline` when a tag exists.
3. Build a short checklist covering startup, settings, reading mode, live preview, inline code, custom themes/languages if touched, BRAT/release payloads if release work changed, and mobile emulation.

## Pass 1: Local Gate

Run the repo's own checks first:

```bash
rtk bun run check
```

For targeted changes, also run focused tests before the full gate, for example:

```bash
rtk bun test tests/startup-plugin.test.ts tests/render-children.test.ts
rtk bun run typecheck
```

Judge Pass 1 as failed if formatting, build, lint, tests, or startup benches fail. Record desktop and mobile-emulation startup numbers from `bench:startup` and `bench:startup:mobile`.

## Pass 2: Runtime Gate

Prefer the repo verifier when available because it creates an isolated vault and checks both desktop and `app.emulateMobile(true)` paths:

```bash
rtk env OBSIDIAN_VERIFY_BRAT_INSTALL=true bun run verify:obsidian-real
```

When verifying a downloaded release payload, set `OBSIDIAN_VERIFY_PLUGIN_DIR` to the directory containing `main.js`, `manifest.json`, and `styles.css`:

```bash
rtk env OBSIDIAN_VERIFY_BRAT_INSTALL=true OBSIDIAN_VERIFY_PLUGIN_DIR=/tmp/shiki-release-assets bun run verify:obsidian-real
```

The runtime gate must verify:

- Plugin loads without `dev:errors`.
- `app.plugins.plugins['shiki-highlighter']` exists.
- Settings tab for `shiki-highlighter` can be opened.
- Reading mode renders one Shiki/Expressive Code block per fenced block, with no duplicate original block.
- Live preview applies Shiki token styling to fenced code and inline `{lang} code` without scrambling positions.
- `app.emulateMobile(true)` path works and then returns to normal mode.
- Plugin load time remains under 50 ms.

## Pass 3: Obsidian CLI Visual Pass

Use this when screenshots or manual visual evidence are needed. First use the `obsidian-cli` skill. Confirm the focused vault before any destructive command:

```bash
rtk obsidian eval code="app.vault.getName()"
rtk obsidian plugin:reload id=shiki-highlighter
rtk obsidian dev:errors
rtk obsidian eval code="app.setting.open(); app.setting.openTabById('shiki-highlighter')"
rtk obsidian dev:screenshot path=planning/test-reports/<run>/settings.png
```

For mobile emulation, prefer the official runtime API or CLI equivalent:

```bash
rtk obsidian eval code="app.emulateMobile(true)"
rtk obsidian plugin:reload id=shiki-highlighter
rtk obsidian dev:screenshot path=planning/test-reports/<run>/mobile-live-preview.png
rtk obsidian eval code="app.emulateMobile(false)"
```

Inspect selectors:

```bash
rtk obsidian dev:dom selector="div.expressive-code" text
rtk obsidian dev:dom selector=".shiki-inline" text
rtk obsidian dev:dom selector=".cm-content [style*='color'], .cm-content [class*='shiki']" text
```

## Report Shape

Write `planning/test-reports/<YYYY-MM-DD-HH-MM>/REPORT.md`:

```markdown
# Shiki plugin acceptance test

## Scope

- Version: <manifest version>
- Commit: <sha>
- Payload: local dist / release tag / BRAT-style assets

## Pass 1

- bun run check: pass/fail
- startup desktop: <ms>
- startup mobile emulation: <ms>

## Pass 2

- real Obsidian verifier: pass/fail/skipped
- desktop plugin load: <ms>
- mobile plugin load: <ms>

## Visual Findings

| Surface                   | Verdict   | Evidence       |
| ------------------------- | --------- | -------------- |
| Reading mode fenced block | pass/fail | screenshot/DOM |
| Live preview fenced block | pass/fail | screenshot/DOM |
| Mobile emulation          | pass/fail | screenshot/DOM |

## Recommendation

ship / hold, with reason
```

## Failure Modes

- BRAT installs only `main.js`, `manifest.json`, and `styles.css`; verify that path explicitly.
- Branch `manifest.json` must match the release tag BRAT should install.
- `plugin:reload` can report success even when `onload` threw; always follow with `dev:errors`.
- Mobile emulation persists; always disable it at the end.
- Obsidian theme colors may be CSS variables by design when using the built-in Obsidian theme. Do not fail solely because token styles use `var(--shiki-code*)` unless the requested theme should be a bundled Shiki theme.
