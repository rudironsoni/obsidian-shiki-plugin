---
description: 'Test Obsidian plugin on desktop, mobile, or both'
---

target = $ARGUMENTS

If target is not provided, default to "both".

Execute the following based on target:

**desktop**:

1. Run `bun run bench:startup` and capture output
2. Use obsidian-cli MCP: `plugin:reload id=shiki-highlighter`
3. Check `dev:errors`
4. Verify settings tab: `eval code="app.setting.open(); app.setting.openTabById('shiki-highlighter')"`
5. Verify reading mode: `dev:dom selector="div.expressive-code" text`
6. Verify live preview: `dev:dom selector=".cm-content [style*='color'], .cm-content [class*='shiki']" text`
7. Report desktop results

**mobile**:

1. Run `bun run bench:startup:mobile` and capture output
2. Use obsidian-cli MCP: `eval code="app.emulateMobile(true)"`
3. `plugin:reload id=shiki-highlighter`
4. Check `dev:errors`
5. Verify mobile settings tab
6. Verify mobile reading mode
7. Verify mobile live preview
8. Always run: `eval code="app.emulateMobile(false)"`
9. Report mobile results

**both**:
Run desktop phase first, then mobile phase.

**Report format**:

```
## Test Results — <target>

- Startup time: <ms> (<pass/fail>)
- Plugin load: <pass/fail>
- Settings tab: <pass/fail>
- Reading mode: <pass/fail>
- Live preview: <pass/fail>
- Mobile emulation: <pass/fail> (if applicable)

Verdict: <ship / hold>
```
