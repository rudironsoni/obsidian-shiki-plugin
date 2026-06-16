import { type Range } from '@codemirror/state';
import { Decoration, type EditorView, WidgetType } from '@codemirror/view';
import type { shikiToMonaco } from '@shikijs/monaco';
import type * as Monaco from 'monaco-editor-core';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { EditableCodeBlock } from 'packages/obsidian/src/codemirror/EditableCodeBlockDecorations';

type MonacoModule = typeof Monaco;
type MonacoCodeEditor = Monaco.editor.IStandaloneCodeEditor;
type MonacoTextModel = Monaco.editor.ITextModel;
type ShikiToMonaco = typeof shikiToMonaco;
interface MonacoEntry {
	monaco: MonacoModule;
	shikiToMonaco: ShikiToMonaco;
}

interface MonacoRuntime {
	monaco: MonacoModule;
	shikiToMonaco: ShikiToMonaco;
}

interface MonacoCodeBlockController {
	widget: MonacoCodeBlockWidget;
	editor: MonacoCodeEditor | undefined;
	model: MonacoTextModel | undefined;
	updatingFromParent: boolean;
	disposed: boolean;
}

export interface CodeBlockBodyRange {
	from: number;
	to: number;
}

export function resolveEditableCodeBlockBodyRange(
	block: Pick<EditableCodeBlock, 'from' | 'to'>,
	docLength: number,
	bodyRanges: CodeBlockBodyRange[],
): CodeBlockBodyRange {
	const fallbackFrom = Math.min(block.from, docLength);
	const fallbackTo = Math.min(Math.max(block.to, fallbackFrom), docLength);

	return (
		bodyRanges.find(range => {
			const overlapsOriginalBlock = range.from <= fallbackTo && range.to >= fallbackFrom;
			const containsOriginalStart = range.from <= fallbackFrom && fallbackFrom <= range.to;
			return overlapsOriginalBlock || containsOriginalStart;
		}) ?? { from: fallbackFrom, to: fallbackTo }
	);
}

const controllers = new WeakMap<HTMLElement, MonacoCodeBlockController>();
let monacoRuntime: Promise<MonacoRuntime> | undefined;
let shikiMonacoConfigured: Promise<string> | undefined;
let monacoCssLoaded = false;

export function selectionIsInsideCodeBlockBody(state: EditorView['state'], block: EditableCodeBlock): boolean {
	const selection = state.selection.main;
	return selection.from >= block.from && selection.to <= block.to;
}

export function buildCodeBlockEditorDecoration(
	plugin: ShikiPlugin,
	parentView: EditorView,
	block: EditableCodeBlock,
	replaceRange: CodeBlockBodyRange = block,
): Range<Decoration> {
	return Decoration.replace({
		block: true,
		widget: new MonacoCodeBlockWidget(plugin, parentView, block),
	}).range(replaceRange.from, replaceRange.to);
}

export function createCodeBlockEditorElement(plugin: ShikiPlugin, parentView: EditorView, block: EditableCodeBlock): HTMLElement {
	return new MonacoCodeBlockWidget(plugin, parentView, block, true).toDOM();
}

async function loadMonacoRuntime(plugin: ShikiPlugin): Promise<MonacoRuntime> {
	monacoRuntime ??= loadMonacoEntry(plugin).then(({ monaco, shikiToMonaco }) => ({ monaco, shikiToMonaco }));

	return monacoRuntime;
}

async function loadMonacoEntry(plugin: ShikiPlugin): Promise<MonacoEntry> {
	const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	const source = await plugin.app.vault.adapter.read(`${pluginDir}/monaco-editor.js`);
	const module = { exports: {} as MonacoEntry };
	// Obsidian does not resolve sibling plugin files through require() or import().
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const loadModule = new Function('module', 'exports', source) as (module: { exports: MonacoEntry }, exports: MonacoEntry) => void;
	loadModule(module, module.exports);
	return module.exports;
}

async function loadMonacoCss(plugin: ShikiPlugin): Promise<void> {
	if (monacoCssLoaded) return;

	const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	if (!(await plugin.app.vault.adapter.exists(`${pluginDir}/monaco-editor.css`))) {
		monacoCssLoaded = true;
		return;
	}

	const style = document.createElement('style');
	style.textContent = await plugin.app.vault.adapter.read(`${pluginDir}/monaco-editor.css`);
	style.dataset.shikiMonacoEditor = 'true';
	document.head.appendChild(style);
	monacoCssLoaded = true;
}

async function configureShikiMonaco(plugin: ShikiPlugin, runtime: MonacoRuntime): Promise<string> {
	shikiMonacoConfigured ??= plugin.highlighter.load().then(highlighter => {
		runtime.shikiToMonaco(highlighter.shiki, runtime.monaco);
		const theme = highlighter.themeMapper.getThemeIdentifier() ?? plugin.loadedSettings.darkTheme;
		runtime.monaco.editor.setTheme(theme);
		return theme;
	});

	return shikiMonacoConfigured;
}

function normalizeMonacoLanguage(language: string): string {
	return language.trim().toLowerCase() || 'plaintext';
}

function ensureMonacoLanguage(monaco: MonacoModule, language: string): void {
	const id = normalizeMonacoLanguage(language);
	if (monaco.languages.getLanguages().some(knownLanguage => knownLanguage.id === id)) {
		return;
	}

	monaco.languages.register({ id });
}

class MonacoCodeBlockWidget extends WidgetType {
	constructor(
		private readonly plugin: ShikiPlugin,
		private readonly parentView: EditorView,
		readonly block: EditableCodeBlock,
		private readonly autofocus = false,
	) {
		super();
	}

	eq(other: MonacoCodeBlockWidget): boolean {
		return (
			this.block.from === other.block.from &&
			this.block.language === other.block.language &&
			this.block.showLineNumbers === other.block.showLineNumbers &&
			this.block.wrap === other.block.wrap
		);
	}

	toDOM(): HTMLElement {
		document.body.dataset.shikiMonacoWidgetToDom = `${Number(document.body.dataset.shikiMonacoWidgetToDom ?? 0) + 1}`;
		const container = document.createElement('div');
		container.className = 'shiki-monaco-codeblock shiki-monaco-codeblock-loading';
		container.dataset.language = this.block.language;

		const controller: MonacoCodeBlockController = {
			widget: this,
			editor: undefined,
			model: undefined,
			updatingFromParent: false,
			disposed: false,
		};
		controllers.set(container, controller);

		void this.mountMonaco(container, controller);

		return container;
	}

	updateDOM(dom: HTMLElement): boolean {
		const controller = controllers.get(dom);
		if (!controller) return false;

		controller.widget = this;
		dom.dataset.language = this.block.language;

		if (!controller.editor || !controller.model) {
			return true;
		}

		this.updateMountedEditor(dom, controller);
		return true;
	}

	ignoreEvent(): boolean {
		return true;
	}

	destroy(dom: HTMLElement): void {
		const controller = controllers.get(dom);
		if (!controller) return;

		controller.disposed = true;
		controller.editor?.dispose();
		controller.model?.dispose();
		controllers.delete(dom);
	}

	private resolveCurrentBodyRange(): CodeBlockBodyRange {
		const state = this.parentView.state;
		const doc = state.doc;
		let openingLine = doc.lineAt(Math.max(0, Math.min(this.block.from, doc.length)));

		while (openingLine.number >= 1 && !/^\s*(```|~~~)/.test(openingLine.text)) {
			if (openingLine.number === 1) return resolveEditableCodeBlockBodyRange(this.block, doc.length, []);
			openingLine = doc.line(openingLine.number - 1);
		}

		const openingMatch = /^\s*(```|~~~)/.exec(openingLine.text);
		if (!openingMatch) return resolveEditableCodeBlockBodyRange(this.block, doc.length, []);

		const fence = openingMatch[1];
		let closingLine = openingLine;
		while (closingLine.number < doc.lines) {
			closingLine = doc.line(closingLine.number + 1);
			if (closingLine.text.trimStart().startsWith(fence)) {
				const from = doc.line(openingLine.number + 1).from;
				const to = Math.max(from, closingLine.from - 1);
				return { from, to };
			}
		}

		return resolveEditableCodeBlockBodyRange(this.block, doc.length, []);
	}

	private async mountMonaco(container: HTMLElement, controller: MonacoCodeBlockController): Promise<void> {
		await loadMonacoCss(this.plugin);
		const runtime = await loadMonacoRuntime(this.plugin);
		if (controller.disposed || controllers.get(container) !== controller) return;

		const widget = controller.widget;
		ensureMonacoLanguage(runtime.monaco, widget.block.language);

		const model = runtime.monaco.editor.createModel(widget.block.content, normalizeMonacoLanguage(widget.block.language));
		const editor = runtime.monaco.editor.create(container, {
			model,
			automaticLayout: true,
			contextmenu: false,
			fontFamily: 'var(--font-monospace)',
			fontLigatures: false,
			fontSize: Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--code-size')) || 13,
			glyphMargin: false,
			lineDecorationsWidth: 8,
			lineNumbers: widget.block.showLineNumbers ? 'on' : 'off',
			lineNumbersMinChars: widget.block.showLineNumbers ? 3 : 0,
			minimap: { enabled: false },
			overviewRulerLanes: 0,
			renderLineHighlight: 'none',
			scrollBeyondLastLine: false,
			scrollbar: {
				alwaysConsumeMouseWheel: false,
				horizontal: 'auto',
				vertical: 'auto',
			},
			wordWrap: widget.block.wrap ? 'on' : 'off',
		});

		controller.editor = editor;
		controller.model = model;
		(window as typeof window & { __shikiLastMonacoEditor?: MonacoCodeEditor }).__shikiLastMonacoEditor = editor;
		container.classList.remove('shiki-monaco-codeblock-loading');
		updateMonacoEditorHeight(runtime.monaco, container, editor, model);

		model.onDidChangeContent(() => {
			if (controller.updatingFromParent) return;

			const currentWidget = controller.widget;
			const bodyRange = currentWidget.resolveCurrentBodyRange();
			document.body.dataset.shikiMonacoDispatchRange = `${bodyRange.from}-${bodyRange.to}`;
			document.body.dataset.shikiMonacoDispatchCount = `${Number(document.body.dataset.shikiMonacoDispatchCount ?? 0) + 1}`;
			currentWidget.parentView.dispatch({
				changes: {
					from: bodyRange.from,
					to: bodyRange.to,
					insert: model.getValue(),
				},
			});
			updateMonacoEditorHeight(runtime.monaco, container, editor, model);
		});

		void configureShikiMonaco(this.plugin, runtime).then(theme => {
			if (controllers.get(container) !== controller) return;

			editor.updateOptions({ theme });
		});

		this.focusFromParentSelection(runtime.monaco, editor, model);
		if (this.autofocus) {
			editor.focus();
		}
	}

	private updateMountedEditor(dom: HTMLElement, controller: MonacoCodeBlockController): void {
		const editor = controller.editor;
		const model = controller.model;
		if (!editor || !model) return;

		void loadMonacoRuntime(this.plugin).then(({ monaco }) => {
			const language = normalizeMonacoLanguage(this.block.language);
			ensureMonacoLanguage(monaco, language);
			monaco.editor.setModelLanguage(model, language);

			editor.updateOptions({
				lineNumbers: this.block.showLineNumbers ? 'on' : 'off',
				lineNumbersMinChars: this.block.showLineNumbers ? 3 : 0,
				wordWrap: this.block.wrap ? 'on' : 'off',
			});

			if (model.getValue() !== this.block.content) {
				const position = editor.getPosition();
				controller.updatingFromParent = true;
				model.setValue(this.block.content);
				controller.updatingFromParent = false;
				updateMonacoEditorHeight(monaco, dom, editor, model);
				if (position) {
					editor.setPosition(position);
				}
			}
		});
	}

	private focusFromParentSelection(monaco: MonacoModule, editor: MonacoCodeEditor, model: MonacoTextModel): void {
		if (!this.parentView.hasFocus || !selectionIsInsideCodeBlockBody(this.parentView.state, this.block)) {
			return;
		}

		window.requestAnimationFrame(() => {
			const offset = Math.max(0, Math.min(model.getValueLength(), this.parentView.state.selection.main.head - this.block.from));
			editor.setPosition(model.getPositionAt(offset));
			editor.revealPositionInCenterIfOutsideViewport(editor.getPosition() ?? new monaco.Position(1, 1));
			editor.focus();
		});
	}
}

function updateMonacoEditorHeight(monaco: MonacoModule, container: HTMLElement, editor: MonacoCodeEditor, model: MonacoTextModel): void {
	const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
	const verticalPadding = 20;
	const height = Math.max(72, model.getLineCount() * lineHeight + verticalPadding);
	container.style.height = `${height}px`;
	editor.layout();
}
