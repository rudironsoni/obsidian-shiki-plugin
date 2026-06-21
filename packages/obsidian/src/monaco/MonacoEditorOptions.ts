import type ShikiPlugin from 'packages/obsidian/src/main';
import type { MonacoBlockMetrics } from 'packages/obsidian/src/monaco/MonacoBlockSizer';

type MonacoEditor = typeof import('modern-monaco/editor-core').editor;

export function buildReadonlyEditorOptions(plugin: ShikiPlugin, metrics: MonacoBlockMetrics, theme: string): Parameters<MonacoEditor['create']>[1] {
	const showLineNumbers = plugin.loadedSettings.ecDefaultShowLineNumbers;
	if (showLineNumbers) {
		(globalThis as Record<string, unknown>).__monaco_maxDigitWidth = 10;
	}
	return {
		readOnly: true,
		domReadOnly: true,
		theme,
		fontSize: metrics.fontSize,
		fontFamily: metrics.fontFamily,
		lineHeight: metrics.lineHeight,
		lineNumbers: showLineNumbers ? 'on' : 'off',
		lineNumbersMinChars: showLineNumbers ? 4 : 0,
		wordWrap: plugin.loadedSettings.ecDefaultWrap ? 'on' : 'off',
		renderLineHighlight: 'none',
		minimap: { enabled: false },
		scrollbar: {
			horizontal: 'hidden',
			vertical: 'hidden',
			handleMouseWheel: false,
			alwaysConsumeMouseWheel: false,
		},
		scrollBeyondLastLine: false,
		scrollBeyondLastColumn: 0,
		overviewRulerLanes: 0,
		hideCursorInOverviewRuler: true,
		contextmenu: false,
		folding: false,
		glyphMargin: false,
		lineDecorationsWidth: showLineNumbers ? 8 : 0,
		automaticLayout: false,
		roundedSelection: false,
		selectOnLineNumbers: false,
		selectionHighlight: false,
		occurrencesHighlight: 'off',
		links: false,
		colorDecorators: false,
		lightbulb: { enabled: 'off' as any },
		padding: { top: metrics.paddingTop, bottom: metrics.paddingBottom },
	};
}

export function buildEditableEditorOptions(plugin: ShikiPlugin, metrics: MonacoBlockMetrics, theme: string): Parameters<MonacoEditor['create']>[1] {
	return {
		...buildReadonlyEditorOptions(plugin, metrics, theme),
		readOnly: false,
		domReadOnly: false,
		contextmenu: true,
		renderLineHighlight: 'line',
		scrollbar: {
			horizontal: 'hidden',
			vertical: 'hidden',
			handleMouseWheel: false,
			alwaysConsumeMouseWheel: false,
		},
	};
}
