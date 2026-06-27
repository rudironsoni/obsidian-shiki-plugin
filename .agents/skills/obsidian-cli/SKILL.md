---
name: obsidian-cli
description: >-
  Use the Obsidian CLI to debug, inspect, and test the shiki-highlighter
  Obsidian plugin during development. Covers plugin reloads, console/errors,
  runtime evaluation, settings tab checks, reading-mode and live-preview syntax
  highlighting, screenshots, CDP, and mobile emulation with
  app.emulateMobile(true).
---
# Obsidian CLI For Shiki Highlighter

Use this skill to inspect a running Obsidian instance while developing `shiki-highlighter`. Prefix shell commands with `rtk` in this repo.

## Essentials

```bash
rtk obsidian plugin:reload id=shiki-highlighter
rtk obsidian dev:errors
rtk obsidian dev:console level=error
rtk obsidian commands filter=shiki-highlighter
rtk obsidian command id=shiki-highlighter:reload-highlighter
```

`plugin:reload` can return success even if plugin load threw. Always follow it with `dev:errors` or `dev:console level=error`.

## Runtime State

```bash
rtk obsidian eval code="app.plugins.plugins['shiki-highlighter'] !== undefined"
rtk obsidian eval code="JSON.stringify(app.plugins.plugins['shiki-highlighter'].settings, null, 2)"
rtk obsidian eval code="app.plugins.plugins['shiki-highlighter'].highlighter !== undefined"
rtk obsidian eval code="app.vault.getName()"
```

Open settings:

```bash
rtk obsidian eval code="app.setting.open(); app.setting.openTabById('shiki-highlighter')"
rtk obsidian dev:screenshot path=planning/test-reports/settings.png
```

## Syntax Highlighting Checks

Reading mode should render Expressive Code blocks:

```bash
rtk obsidian dev:dom selector="div.expressive-code" text
rtk obsidian dev:dom selector="div.expressive-code pre code" text
```

Live preview should show token styling in the editor:

```bash
rtk obsidian dev:dom selector=".cm-content [style*='color'], .cm-content [class*='shiki']" text
```

Inline highlighting should render only `{lang} code` inline spans:

```bash
rtk obsidian dev:dom selector=".shiki-inline" text
```

When screenshots are needed:

```bash
rtk obsidian dev:screenshot path=planning/test-reports/live-preview.png
```

## Mobile Emulation

Use the official Obsidian runtime API when possible. This executes mobile-guarded paths by setting `app.isMobile`:

```bash
rtk obsidian eval code="app.emulateMobile(true)"
rtk obsidian plugin:reload id=shiki-highlighter
rtk obsidian dev:screenshot path=planning/test-reports/mobile.png
rtk obsidian eval code="app.emulateMobile(false)"
```

If using CLI support, pass an explicit state and never rely on toggle behavior:

```bash
rtk obsidian dev:mobile on
rtk obsidian plugin:reload id=shiki-highlighter
rtk obsidian dev:mobile off
```

## CDP Escape Hatch

Prefer `eval`, `command`, and `dev:dom`. Use CDP only for precise clicks or key events:

````bash
rtk obsidian dev:cdp method=Input.dispatchMouseEvent params='{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}'
rtk obsidian dev:cdp method=Input.dispatchMouseEvent params='{"type":"mouseReleased","x":100,"y":200,"button":"left","clickCount":1}'
rtk obsidian dev:cdp method=Input.insertText params='{"text":"```cs\nvar x = 1;\n```"}'
````

## BRAT And Release Payload Checks

BRAT-style installs may only include `main.js`, `manifest.json`, and `styles.css`. Use the repo verifier for this path when possible:

```bash
rtk env OBSIDIAN_VERIFY_BRAT_INSTALL=true bun run verify:obsidian-real
```

For downloaded release assets:

```bash
rtk env OBSIDIAN_VERIFY_BRAT_INSTALL=true OBSIDIAN_VERIFY_PLUGIN_DIR=/tmp/shiki-release-assets bun run verify:obsidian-real
```

## Footguns

- The focused Obsidian window is the target. Confirm `app.vault.getName()` before destructive actions.
- `dev:mobile` or `app.emulateMobile(true)` persists until turned off or reset.
- CSS variable token colors are expected when the plugin uses the built-in Obsidian theme.
- A blank screenshot usually means the UI did not settle. Sleep briefly and inspect DOM before retesting.

## Resource Rules

- **One Obsidian instance only.** Never spawn a second. Before launching, check `lsof -i :9230` or the helper's `isObsidianRunning()` check.
- If an instance is already running, reuse it: reload the plugin, re-copy plugin files into the existing vault, reload the test note. Do not create a new vault, user-data-dir, or `--user-data-dir`.
- If you accidentally launch twice, kill the duplicate. Never leave orphan processes.
- `plugin:reload` is cheap and idempotent. Prefer it over relaunching Obsidian.
- Visual-test scripts must probe the CDP port first and skip `spawn()` when a target is alive.
