# Migration Plan: Switch to modern-monaco

## Executive Summary

Replace the current three-bundle architecture (main + highlighter + monaco-editor) with a single modern-monaco bundle that handles both reading mode (read-only) and editing mode (inline widget). modern-monaco bundles Monaco + Shiki + grammars into one package with automatic worker setup and Shiki theme support.

## Current Architecture

```
dist/
  main.js          (3.8MB)  — Plugin logic
  highlighter.js   (10MB)   — Shiki + Expressive Code for reading mode
  monaco-editor.js (3.7MB)  — Monaco editor for inline editing
  styles.css       (24KB)   — Shared styles
```

**Problems:**

- `@shikijs/monaco` crashes with `compileAG` on null (WASM textmate incompatibility)
- Expressive Code and Monaco use different renderers (visual inconsistency)
- Three separate bundles to maintain and load
- BRAT only copies `main.js`, requiring embedding hacks

## Target Architecture

```
dist/
  main.js          (~2MB)   — Plugin logic only
  modern-monaco.js (~15MB)  — Monaco + Shiki + all grammars
  styles.css       (~25KB)  — Shared styles
```

**Benefits:**

- Single Monaco renderer for both reading and editing (visual consistency)
- modern-monaco handles WASM workers safely (no `compileAG` crashes)
- Built-in Shiki theme support (no `@shikijs/monaco` integration needed)
- Automatic lazy loading of grammars
- No `MonacoEnvironment` setup required

## File Changes

### 1. Dependencies (`package.json`)

**Remove:**

- `monaco-editor-core`
- `@shikijs/monaco`
- `@expressive-code/*` packages (if no longer needed for inline code)
- `shiki` (if modern-monaco bundles it)

**Add:**

- `modern-monaco`

**Check:** Does modern-monaco re-export `shiki` utilities we need for inline highlighting? If not, keep `shiki`.

### 2. Build Pipeline (`vite.config.mts`)

**Current:** Three build entries (highlighter, monaco-editor, main)
**Target:** Two build entries (modern-monaco, main)

```typescript
// New entry file
const modernMonacoEntryFile = 'packages/obsidian/src/modern-monaco-entry.ts';

// Build modern-monaco bundle
SHIKI_BUILD_ENTRY=modern-monaco vite build --mode=production

// Build main (smaller, no embedded highlighter/monaco)
SHIKI_BUILD_ENTRY=main vite build --mode=production
```

**Remove:**

- `embeddedHighlighterCssFallbackPlugin`
- `embeddedMonacoCssFallbackPlugin`
- Expressive Code bundle plugin (if no longer used)
- `__SHIKI_EMBEDDED_*` defines

**Simplify:** `main.js` no longer needs to embed highlighter/monaco sources.

### 3. Modern-Monaco Entry (`packages/obsidian/src/modern-monaco-entry.ts`)

Create a new entry point that exports modern-monaco's API:

```typescript
// Re-export what the plugin needs
export { init, lazy, Workspace } from 'modern-monaco';
export type * from 'modern-monaco';
```

### 4. Monaco Loader (`packages/obsidian/src/codemirror/CodeBlockEditorWidget.ts`)

**Current:** Loads `monaco-editor.js` and `@shikijs/monaco` separately, then patches token providers.
**Target:** Uses `modern-monaco`'s `init()` API.

```typescript
import { init } from 'modern-monaco';

async function loadModernMonaco(): Promise<ModernMonacoRuntime> {
	// Option A: Load from CDN (default)
	const monaco = await init();

	// Option B: Load from local file (user-configurable)
	// const source = await plugin.app.vault.adapter.read(`${pluginDir}/modern-monaco.js`);
	// const monaco = await loadFromSource(source);

	return monaco;
}
```

**Theme integration:**

```typescript
// modern-monaco accepts Shiki theme IDs
monaco.editor.setTheme(plugin.loadedSettings.darkTheme);
```

### 5. Reading Mode (`packages/obsidian/src/CodeBlock.ts`)

**Current:** Uses `renderWithEc` (Expressive Code → HTML).
**Target:** Creates a read-only Monaco editor instance.

```typescript
private async render(metaString: string): Promise<void> {
  const monaco = await loadModernMonaco(this.plugin);
  const container = this.containerEl;
  container.empty();
  container.classList.add('shiki-readonly-codeblock');

  monaco.editor.create(container, {
    value: this.source,
    language: this.language,
    readOnly: true,
    theme: this.plugin.loadedSettings.darkTheme,
    minimap: { enabled: false },
    scrollbar: { vertical: 'hidden', horizontal: 'auto' },
    lineNumbers: this.plugin.loadedSettings.ecDefaultShowLineNumbers ? 'on' : 'off',
    wordWrap: this.plugin.loadedSettings.ecDefaultWrap ? 'on' : 'off',
    contextmenu: false,
    folding: false,
    automaticLayout: false,
    fontSize: this.plugin.loadedSettings.ecEditorFontSize || 14,
    fontFamily: this.plugin.loadedSettings.ecEditorFontFamily || 'var(--font-monospace)',
    lineHeight: this.plugin.loadedSettings.ecEditorLineHeight || 22,
  });
}
```

**Performance consideration:** Creating a Monaco instance per code block is expensive. For notes with 20+ code blocks, this could cause lag. Options:

- A) Render first 5 blocks immediately, lazy-load others on scroll
- B) Use a virtual list / intersection observer
- C) Accept the cost (modern-monaco is optimized for this)

**Recommendation:** Start with C (simplest), optimize with B if needed.

### 6. Inline Highlighting (`packages/obsidian/src/InlineCodeBlock.ts`)

**Current:** Uses `getHighlightTokens` (Shiki) + `renderTokens`.
**Target:** Use Monaco for inline too, or keep Shiki.

Option A (modern-monaco): Create tiny read-only Monaco instances for inline code. Overkill.
Option B (keep Shiki): Inline code is simple; Shiki's `codeToTokens` is fast and lightweight.

**Recommendation:** Keep Shiki for inline code (separate from modern-monaco). Inline code doesn't need an editor.

### 7. Plugin Main (`packages/obsidian/src/main.ts`)

**Remove:**

- `highlighter` field and `LazyHighlighter` usage
- `loadHighlighterEntry` imports
- Expressive Code post-processor registration
- Monaco embedding logic in `onload`

**Replace with:**

- `modernMonaco` field that lazy-loads modern-monaco
- `registerCodeBlockProcessors` creates read-only Monaco editors
- `registerCm6Plugin` creates inline Monaco editors

### 8. Settings (`packages/obsidian/src/settings/Settings.ts` + SettingsTab)

**Add settings:**

- `modernMonacoSource: 'cdn' | 'local'` — Where to load modern-monaco from
- `modernMonacoCdnUrl: string` — Custom CDN URL (default: esm.sh)

**Remove settings (if Expressive Code removed):**

- `ecDefaultFrame`
- Expressive Code-specific settings

**Keep settings:**

- `darkTheme`, `lightTheme` — Passed to modern-monaco
- `ecDefaultShowLineNumbers` — Passed to Monaco
- `ecDefaultWrap` — Passed to Monaco
- `ecEditorFontSize` — Passed to Monaco
- `ecEditorFontFamily` — Passed to Monaco
- `ecEditorLineHeight` — Passed to Monaco

### 9. CSS (`packages/obsidian/src/styles.css`)

**Remove:**

- Expressive Code styles (if no longer used)
- `.shiki-editing-codeblock-*` styles (replaced by Monaco)
- `.shiki-monaco-codeblock` styles (refined for modern-monaco)

**Keep/Add:**

- `.shiki-readonly-codeblock` — Container for read-only Monaco
- `.shiki-inline` — Inline code highlighting
- Fence hiding styles
- Mobile-specific styles

### 10. Highlighter (`packages/obsidian/src/Highlighter.ts`)

**If keeping Shiki for inline code:** Keep but simplify. Remove Expressive Code, keep `getHighlightTokens` and `renderTokens`.

**If removing Shiki entirely:** Delete. modern-monaco handles all highlighting.

### 11. Theme Mapper (`packages/obsidian/src/themes/ThemeMapper.ts`)

**Current:** Maps Shiki themes to Expressive Code themes.
**Target:** Pass theme IDs directly to modern-monaco. modern-monaco loads Shiki themes automatically.

```typescript
// modern-monaco handles theme loading
monaco.editor.setTheme(this.getThemeIdentifier());
```

For custom themes (JSON files), pass the JSON object to modern-monaco:

```typescript
monaco.editor.defineTheme(themeName, themeJson);
```

### 12. LazyHighlighter (`packages/obsidian/src/LazyHighlighter.ts`)

**If keeping Shiki for inline:** Simplify. Remove EC, keep tokenization.
**If removing Shiki:** Delete. modern-monaco handles all rendering.

## CDN vs Local Loading Strategy

### Default (CDN)

```typescript
import { init } from 'modern-monaco';
const monaco = await init({ cdn: 'https://esm.sh' });
```

Pros:

- Smaller plugin bundle (main.js ~2MB)
- modern-monaco.js loaded on demand
- Always latest grammars and themes

Cons:

- Requires internet connection
- CDN dependency (esm.sh)

### Local File

```typescript
const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
const source = await plugin.app.vault.adapter.read(`${pluginDir}/modern-monaco.js`);
// Load via Function constructor or import()
```

Pros:

- Works offline
- No CDN dependency

Cons:

- Larger initial download (~15MB modern-monaco.js)
- User must manage file updates

### Hybrid (Recommended)

1. Try CDN first (fast, no bloat)
2. If CDN fails or user prefers local, fall back to local file
3. Add setting: `modernMonacoSource: 'cdn' | 'local'`
4. Add command: "Download modern-monaco for offline use"

## Migration Path

### Phase 1: Add modern-monaco alongside existing code

- Install modern-monaco dependency
- Create `modern-monaco-entry.ts`
- Add new build entry
- Create parallel reading mode renderer using Monaco
- Add setting to toggle between Expressive Code and Monaco

### Phase 2: Stabilize and test

- Test all languages
- Test mobile
- Test theme switching
- Fix performance issues

### Phase 3: Remove legacy code

- Remove Expressive Code
- Remove `@shikijs/monaco`
- Remove `monaco-editor-core`
- Remove `highlighter.js` build
- Remove EC-specific settings

## Risk Assessment

| Risk                               | Severity | Mitigation                                             |
| ---------------------------------- | -------- | ------------------------------------------------------ |
| Monaco read-only per block is slow | High     | Use intersection observer, lazy-load off-screen blocks |
| modern-monaco CDN unavailable      | Medium   | Provide local file fallback + download command         |
| Custom themes break                | Medium   | Test custom theme JSON loading with modern-monaco      |
| Inline code still needs Shiki      | Low      | Keep Shiki as devDependency for inline only            |
| mobile performance                 | Medium   | Test on mobile, may need to disable Monaco on mobile   |
| Bundle size increase               | Low      | modern-monaco is ~15MB vs current ~14MB total          |
| modern-monaco API changes          | Medium   | Pin version, monitor releases                          |

## Open Questions

1. **Does modern-monaco support all Shiki bundled languages?** Need to verify `tm-grammars` coverage vs Shiki's `bundledLanguages`.
2. **How does modern-monaco handle custom themes?** Can we pass raw theme JSON, or must we register them via Shiki theme ID?
3. **What is the `modern-monaco/core` bundle size?** Might be smaller than full `modern-monaco` if we don't need LSP.
4. **Does modern-monaco support the `editor.create()` API fully?** The README says "You can also create a Monaco editor instance manually."
5. **How to handle inline code blocks?** Keep Shiki for inline, or does modern-monaco have a lightweight mode?

## Recommendation

Proceed with **Phase 1** (parallel implementation) to validate modern-monaco works in the Obsidian environment before removing Expressive Code. This minimizes risk while allowing early testing.
