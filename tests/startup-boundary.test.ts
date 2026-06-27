import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function read(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('startup module boundary', () => {
	test('settings tab is startup-safe', () => {
		const source = read('packages/obsidian/src/settings/SettingsTab.ts');

		expect(source).not.toContain("from 'shiki'");
		expect(source).not.toContain('from "shiki"');
		expect(source).not.toContain('@expressive-code/');
		expect(source).not.toContain('@codemirror/');
	});

	test('settings tab applies changes dynamically without a manual reload row', () => {
		const source = read('packages/obsidian/src/settings/SettingsTab.ts');

		expect(source).not.toContain('All setting changes require a reload of the highlighter');
		expect(source).not.toContain('Reload Highlighter');
		expect(source).toContain('saveSettingsAndReloadHighlighter');
	});

	test('default settings do not import theme mapper', () => {
		const source = read('packages/obsidian/src/settings/Settings.ts');

		expect(source).not.toContain('themes/ThemeMapper');
	});

	test('main does not statically import heavy rendering modules', () => {
		const source = read('packages/obsidian/src/main.ts');

		expect(source).not.toContain("from 'packages/obsidian/src/Highlighter'");
		expect(source).not.toContain("from 'virtual:ec-runtime'");
	});

	test('modern monaco loader falls back without Node require', () => {
		const source = read('packages/obsidian/src/ModernMonacoLoader.ts');

		expect(source).toContain('loadBundledModernMonacoSource');
		expect(source).toContain('native require is unavailable');
		expect(source).toContain('plugin.app.vault.adapter.read(adapterPath)');
		expect(source).toContain('source: await loadBundledModernMonacoSource(plugin, requireFn)');
		expect(source).not.toContain('??\n\t\trequire');
	});

	test('async CM6 decoration producers do not dispatch directly', () => {
		const cm6Plugin = read('packages/obsidian/src/codemirror/Cm6_ViewPlugin.ts');
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		const sourceMode = read('packages/obsidian/src/modes/SourceModeAdapter.ts');

		expect(cm6Plugin).toContain('scheduleDecorationRefresh');
		expect(cm6Plugin).toContain('Calls to EditorView.update are not allowed while an update is in progress');
		expect(livePreview).not.toContain('view.dispatch(this.view.state.update({}))');
		expect(sourceMode).not.toContain('view.dispatch(this.view.state.update({}))');
	});

	test('mobile Monaco taps route through the native Obsidian editor', () => {
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		const gestures = read('packages/obsidian/src/monaco/MonacoGestureRouter.ts');

		expect(livePreview).toContain('setNativeMobileInteraction');
		expect(livePreview).toContain('editor.setCursor(editorPosition)');
		expect(livePreview).toContain('editor.focus()');
		expect(livePreview).toContain('focusNativeEditor');
		expect(gestures).toContain('nativeInteraction?.placeCursor');
		expect(gestures).toContain('blurMonacoFocusTarget');
		expect(gestures).toContain('selectionController.selectWordAt');
		expect(gestures).toContain('this.selectionController.placeCursor(touch.clientX, touch.clientY)');
	});

	test('live preview adapter owns a single Monaco overlay root per editor view', () => {
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		const main = read('packages/obsidian/src/main.ts');

		expect(main).toContain('isCurrentInstance()');
		expect(livePreview).toContain('this.plugin.isCurrentInstance()');
		expect(livePreview).toContain('LIVE_PREVIEW_ADAPTER_OWNER');
		expect(livePreview).toContain('destroyed || !this.plugin.isCurrentInstance()');
		expect(livePreview).toContain('removeDuplicateBlockSurfaces');
		expect(livePreview).toContain('missingLineRetryCount');
		expect(livePreview).toContain('this.requestDecorationRefresh();');
		expect(livePreview).toContain("closest('.markdown-source-view.mod-cm6')");
		expect(livePreview).toContain("activeLeafView && 'contentEl' in activeLeafView");
		expect(livePreview).toContain("querySelectorAll('.shiki-monaco-overlay-root')");
		expect(livePreview).toContain('root.remove()');
	});

	test('source mode applies Shiki token offsets per source line', () => {
		const sourceMode = read('packages/obsidian/src/modes/SourceModeAdapter.ts');

		expect(sourceMode).not.toContain('highlight.tokens.flat(1)');
		expect(sourceMode).toContain('let lineOffset = 0');
		expect(sourceMode).toContain('block.codeFrom + lineOffset + token.offset');
		expect(sourceMode).toContain('this.plugin.highlighter.getTokenStyle(token)');
		expect(sourceMode).toContain('lineOffset += this.lineLength(block.code, lineOffset) + 1');
	});

	test('language listing is static and startup-safe', () => {
		const lazyRuntime = read('packages/obsidian/src/monaco/LazyMonacoRuntime.ts');
		const main = read('packages/obsidian/src/main.ts');
		const metadata = read('packages/obsidian/src/runtime/LanguageMetadata.ts');

		expect(lazyRuntime).toContain('getObsidianSafeLanguageNames');
		expect(main).toContain('getObsidianSafeLanguageNames()');
		expect(main).not.toContain('highlighter.obsidianSafeLanguageNames');
		expect(lazyRuntime).toContain('resolveLanguageAliasFromMetadata');
		expect(lazyRuntime).not.toContain('loadModernMonacoGrammars');
		expect(metadata).toContain('LANGUAGE_METADATA');
		expect(metadata).not.toContain('modern-monaco/shiki');
	});

	test('surface registry creates stable surfaces without loading Monaco runtime', () => {
		const registry = read('packages/obsidian/src/monaco/MonacoSurfaceRegistry.ts');
		const surface = read('packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts');

		expect(registry).toContain('getOrCreate(block: CodeBlockModel): MonacoCodeBlockSurface');
		expect(registry).toContain('new MonacoCodeBlockSurface(this.plugin, block)');
		expect(registry).not.toContain('monacoRuntime.load()');
		expect(surface).toContain('const runtime = await this.plugin.monacoRuntime.load()');
	});

	test('Monaco editor creation is isolated to MonacoCodeBlockSurface', () => {
		const files = [
			'packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts',
			'packages/obsidian/src/monaco/MonacoSurfaceRegistry.ts',
			'packages/obsidian/src/modes/ReadingViewAdapter.ts',
			'packages/obsidian/src/modes/LivePreviewAdapter.ts',
			'packages/obsidian/src/modes/SourceModeAdapter.ts',
			'packages/obsidian/src/codemirror/Cm6_ViewPlugin.ts',
			'packages/obsidian/src/LazyHighlighter.ts',
		];
		const createOwners = files.filter(file => read(file).includes('monaco.editor.create'));

		expect(createOwners).toEqual(['packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts']);
	});

	test('production source avoids console spam and unguarded debug globals', () => {
		const sourceFiles = [
			'packages/obsidian/src/main.ts',
			'packages/obsidian/src/LazyHighlighter.ts',
			'packages/obsidian/src/ModernMonacoLoader.ts',
			'packages/obsidian/src/modes/ReadingViewAdapter.ts',
			'packages/obsidian/src/modes/LivePreviewAdapter.ts',
			'packages/obsidian/src/modes/SourceModeAdapter.ts',
			'packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts',
			'packages/obsidian/src/monaco/MonacoGestureRouter.ts',
			'packages/obsidian/src/monaco/MonacoSelectionController.ts',
			'packages/obsidian/src/monaco/MonacoSurfaceRegistry.ts',
			'packages/obsidian/src/monaco/LazyMonacoRuntime.ts',
		];
		const violations = sourceFiles.flatMap(file => {
			const source = read(file);
			const matches = [...source.matchAll(/console\.(?:log|debug)\s*\(|globalThis\.__shiki[A-Za-z0-9_]*|window\.__shiki[A-Za-z0-9_]*/g)];
			return matches.map(match => `${file}:${match[0]}`);
		});
		expect(violations).toEqual([]);
	});
	test('live preview edit sync is scoped to fenced code content range', () => {
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		expect(livePreview).toContain('codeFrom: block.range.charFrom');
		expect(livePreview).toContain('codeTo: block.range.charTo');
		expect(livePreview).toContain('this.view.dispatch({ changes: { from: current.codeFrom, to: current.codeTo, insert: value } });');
		expect(livePreview).not.toContain('from: block.range.openingFence');
		expect(livePreview).not.toContain('to: block.range.closingFence');
	});
	test('desktop Live Preview activation routes through Monaco gesture router', () => {
		const router = read('packages/obsidian/src/monaco/MonacoGestureRouter.ts');
		const surface = read('packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts');
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		expect(surface).toContain('setActivationHandler');
		expect(livePreview).toContain('surface.setActivationHandler(point => void this.activateBlock(block.id, point));');
		expect(router).toContain('event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey');
		expect(router).toContain('Date.now() - this.lastTouchTime < 700');
		expect(router).toContain('this.onActivate?.({ clientX: event.clientX, clientY: event.clientY });');
	});

	test('editable Monaco input remains visible while readonly surfaces may hide IME textarea', () => {
		const css = read('packages/obsidian/src/styles.css');
		const imeRules = [...css.matchAll(/([^{}]*\.ime-text-area[^{}]*)\{/g)].map(match => match[1]);
		const selectors = imeRules.flatMap(rule =>
			rule
				.split(',')
				.map(selector => selector.trim())
				.filter(Boolean),
		);

		expect(selectors.length).toBeGreaterThan(0);
		expect(selectors.every(selector => selector.includes('.shiki-monaco-readonly'))).toBe(true);
		expect(selectors.some(selector => selector.includes('.shiki-monaco-active'))).toBe(false);
		expect(selectors.some(selector => selector === '.ime-text-area')).toBe(false);
		expect(
			selectors.some(selector => selector.includes('.markdown-source-view.mod-cm6.is-live-preview') && !selector.includes('.shiki-monaco-readonly')),
		).toBe(false);
	});

	test('live preview adapter avoids selection-only rebuild churn', () => {
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		expect(livePreview).toContain('private lastViewportKey');
		expect(livePreview).toContain('const viewportActuallyChanged = update.viewportChanged && viewportKey !== this.lastViewportKey');
		expect(livePreview).toContain('if (!update.docChanged && !viewportActuallyChanged)');
		expect(livePreview).toContain('this.lastViewportKey = viewportKey');
		expect(livePreview).not.toContain('if (update.viewportChanged || update.selectionSet)');
	});
});

test('settings language listing uses static metadata without loading modern Monaco', () => {
	const settingsTab = read('packages/obsidian/src/settings/SettingsTab.ts');
	const lazyRuntime = read('packages/obsidian/src/monaco/LazyMonacoRuntime.ts');
	const languageMetadata = read('packages/obsidian/src/runtime/LanguageMetadata.ts');

	expect(settingsTab).toContain('obsidianSafeLanguageNames');
	expect(settingsTab).not.toContain('ModernMonacoLoader');
	expect(settingsTab).not.toContain('loadModernMonacoRuntime');
	expect(settingsTab).not.toContain('modern-monaco');

	const methodStart = lazyRuntime.indexOf('async obsidianSafeLanguageNames()');
	expect(methodStart).toBeGreaterThanOrEqual(0);
	const methodEnd = lazyRuntime.indexOf('resolveLanguageAlias', methodStart);
	const methodSource = lazyRuntime.slice(methodStart, methodEnd);
	expect(methodSource).toContain('getObsidianSafeLanguageNames()');
	expect(methodSource).not.toContain('import(');
	expect(methodSource).not.toContain('ModernMonacoLoader');
	expect(methodSource).not.toContain('loadModernMonacoRuntime');
	expect(languageMetadata).toContain('getObsidianSafeLanguageNames');
	expect(languageMetadata).toContain('LANGUAGE_METADATA');
});

test('Monaco edit verifier uses Obsidian editor scroller API for outside note scroll', () => {
	const source = read('tests/runtime/obsidian-monaco-edit.mjs');

	expect(source).toContain('async function readObsidianNoteScrollState');
	expect(source).toContain('async function scrollObsidianNoteByApi');
	expect(source).toContain('app.workspace.activeEditor?.editor');
	expect(source).toContain('cm?.scrollDOM');
	expect(source).toContain('Obsidian editor scroller API did not scroll the note');
	expect(source).not.toContain('readOutsideNoteWheelPoint');
	expect(source).not.toContain('vertical wheel outside Monaco did not scroll the Obsidian note');
});

test('real Obsidian verifier bounds CDP evaluation waits', () => {
	const source = read('tests/runtime/obsidian-real.mjs');

	expect(source).toContain('Timed out opening CDP socket');
	expect(source).toContain('CDP_EVALUATE_TIMEOUT_MS');
	expect(source).toContain('Timed out evaluating CDP expression #');
	expect(source).toContain('verify:obsidian-real failed:');
	const evaluateStart = source.indexOf('async function evaluate');
	const evaluateEnd = source.indexOf('async function dispatchMouseClick', evaluateStart);
	const evaluateSource = source.slice(evaluateStart, evaluateEnd);

	expect(evaluateSource).not.toContain('const pending = new Map');
	expect(evaluateSource).not.toContain('pending.set(id');
});

test('Monaco gesture routing uses explicit horizontal intent and Obsidian note scrollers', () => {
	const router = read('packages/obsidian/src/monaco/MonacoGestureRouter.ts');
	const surface = read('packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts');
	const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
	const readingView = read('packages/obsidian/src/modes/ReadingViewAdapter.ts');

	expect(router).toContain('const isHorizontalIntent = event.shiftKey ? horizontalDelta !== 0 : Math.abs(horizontalDelta) > Math.abs(event.deltaY);');
	expect(router).toContain('if (!isHorizontalIntent)');
	expect(surface).toContain('setNoteScrollerProvider(noteScrollerProvider: (() => HTMLElement | null) | undefined): void');
	expect(surface).toContain('this.noteScrollerProvider?.() ??');
	expect(livePreview).toContain('surface.setNoteScrollerProvider(() => this.getNoteScroller());');
	expect(livePreview).toContain('private getNoteScroller(): HTMLElement | null');
	expect(livePreview).toContain('surface.hostEl.onclick = (event): void => {');
	expect(livePreview).toContain('void this.activateBlock(block.id, { clientX: event.clientX, clientY: event.clientY });');
	expect(livePreview).toContain('surface.hostEl.ontouchend = (event): void => {');
	expect(livePreview).toContain('widget: new LivePreviewMonacoWidget(block.id),');
	expect(livePreview).toContain('surface.attach(widget);');
	expect(livePreview).toContain("line.classList.toggle('shiki-editing-codeblock-line-hidden', hidden);");
	expect(livePreview).toContain('this.rebuildBlocks();');
	expect(livePreview).toContain("window.addEventListener('resize', this.handleScroll, { passive: true });");
	expect(livePreview).toContain("window.removeEventListener('resize', this.handleScroll);");
	expect(readingView).toContain('surface.setNoteScrollerProvider(');
	expect(readingView).toContain("container.closest<HTMLElement>('.markdown-preview-view, .view-content')");

	const styles = read('packages/obsidian/src/styles.css');
	expect(styles).toContain('-webkit-text-fill-color: transparent !important;');
	expect(styles).toContain('touch-action: none;');
	expect(styles).toContain('body.is-mobile .markdown-source-view.mod-cm6.is-live-preview .shiki-monaco-codeblock');
	expect(styles).toContain('overscroll-behavior-x: contain;');
});

test('Live Preview refreshes Monaco surfaces when editor mode toggles', () => {
	const cm6 = read('packages/obsidian/src/codemirror/Cm6_ViewPlugin.ts');
	const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');

	expect(livePreview).toContain('refreshForModeChange(): void');
	expect(livePreview).toContain('this.rebuildBlocks();');
	expect(livePreview).toContain('this.scheduleSync(0);');
	expect(livePreview).toContain('private readonly modeClassObserver: MutationObserver;');
	expect(livePreview).toContain('new MutationObserver(() => this.refreshForModeChange())');
	expect(livePreview).toContain('this.modeClassObserver.disconnect();');
	expect(cm6).toContain('this.livePreviewAdapter.refreshForModeChange();');
	expect(cm6).toContain("this.view.dom.closest('.markdown-source-view.mod-cm6.is-live-preview') !== null");
});

test('plugin refreshes editor integration after workspace mode/layout changes', () => {
	const main = read('packages/obsidian/src/main.ts');

	expect(main).toContain('const refreshEditorIntegration = debounce(');
	expect(main).toContain('() => {');
	expect(main).toContain('void this.updateCm6Plugin?.();');
	expect(main).toContain("this.registerEvent(this.app.workspace.on('layout-change', refreshEditorIntegration));");
	expect(main).toContain("this.registerEvent(this.app.workspace.on('active-leaf-change', refreshEditorIntegration));");
	expect(main).toContain("this.registerEvent(this.app.workspace.on('file-open', refreshEditorIntegration));");
	expect(main).toContain('const livePreviewModeObserver = new MutationObserver(');
	expect(main).toContain('mutations => {');
	expect(main).toContain(
		"livePreviewModeObserver.observe(this.app.workspace.containerEl.ownerDocument.body, { attributes: true, attributeFilter: ['class'], subtree: true });",
	);
	expect(main).toContain('this.register(() => livePreviewModeObserver.disconnect());');
	expect(main).toContain('const startEditorIntegrationSettle = (): void =>');
	expect(main).toContain('attempts >= 12');
	expect(main).toContain('this.registerInterval(interval);');
});
