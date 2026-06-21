import type { CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { buildEditableEditorOptions, buildReadonlyEditorOptions } from 'packages/obsidian/src/monaco/MonacoEditorOptions';
import { MonacoBlockSizer } from 'packages/obsidian/src/monaco/MonacoBlockSizer';
import { MonacoGestureRouter } from 'packages/obsidian/src/monaco/MonacoGestureRouter';
import { MonacoInputController, type MonacoEditSync } from 'packages/obsidian/src/monaco/MonacoInputController';
import { MonacoModeController } from 'packages/obsidian/src/monaco/MonacoModeController';
import { MonacoScrollState } from 'packages/obsidian/src/monaco/MonacoScrollState';
import { MonacoSelectionController } from 'packages/obsidian/src/monaco/MonacoSelectionController';
import type { MonacoRuntime } from 'packages/obsidian/src/modern-monaco-entry';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';

type MonacoEditorLike = ReturnType<MonacoRuntime['monaco']['editor']['create']>;

export class MonacoCodeBlockSurface {
	readonly hostEl: HTMLDivElement;
	private readonly plugin: ShikiPlugin;
	private readonly runtime: MonacoRuntime;
	private readonly blockSizer = new MonacoBlockSizer();
	private readonly scrollState = new MonacoScrollState();
	private readonly modeController = new MonacoModeController();
	private readonly inputController = new MonacoInputController();
	private readonly selectionController: MonacoSelectionController;
	private block: CodeBlockModel;
	private editor: MonacoEditorLike | undefined;
	private editorEl: HTMLDivElement | undefined;
	private resizeObserver: ResizeObserver | undefined;
	private gestureRouter: MonacoGestureRouter | undefined;
	private attachedParent: HTMLElement | undefined;
	private hydrated = false;
	private disposed = false;

	constructor(plugin: ShikiPlugin, runtime: MonacoRuntime, block: CodeBlockModel) {
		this.plugin = plugin;
		this.runtime = runtime;
		this.block = block;
		this.hostEl = document.createElement('div');
		this.hostEl.className = 'shiki-monaco-block';
		this.selectionController = new MonacoSelectionController(this.hostEl);
	}

	get id(): string {
		return this.block.id;
	}

	isHydrated(): boolean {
		return this.hydrated;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	attach(parent: HTMLElement): void {
		if (this.disposed) {
			return;
		}
		this.attachedParent = parent;
		if (this.hostEl.parentElement !== parent) {
			parent.appendChild(this.hostEl);
		}
		if (!this.resizeObserver) {
			this.resizeObserver = new ResizeObserver(() => this.layout());
			this.resizeObserver.observe(this.hostEl);
		}
		this.layout();
	}

	updateBlock(block: CodeBlockModel): void {
		this.block = block;
		if (!this.editor) {
			return;
		}
		const model = this.editor.getModel();
		if (model && model.getValue() !== block.code) {
			this.inputController.withSuppressedCommit(() => {
				model.setValue(block.code);
			});
		}
		this.layout();
	}

	async hydrateReadonly(): Promise<void> {
		if (this.hydrated || this.disposed) {
			return;
		}
		await this.runtime.registerLanguage(this.block.language).catch(() => undefined);
		this.createEditor('readonly');
	}

	async activateEditable(sync: MonacoEditSync): Promise<void> {
		await this.hydrateReadonly();
		this.inputController.setSync(sync);
		this.modeController.setMode('editable');
		this.editor?.updateOptions({ readOnly: false, domReadOnly: false, contextmenu: true, renderLineHighlight: 'line' });
		this.editor?.focus();
	}

	deactivateToReadonly(): void {
		this.inputController.setSync(undefined);
		this.modeController.setMode('readonly');
		this.editor?.updateOptions({ readOnly: true, domReadOnly: true, contextmenu: false, renderLineHighlight: 'none' });
	}

	updateTheme(): void {
		this.runtime.monaco.editor.setTheme(getActiveTheme(this.plugin));
		this.layout();
	}

	layout(): void {
		if (!this.editor || this.disposed) {
			return;
		}
		const metrics = this.blockSizer.measure(this.block, this.hostEl, this.plugin.loadedSettings.ecEditorLineHeight);
		this.hostEl.style.height = `${metrics.height}px`;
		this.editorEl!.style.height = `${metrics.height}px`;
		this.editor.updateOptions({
			fontSize: metrics.fontSize,
			fontFamily: metrics.fontFamily,
			lineHeight: metrics.lineHeight,
			padding: { top: metrics.paddingTop, bottom: metrics.paddingBottom },
		});
		this.editor.layout({ width: metrics.width, height: metrics.height });
		this.editor.setScrollLeft(this.scrollState.getScrollLeft());
	}

	dispose(): void {
		this.disposed = true;
		this.resizeObserver?.disconnect();
		this.resizeObserver = undefined;
		this.gestureRouter?.dispose();
		this.gestureRouter = undefined;
		this.selectionController.dispose();
		this.editor?.dispose();
		this.editor = undefined;
		this.editorEl?.remove();
		this.editorEl = undefined;
		this.hostEl.remove();
	}

	private createEditor(mode: 'readonly' | 'editable'): void {
		if (this.editor || this.disposed) {
			return;
		}
		const editorEl = document.createElement('div');
		editorEl.className = 'shiki-monaco-editor';
		editorEl.style.width = '100%';
		this.hostEl.appendChild(editorEl);
		this.editorEl = editorEl;
		const metrics = this.blockSizer.measure(this.block, this.hostEl, this.plugin.loadedSettings.ecEditorLineHeight);
		const theme = getActiveTheme(this.plugin);
		const language = this.plugin.monacoRuntime.resolveLanguageAlias(this.block.language) ?? this.block.language;
		const options = mode === 'editable' ? buildEditableEditorOptions(this.plugin, metrics, theme) : buildReadonlyEditorOptions(this.plugin, metrics, theme);
		this.editor = this.runtime.monaco.editor.create(editorEl, {
			...options,
			value: this.block.code,
			language,
		});
		this.modeController.setMode(mode);
		this.hydrated = true;
		this.selectionController.attach(this.editor as unknown as Parameters<MonacoSelectionController['attach']>[0]);
		this.gestureRouter = new MonacoGestureRouter({
			host: this.hostEl,
			editor: this.editor,
			selectionController: this.selectionController,
			scrollState: this.scrollState,
			getNoteScroller: () =>
				(this.hostEl.closest('.markdown-source-view, .markdown-preview-view')?.querySelector('.cm-scroller, .markdown-preview-sizer') as HTMLElement | null) ??
				this.attachedParent ??
				this.hostEl,
		});
		this.editor.onDidScrollChange(() => {
			this.scrollState.setScrollLeft(this.editor?.getScrollLeft() ?? 0);
		});
		this.editor.onDidChangeModelContent(() => {
			const value = this.editor?.getValue() ?? this.block.code;
			this.inputController.commit(value);
			this.block = { ...this.block, code: value };
			this.layout();
		});
		this.layout();
	}
}
