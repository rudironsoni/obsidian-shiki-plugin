Run the complete release verification pipeline for `shiki-highlighter`.

## Phase 1: Local Gate

```bash
rtk bun run check
```

This runs: format check, build, lint, test, bench:startup, bench:startup:mobile.

Judge as failed if any step fails.

## Phase 2: Runtime Gate

```bash
rtk env OBSIDIAN_VERIFY_BRAT_INSTALL=true bun run verify:obsidian-real
```

Verifies:

- Plugin loads without errors
- Settings tab opens
- Reading mode renders Shiki blocks
- Live preview applies token styling
- Mobile emulation path works
- Load time under 50 ms

## Phase 3: Artifact Verification

Verify `dist/` contains:

- `main.js`
- `manifest.json`
- `styles.css`
- `highlighter.js` (if applicable)
- `monaco-editor.js` (if applicable)

Check manifest version matches `package.json` version.

## Phase 4: Report

Write `planning/test-reports/<YYYY-MM-DD-HH-MM>/RELEASE.md`:

```markdown
# Release Verification Report

## Phase 1: Local Gate

- bun run check: <pass/fail>
- Startup desktop: <ms>
- Startup mobile: <ms>

## Phase 2: Runtime Gate

- Obsidian verifier: <pass/fail>
- Desktop load: <ms>
- Mobile load: <ms>

## Phase 3: Artifacts

- dist/ contents: <verified/missing>
- Version consistency: <pass/fail>

## Verdict

<ship / hold>
```
