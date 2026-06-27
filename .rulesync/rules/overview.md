---
root: true
targets:
  - '*'
globs:
  - '**/*'
---
<!-- headroom:rtk-instructions -->

# RTK (Rust Token Killer) - Token-Optimized Commands

When running shell commands, **always prefix with `rtk`**. This reduces context
usage by 60-90% with zero behavior change. If rtk has no filter for a command,
it passes through unchanged — so it is always safe to use.

## Key Commands

```bash
# Git (59-80% savings)
rtk git status          rtk git diff            rtk git log

# Files & Search (60-75% savings)
rtk ls <path>           rtk read <file>         rtk grep <pattern>
rtk find <pattern>      rtk diff <file>

# Test (90-99% savings) — shows failures only
rtk pytest tests/       rtk cargo test          rtk test <cmd>

# Build & Lint (80-90% savings) — shows errors only
rtk tsc                 rtk lint                rtk cargo build
rtk prettier --check    rtk mypy                rtk ruff check

# Analysis (70-90% savings)
rtk err <cmd>           rtk log <file>          rtk json <file>
rtk summary <cmd>       rtk deps                rtk env

# GitHub (26-87% savings)
rtk gh pr view <n>      rtk gh run list         rtk gh issue list

# Infrastructure (85% savings)
rtk docker ps           rtk kubectl get         rtk docker logs <c>

# Package managers (70-90% savings)
rtk pip list            rtk pnpm install        rtk npm run <script>
```

## Rules

- In command chains, prefix each segment: `rtk git add . && rtk git commit -m "msg"`
- For debugging, use raw command without rtk prefix
- `rtk proxy <cmd>` runs command without filtering but tracks usage

## Resource Rules

- **One Obsidian instance only.** Never spawn a second. Before launching, check `lsof -i :9230` or the helper's `isObsidianRunning()` check.
- If an instance is already running, reuse it: reload the plugin, re-copy plugin files into the existing vault, reload the test note. Do not create a new vault, user-data-dir, or `--user-data-dir`.
- If you accidentally launch twice, kill the duplicate. Never leave orphan processes.
- `plugin:reload` is cheap and idempotent. Prefer it over relaunching Obsidian.
- Visual-test scripts must probe the CDP port first and skip `spawn()` when a target is alive.
  <!-- /headroom:rtk-instructions -->
