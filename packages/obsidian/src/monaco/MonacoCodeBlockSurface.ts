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
interface NativeMobileInteraction {
	placeCursor(position: { lineNumber: number; column: number }): void;
	selectWord(position: { lineNumber: number; column: number }): void;
}

export class MonacoCodeBlockSurface {
	readonly hostEl: HTMLDivElement;
	private readonly plugin: ShikiPlugin;
	private runtime: MonacoRuntime | undefined;
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
	private nativeMobileInteraction: NativeMobileInteraction | undefined;
	private mobileModeObserver: MutationObserver | undefined;
	private mobileModePollTimer: number | undefined;
	private activationHandler: ((point: { clientX: number; clientY: number }) => void) | undefined;
	private attachedParent: HTMLElement | undefined;
	private hydrated = false;
	private disposed = false;

	constructor(plugin: ShikiPlugin, block: CodeBlockModel) {
		this.mobileModeObserver = new MutationObserver(this.handleDocumentModeChange);
		this.mobileModeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		window.addEventListener('resize', this.handleDocumentModeChange);
		this.plugin = plugin;
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

	setNativeMobileInteraction(nativeMobileInteraction: NativeMobileInteraction | undefined): void {
		this.nativeMobileInteraction = nativeMobileInteraction;
		if (this.editor) {
			this.installGestureRouter();
		}
	}

	setActivationHandler(activationHandler: ((point: { clientX: number; clientY: number }) => void) | undefined): void {
		this.activationHandler = activationHandler;
		if (this.editor) {
			this.installGestureRouter();
		}
	}

	async hydrateReadonly(): Promise<void> {
		if (this.hydrated || this.disposed) {
			return;
		}
		const runtime = await this.plugin.monacoRuntime.load();
		if (this.disposed) {
			return;
		}
		this.runtime = runtime;
		await runtime.registerLanguage(this.block.language).catch(() => undefined);
		this.createEditor('readonly');
	}

	async activateEditable(sync: MonacoEditSync, cursorPoint?: { clientX: number; clientY: number }): Promise<void> {
		await this.hydrateReadonly();
		this.inputController.setSync(sync);
		this.modeController.setMode('editable');
		this.editor?.updateOptions({ readOnly: false, domReadOnly: false, contextmenu: true, renderLineHighlight: 'line' });
		this.updateModeClass();
		this.startMobileModePoll(true);
		if (this.isDocumentMobileMode() && !cursorPoint) {
			this.deactivateToReadonly();
			return;
		}
		if (cursorPoint) {
			await this.waitForEditorFrame();
			this.placeCursorFromPoint(cursorPoint.clientX, cursorPoint.clientY);
		} else {
			this.editor?.focus();
		}
	}

	placeCursorAt(clientX: number, clientY: number, focus = true): void {
		this.selectionController.placeCursor(clientX, clientY, focus);
	}

	deactivateToReadonly(): void {
		this.stopMobileModePoll();
		this.inputController.setSync(undefined);
		this.modeController.setMode('readonly');
		this.editor?.updateOptions({ readOnly: true, domReadOnly: true, contextmenu: false, renderLineHighlight: 'none' });
		this.updateModeClass();
	}

	updateTheme(): void {
		this.runtime?.monaco.editor.setTheme(getActiveTheme(this.plugin));
		this.layout();
	}

	layout(): void {
		if (!this.editor || this.disposed) {
			return;
		}
		const metrics = this.blockSizer.measure(this.block, this.hostEl);
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
		this.mobileModeObserver?.disconnect();
		this.mobileModeObserver = undefined;
		window.removeEventListener('resize', this.handleDocumentModeChange);
		this.stopMobileModePoll();
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
		if (this.editor || this.disposed || !this.runtime) {
			return;
		}
		const editorEl = document.createElement('div');
		editorEl.className = 'shiki-monaco-editor';
		editorEl.style.width = '100%';
		this.hostEl.appendChild(editorEl);
		this.editorEl = editorEl;
		const metrics = this.blockSizer.measure(this.block, this.hostEl);
		const theme = getActiveTheme(this.plugin);
		const language = this.plugin.monacoRuntime.resolveLanguageAlias(this.block.language) ?? this.block.language;
		const options = mode === 'editable' ? buildEditableEditorOptions(this.plugin, metrics, theme) : buildReadonlyEditorOptions(this.plugin, metrics, theme);
		this.editor = this.runtime.monaco.editor.create(editorEl, {
			...options,
			value: this.block.code,
			language,
		});
		(this.hostEl as HTMLDivElement & { _monacoEditor?: MonacoEditorLike })._monacoEditor = this.editor;
		this.modeController.setMode(mode);
		this.updateModeClass();
		this.hydrated = true;
		this.selectionController.attach(this.editor as unknown as Parameters<MonacoSelectionController['attach']>[0]);
		this.installGestureRouter();
		this.editor.onDidScrollChange(() => {
			this.scrollState.setScrollLeft(this.editor?.getScrollLeft() ?? 0);
		});
		this.editor.onDidFocusEditorWidget(() => {
			this.hostEl.classList.add('shiki-monaco-active');
		});
		this.editor.onDidBlurEditorWidget(() => {
			if (!this.modeController.isEditable()) {
				this.hostEl.classList.remove('shiki-monaco-active');
			}
		});
		this.editor.onDidChangeModelContent(() => {
			const value = this.editor?.getValue() ?? this.block.code;
			this.inputController.commit(value);
			this.block = { ...this.block, code: value };
			this.layout();
		});
		this.layout();
	}

	private startMobileModePoll(enabled: boolean): void {
		this.stopMobileModePoll();
		if (!enabled) {
			return;
		}
		this.mobileModePollTimer = window.setInterval(() => {
			if (this.disposed || !this.modeController.isEditable()) {
				this.stopMobileModePoll();
				return;
			}
			if (this.isDocumentMobileMode()) {
				this.deactivateToReadonly();
			}
		}, 100);
	}

	private stopMobileModePoll(): void {
		if (this.mobileModePollTimer === undefined) {
			return;
		}
		window.clearInterval(this.mobileModePollTimer);
		this.mobileModePollTimer = undefined;
	}

	private readonly handleDocumentModeChange = (): void => {
		if (!this.isDocumentMobileMode()) {
			return;
		}
		this.deactivateToReadonly();
	};

	private isDocumentMobileMode(): boolean {
		return (
			document.body.classList.contains('emulate-mobile') ||
			document.body.classList.contains('is-mobile') ||
			document.body.classList.contains('is-phone') ||
			document.body.classList.contains('is-tablet')
		);
	}

	private placeCursorFromPoint(clientX: number, clientY: number): void {
		this.selectionController.placeCursor(clientX, clientY, true);
		const approximate = this.approximatePositionFromPoint(clientX, clientY);
		if (approximate) {
			this.editor?.setPosition(approximate);
			this.editor?.focus();
		}
	}

	private approximatePositionFromPoint(clientX: number, clientY: number): { lineNumber: number; column: number } | undefined {
		const lines = this.block.code.split('\n');
		if (lines.length === 0) {
			return undefined;
		}
		const viewLines = [...this.hostEl.querySelectorAll<HTMLElement>('.view-line')];
		if (viewLines.length > 0) {
			let bestIndex = 0;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (let index = 0; index < viewLines.length; index++) {
				const rect = viewLines[index].getBoundingClientRect();
				const distance = Math.abs(rect.top + rect.height / 2 - clientY);
				if (distance < bestDistance) {
					bestDistance = distance;
					bestIndex = index;
				}
			}
			const rect = viewLines[bestIndex].getBoundingClientRect();
			const textLength = lines[bestIndex]?.length ?? viewLines[bestIndex].textContent?.length ?? 0;
			const progress = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
			return { lineNumber: bestIndex + 1, column: Math.max(1, Math.min(textLength + 1, Math.round(progress * textLength) + 1)) };
		}

		const metrics = this.blockSizer.measure(this.block, this.hostEl);
		const hostRect = this.hostEl.getBoundingClientRect();
		const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor((clientY - hostRect.top - metrics.paddingTop) / metrics.lineHeight)));
		const line = lines[lineIndex] ?? '';
		const progress = hostRect.width > 0 ? Math.max(0, Math.min(1, (clientX - hostRect.left) / hostRect.width)) : 0;
		return { lineNumber: lineIndex + 1, column: Math.max(1, Math.min(line.length + 1, Math.round(progress * line.length) + 1)) };
	}

	private async waitForEditorFrame(): Promise<void> {
		await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
		await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
	}

	private updateModeClass(): void {
		const editable = this.modeController.isEditable();
		this.hostEl.classList.toggle('shiki-monaco-editable', editable);
		this.hostEl.classList.toggle('shiki-monaco-readonly', !editable);
		this.hostEl.classList.toggle('shiki-monaco-active', editable);
	}

	private installGestureRouter(): void {
		if (!this.editor) {
			return;
		}
		this.gestureRouter?.dispose();
		this.gestureRouter = new MonacoGestureRouter({
			host: this.hostEl,
			editor: this.editor,
			selectionController: this.selectionController,
			scrollState: this.scrollState,
			getNoteScroller: (): HTMLElement =>
				(this.hostEl
					.closest('.markdown-source-view, .markdown-preview-view')
					?.querySelector('.cm-scroller, .markdown-preview-sizer') as HTMLElement | null) ??
				this.attachedParent ??
				this.hostEl,
			nativeInteraction: this.nativeMobileInteraction,
			onActivate: this.activationHandler,
			isEditable: () => this.modeController.isEditable(),
		});
	}
}
