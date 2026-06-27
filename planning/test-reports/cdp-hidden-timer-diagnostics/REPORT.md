# CDP hidden-page timer diagnostics

Date: 2026-06-23
Branch: feature/startup-performance-lazy-highlighter

## Finding

The reused Obsidian CDP target on port 9230 can report `document.visibilityState === "hidden"` even though it is the valid Obsidian app page and has `window.app`.

In that state, `Runtime.evaluate` with `awaitPromise: true` does not resolve expressions that depend on browser timers or animation frames:

- `new Promise(resolve => setTimeout(() => resolve(123), 100))` timed out from the Node-side watchdog.
- `new Promise(resolve => requestAnimationFrame(() => resolve(456)))` timed out from the Node-side watchdog.
- `Promise.resolve(789)` resolved immediately.

This explains the current verifier instability when long browser-side expressions include waits like:

```js
await new Promise(resolve => setTimeout(resolve, 100));
```

The renderer itself remains responsive to synchronous or microtask-only CDP evaluations; the issue is specifically timer-backed waits inside the hidden page.

## Impact

The following verifiers can fail by harness timeout before proving product behavior:

- `verify:obsidian-real`
- `verify:obsidian-monaco-edit`

The failure mode is not strong product evidence by itself because a trivial synchronous eval still succeeds against the same target.

## Recommended harness fix

Move waits out of browser-evaluated strings and into Node-side polling:

1. Browser expression performs one synchronous state read or one Obsidian API operation.
2. Node-side `delay()` or `waitFor()` controls wall-clock waiting.
3. Target selection should prefer the websocket target that proves `window.app?.workspace`, and should not iterate worker targets with long CDP timeouts.

This should turn current timeout failures into either passing runtime evidence or actionable product assertions.
