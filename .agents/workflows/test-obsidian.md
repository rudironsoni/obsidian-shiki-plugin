---
description: 'Test Obsidian plugin on desktop, mobile, or both'
trigger: /test-obsidian
turbo: true
---
# Workflow: /test-obsidian

target = $ARGUMENTS

target not provided, default "both". Execute based on target:

**desktop**:

1. Run `bun run bench:startup` and capture output.
2. Run the runtime verifier or CDP harness against the existing Obsidian instance.
3. Check runtime errors.
4. Verify settings tab through runtime evaluation.
5. Verify reading mode: `document.querySelectorAll("div.expressive-code").length`.
6. Verify live preview: `document.querySelectorAll(".cm-content [style*='color'], .cm-content [class*='shiki']").length`.
7. Report desktop results.

**mobile**:

1. Run `bun run bench:startup:mobile` and capture output.
2. Use runtime/CDP evaluation: `app.emulateMobile(true)`.
3. Reload the plugin through the runtime harness.
4. Check runtime errors.
5. Verify mobile settings tab.
6. Verify mobile reading mode.
7. Verify mobile live preview.
8. Always run through runtime/CDP evaluation: `app.emulateMobile(false)`.
9. Report mobile results.

**both**: Run desktop phase first, then mobile phase.

**Report format**:

```text
## Test Results - <target>

- Startup time: <ms> (<pass/fail>)
- Plugin load: <pass/fail>
- Settings tab: <pass/fail>
- Reading mode: <pass/fail>
- Live preview: <pass/fail>
- Mobile emulation: <pass/fail> (if applicable)

Verdict: <ship / hold>
```
