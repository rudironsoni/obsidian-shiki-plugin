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

	test('main does not eagerly load settings during Obsidian startup', () => {
		const source = read('packages/obsidian/src/main.ts');
		const onload = source.match(/async onload\(\): Promise<void> \{[\s\S]*?\n\t\}/)?.[0] ?? '';

		expect(onload).not.toContain('await this.ensureSettingsLoaded()');
		expect(onload).not.toContain('this.ensureSettingsLoaded()');
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

	test('live preview adapter owns a single widget overlay per editor view', () => {
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		const main = read('packages/obsidian/src/main.ts');

		expect(main).toContain('isCurrentInstance()');
		expect(livePreview).toContain('this.plugin.isCurrentInstance()');
		expect(livePreview).toContain('LIVE_PREVIEW_ADAPTER_OWNER');
		expect(livePreview).toContain('destroyed || !this.plugin.isCurrentInstance()');
		expect(livePreview).toContain("closest('.markdown-source-view.mod-cm6')");
		expect(livePreview).toContain('this.requestDecorationRefresh();');
		expect(livePreview).toContain('this.rebuildBlocks();');
	});

	test('source mode applies Shiki token offsets directly from code block start', () => {
		const sourceMode = read('packages/obsidian/src/modes/SourceModeAdapter.ts');

		expect(sourceMode).not.toContain('highlight.tokens.flat(1)');
		expect(sourceMode).not.toContain('let lineOffset = 0');
		expect(sourceMode).toContain('block.codeFrom + token.offset');
		expect(sourceMode).not.toContain('lineOffset += this.lineLength(block.code, lineOffset) + 1');
		expect(sourceMode).toContain('this.plugin.highlighter.getTokenStyle(token)');
	});

	test('language listing is static and startup-safe', () => {
		const highlighter = read('packages/obsidian/src/ShikiHighlighter.ts');
		const main = read('packages/obsidian/src/main.ts');
		const metadata = read('packages/obsidian/src/runtime/LanguageMetadata.ts');

		expect(highlighter).toContain('getObsidianSafeLanguageNames');
		expect(highlighter).toContain("await import('shiki/bundle/web')");
		expect(highlighter).not.toContain("await import('shiki')");
		expect(main).toContain('getObsidianSafeLanguageNames()');
		expect(main).not.toContain("from 'shiki'");
		expect(main).not.toContain('highlighter.obsidianSafeLanguageNames');
		expect(highlighter).toContain('resolveLanguageAliasFromMetadata');
		expect(metadata).toContain('LANGUAGE_METADATA');
		expect(metadata).not.toContain('modern-monaco/shiki');
	});

	test('production source avoids console spam and unguarded debug globals', () => {
		const sourceFiles = [
			'packages/obsidian/src/main.ts',
			'packages/obsidian/src/ShikiHighlighter.ts',
			'packages/obsidian/src/modes/ReadingViewAdapter.ts',
			'packages/obsidian/src/modes/LivePreviewAdapter.ts',
			'packages/obsidian/src/modes/SourceModeAdapter.ts',
			'packages/obsidian/src/codemirror/Cm6_ViewPlugin.ts',
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
	});

	test('live preview adapter keeps Obsidian editor focus for mobile toolbar', () => {
		const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');
		expect(livePreview).toContain('this.editorView.focus()');
		expect(livePreview).toContain('selection: EditorSelection.cursor(this.block.codeFrom)');
		expect(livePreview).not.toContain('shiki-code-editor');
		expect(livePreview).toContain('if (!update.docChanged && !update.viewportChanged && !update.selectionSet)');
		expect(livePreview).toContain('blockIsSelected');
		expect(livePreview).toContain('shiki-editing-codeblock-active-line');
		expect(livePreview).toContain('retokenizeSelectedBlock');
		expect(livePreview).toContain('this.plugin.highlighter.getTokenStyle(token)');
		expect(livePreview).toContain('syncActiveLineHorizontalScroll');
		expect(livePreview).toContain('shiki-live-preview-editing-nowrap');
		expect(livePreview).not.toContain('otherLine.scrollLeft = line.scrollLeft');
		expect(livePreview).not.toContain('if (update.viewportChanged || update.selectionSet)');
	});
});

test('settings language listing uses static metadata without loading heavy modules', () => {
	const settingsTab = read('packages/obsidian/src/settings/SettingsTab.ts');
	const highlighter = read('packages/obsidian/src/ShikiHighlighter.ts');
	const languageMetadata = read('packages/obsidian/src/runtime/LanguageMetadata.ts');

	expect(settingsTab).toContain('obsidianSafeLanguageNames');
	expect(settingsTab).not.toContain('ModernMonacoLoader');
	expect(settingsTab).not.toContain('loadModernMonacoRuntime');
	expect(settingsTab).not.toContain('modern-monaco');

	const methodStart = highlighter.indexOf('obsidianSafeLanguageNames()');
	expect(methodStart).toBeGreaterThanOrEqual(0);
	expect(highlighter).toContain('getObsidianSafeLanguageNames()');
	expect(highlighter).not.toContain('ModernMonacoLoader');
	expect(highlighter).not.toContain('loadModernMonacoRuntime');
	expect(languageMetadata).toContain('getObsidianSafeLanguageNames');
	expect(languageMetadata).toContain('LANGUAGE_METADATA');
});

test('real Obsidian verifier bounds CDP evaluation waits', () => {
	const source = read('tests/runtime/obsidian-advanced-codeblock-integration.mjs');

	expect(source).toContain('Timed out opening CDP socket');
	expect(source).toContain('CDP_EVALUATE_TIMEOUT_MS');
	expect(source).toContain('Timed out evaluating CDP expression #');
	expect(source).toContain('verify:obsidian-advanced-codeblock-integration failed:');
	const evaluateStart = source.indexOf('async function evaluate');
	const evaluateEnd = source.indexOf('async function dispatchMouseClick', evaluateStart);
	const evaluateSource = source.slice(evaluateStart, evaluateEnd);

	expect(evaluateSource).not.toContain('const pending = new Map');
	expect(evaluateSource).not.toContain('pending.set(id');
});

test('redraw loop verifier covers both line-number states', () => {
	const source = read('tests/runtime/obsidian-advanced-codeblock-redraw-loop.mjs');
	const settingsMatrixStart = source.indexOf('const SETTINGS_MATRIX');
	const settingsMatrixEnd = source.indexOf('\n]\n', settingsMatrixStart);
	const settingsMatrixSource = source.slice(settingsMatrixStart, settingsMatrixEnd);

	expect(settingsMatrixSource).toContain('{ wrap: false, lineNumbers: false }');
	expect(settingsMatrixSource).toContain('{ wrap: true, lineNumbers: true }');
	expect(source).toContain('state.settings?.showLineNumbers === true');
	expect(source).toContain('state.settings?.showLineNumbers === false');
});

test('Live Preview refreshes Shiki widgets when editor mode toggles', () => {
	const cm6 = read('packages/obsidian/src/codemirror/Cm6_ViewPlugin.ts');
	const livePreview = read('packages/obsidian/src/modes/LivePreviewAdapter.ts');

	expect(livePreview).toContain('refreshForModeChange(): void');
	expect(livePreview).toContain('private readonly handleModeClassChange = (): void => {');
	expect(livePreview).toContain('if (isLivePreview === this.lastRootLivePreviewClass)');
	expect(livePreview).toContain('this.rebuildBlocks();');
	expect(livePreview).toContain('private readonly modeClassObserver: MutationObserver;');
	expect(livePreview).toContain('new MutationObserver(this.handleModeClassChange)');
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

test('ShikiHighlighter does not depend on Monaco runtime', () => {
	const highlighter = read('packages/obsidian/src/ShikiHighlighter.ts');
	expect(highlighter).not.toContain('monaco');
	expect(highlighter).not.toContain('Monaco');
	expect(highlighter).not.toContain('modern-monaco');
	expect(highlighter).toContain('createHighlighter');
	expect(highlighter).toContain("await import('shiki/bundle/web')");
	expect(highlighter).toContain('codeToTokens');
});

test('styles contain Shiki block styles and no Monaco styles', () => {
	const styles = read('packages/obsidian/src/styles.css');
	expect(styles).toContain('.shiki-live-preview-block');
	expect(styles).toContain('.shiki-reading-block');
	expect(styles).toContain('.shiki-block-header');
	expect(styles).toContain('.shiki-block-body');
	expect(styles).toContain('.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-scroller');
	expect(styles).toContain('.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-line');
	expect(styles).toContain('--shiki-editing-scroll-left');
	expect(styles).toContain('transform: translateX');
	expect(styles).toContain('overflow-x: visible');
	expect(styles).toContain('body.shiki-use-editor-font-size .shiki-live-preview-block .shiki-block-body');
	expect(styles).toContain('font-size: var(--font-text-size);');
	expect(styles).toContain('font-size: var(--code-size);');
	expect(styles).toContain('font-size: inherit;');
	expect(styles).not.toContain('scrollbar-gutter: stable');
	expect(styles).not.toContain('.shiki-monaco-block');
	expect(styles).not.toContain('.shiki-monaco-editor');
	expect(styles).not.toContain('.shiki-monaco-live-widget');
	expect(styles).not.toContain('.shiki-monaco-codeblock');
});
