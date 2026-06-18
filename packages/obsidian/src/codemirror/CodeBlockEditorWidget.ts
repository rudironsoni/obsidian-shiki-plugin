import { type Range } from '@codemirror/state';
import { Decoration, type EditorView, WidgetType } from '@codemirror/view';
import type { shikiToMonaco } from '@shikijs/monaco';
import type * as Monaco from 'monaco-editor-core';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { EditableCodeBlock } from 'packages/obsidian/src/codemirror/EditableCodeBlockDecorations';

declare const __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__: string;
declare const __SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__: string;

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
	rafHandles: number[];
	escapeHandler: ((event: KeyboardEvent) => void) | null;
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

async function decompressGzipBase64(source: string): Promise<string> {
	const bytes = Uint8Array.from(atob(source), character => character.charCodeAt(0));
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).text();
}

async function getEmbeddedMonacoEditorSource(): Promise<string | undefined> {
	const runtimeGlobal = globalThis as typeof globalThis & { __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE__?: string };
	if (typeof runtimeGlobal.__SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE__ === 'string' && runtimeGlobal.__SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE__) {
		return runtimeGlobal.__SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE__;
	}

	if (typeof __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__ !== 'undefined' && __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__) {
		return decompressGzipBase64(__SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__);
	}

	return undefined;
}

async function getEmbeddedMonacoCssSource(): Promise<string | undefined> {
	const runtimeGlobal = globalThis as typeof globalThis & { __SHIKI_EMBEDDED_MONACO_CSS_SOURCE__?: string };
	if (typeof runtimeGlobal.__SHIKI_EMBEDDED_MONACO_CSS_SOURCE__ === 'string' && runtimeGlobal.__SHIKI_EMBEDDED_MONACO_CSS_SOURCE__) {
		return runtimeGlobal.__SHIKI_EMBEDDED_MONACO_CSS_SOURCE__;
	}

	if (typeof __SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__ !== 'undefined' && __SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__) {
		return decompressGzipBase64(__SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__);
	}

	return undefined;
}

export function selectionIsInsideCodeBlockBody(state: EditorView['state'], block: EditableCodeBlock): boolean {
	const selection = state.selection.main;
	return selection.from >= block.from && selection.to <= block.to;
}

export function buildCodeBlockEditorDecoration(
	plugin: ShikiPlugin,
	block: EditableCodeBlock,
	replaceRange: CodeBlockBodyRange = block,
	autofocus = false,
): Range<Decoration> {
	return Decoration.replace({
		block: true,
		widget: new MonacoCodeBlockWidget(plugin, block, autofocus),
	}).range(replaceRange.from, replaceRange.to);
}

async function loadMonacoRuntime(plugin: ShikiPlugin): Promise<MonacoRuntime> {
	monacoRuntime ??= loadMonacoEntry(plugin).then(({ monaco, shikiToMonaco }) => {
		// Suppress web worker warning for BRAT installs where worker files are not available.
		// For small code blocks, main-thread processing is perfectly fine.
		if (!globalThis.MonacoEnvironment) {
			(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorkerUrl: () => string } }).MonacoEnvironment = {
				getWorkerUrl: () => 'data:text/javascript,',
			};
		}
		return { monaco, shikiToMonaco };
	});

	return monacoRuntime;
}

async function loadMonacoEntry(plugin: ShikiPlugin): Promise<MonacoEntry> {
	const embeddedSource = await getEmbeddedMonacoEditorSource();
	if (embeddedSource) {
		const module = { exports: {} as MonacoEntry };
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		const loadModule = new Function('module', 'exports', embeddedSource) as (module: { exports: MonacoEntry }, exports: MonacoEntry) => void;
		loadModule(module, module.exports);
		return module.exports;
	}

	const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	const source = await plugin.app.vault.adapter.read(`${pluginDir}/monaco-editor.js`);
	const module = { exports: {} as MonacoEntry };
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const loadModule = new Function('module', 'exports', source) as (module: { exports: MonacoEntry }, exports: MonacoEntry) => void;
	loadModule(module, module.exports);
	return module.exports;
}

async function loadMonacoCss(plugin: ShikiPlugin): Promise<void> {
	if (monacoCssLoaded) return;

	const embeddedCss = await getEmbeddedMonacoCssSource();
	if (embeddedCss) {
		const style = document.createElement('style');
		style.textContent = embeddedCss;
		style.dataset.shikiMonacoEditor = 'true';
		document.head.appendChild(style);
		monacoCssLoaded = true;
		return;
	}

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
		try {
			runtime.shikiToMonaco(highlighter.shiki, runtime.monaco);
			const theme = highlighter.themeMapper.getThemeIdentifier() ?? plugin.loadedSettings.darkTheme;
			runtime.monaco.editor.setTheme(theme);
			return theme;
		} catch (error) {
			console.error('[Shiki] Failed to configure Monaco with Shiki:', error);
			return plugin.loadedSettings.darkTheme;
		}
	}).catch(error => {
		console.error('[Shiki] Failed to load highlighter for Monaco:', error);
		return plugin.loadedSettings.darkTheme;
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

	toDOM(view: EditorView): HTMLElement {
		const container = document.createElement('div');
		container.className = 'shiki-monaco-codeblock shiki-monaco-active';
		container.dataset.language = this.block.language;
		(container as HTMLElement & { _parentView?: EditorView })._parentView = view;

		const fallback = document.createElement('pre');
		fallback.className = 'shiki-monaco-codeblock-fallback';
		fallback.textContent = this.block.content;
		container.appendChild(fallback);

		const controller: MonacoCodeBlockController = {
			widget: this,
			editor: undefined,
			model: undefined,
			updatingFromParent: false,
			disposed: false,
			rafHandles: [],
			escapeHandler: null,
		};
		controllers.set(container, controller);

		void this.activate(container, controller).catch(e => {
			console.error('Monaco widget activation failed:', e);
			container.classList.remove('shiki-monaco-active');
		});

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
		for (const handle of controller.rafHandles) {
			cancelAnimationFrame(handle);
		}
		if (controller.escapeHandler) {
			document.removeEventListener('keydown', controller.escapeHandler);
		}
		controller.editor?.dispose();
		controller.model?.dispose();
		controllers.delete(dom);
	}

	private async activate(container: HTMLElement, controller: MonacoCodeBlockController): Promise<void> {
		if (controller.editor) {
			controller.editor.focus();
			return;
		}

		container.classList.add('shiki-monaco-active');

		await loadMonacoCss(this.plugin);
		const runtime = await loadMonacoRuntime(this.plugin);
		if (controller.disposed || controllers.get(container) !== controller) return;

		const widget = controller.widget;
		ensureMonacoLanguage(runtime.monaco, widget.block.language);

		const model = runtime.monaco.editor.createModel(widget.block.content, normalizeMonacoLanguage(widget.block.language));
		const lineHeight = 19; // approximate default
		const initialHeight = Math.max(72, model.getLineCount() * lineHeight + 16);

		const editor = runtime.monaco.editor.create(container, {
			model,
			automaticLayout: false,
			contextmenu: false,
			fontFamily: this.plugin.loadedSettings.ecEditorFontFamily || 'var(--font-monospace)',
			fontLigatures: false,
			fontSize: this.plugin.loadedSettings.ecEditorFontSize || 14,
			lineHeight: this.plugin.loadedSettings.ecEditorLineHeight || 22,
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
				vertical: 'hidden',
			},
			wordWrap: widget.block.wrap ? 'on' : 'off',
		});

		controller.editor = editor;
		controller.model = model;
		(container as HTMLElement & { _monacoEditor?: MonacoCodeEditor })._monacoEditor = editor;

		updateMonacoEditorHeight(runtime.monaco, container, editor, model);

		const rafHandle = requestAnimationFrame(() => {
			editor.layout({ width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight) });
		});
		controller.rafHandles.push(rafHandle);

		const contentChangeDisposable = model.onDidChangeContent(() => {
			if (controller.updatingFromParent) return;
			if (controller.disposed) return;

			updateMonacoEditorHeight(runtime.monaco, container, editor, model);

			const currentWidget = controller.widget;
			const bodyRange = currentWidget.resolveCurrentBodyRange(container);
			const parentView = (container as HTMLElement & { _parentView?: EditorView })._parentView;
			if (parentView) {
				parentView.dispatch({
					changes: {
						from: bodyRange.from,
						to: bodyRange.to,
						insert: model.getValue(),
					},
				});
			}
		});

		void configureShikiMonaco(this.plugin, runtime).then(theme => {
			if (controllers.get(container) !== controller) return;
			editor.updateOptions({ theme });
		});

		// Escape key deactivates Monaco
		controller.escapeHandler = (event: KeyboardEvent): void => {
			if (event.key === 'Escape' && controller.editor && !controller.disposed) {
				const editorNode = controller.editor.getDomNode();
				if (editorNode?.contains(document.activeElement)) {
					event.preventDefault();
					event.stopPropagation();
					this.deactivate(container, controller);
				}
			}
		};
		document.addEventListener('keydown', controller.escapeHandler, true);

		if (this.autofocus) {
			editor.focus();
		}
	}

	private deactivate(container: HTMLElement, controller: MonacoCodeBlockController): void {
		if (controller.escapeHandler) {
			document.removeEventListener('keydown', controller.escapeHandler, true);
			controller.escapeHandler = null;
		}
		controller.editor?.dispose();
		controller.model?.dispose();
		controller.editor = undefined;
		controller.model = undefined;
		container.classList.remove('shiki-monaco-active');
	}

	private resolveCurrentBodyRange(container: HTMLElement): CodeBlockBodyRange {
		const parentView = (container as HTMLElement & { _parentView?: EditorView })._parentView;
		if (!parentView) return { from: this.block.from, to: this.block.to };

		const state = parentView.state;
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

	private updateMountedEditor(dom: HTMLElement, controller: MonacoCodeBlockController): void {
		const editor = controller.editor;
		const model = controller.model;
		if (!editor || !model) return;

		void loadMonacoRuntime(this.plugin).then(({ monaco }) => {
			if (controller.disposed || !controller.editor || !controller.model) return;

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
}

function updateMonacoEditorHeight(monaco: MonacoModule, container: HTMLElement, editor: MonacoCodeEditor, model: MonacoTextModel): void {
	const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
	const verticalPadding = 16;
	const height = Math.max(72, model.getLineCount() * lineHeight + verticalPadding);
	// eslint-disable-next-line no-console
	console.log('[Shiki] updateMonacoEditorHeight: lines=', model.getLineCount(), 'lineHeight=', lineHeight, 'height=', height);
	container.style.height = `${height}px`;
	editor.layout({ width: Math.max(1, container.clientWidth), height: Math.max(1, height) });
}
