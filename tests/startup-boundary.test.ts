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
		expect(livePreview).toContain('if (this.isMobile())');
		expect(gestures).toContain('placeNativeCursor');
		expect(gestures).toContain('selectNativeWord');
		expect(gestures).toContain('this.selectionController.placeCursor(clientX, clientY, false)');
	});
});
