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
	private activationHandler: ((point: { clientX: number; clientY: number }) => void) | undefined;
	private editableDeactivationGuardUntil = 0;
	private noteScrollerProvider: (() => HTMLElement | null) | undefined;
	private attachedParent: HTMLElement | undefined;
	private hydrated = false;
	private disposed = false;

	constructor(plugin: ShikiPlugin, block: CodeBlockModel) {
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

	isVisiblyReady(): boolean {
		if (!this.hydrated || !this.editor || !this.editorEl || this.disposed) {
			return false;
		}
		const modelText = this.editor.getModel()?.getValue() ?? '';
		if (modelText.trim().length === 0) {
			return false;
		}
		const hostRect = this.hostEl.getBoundingClientRect();
		const editorRect = this.editorEl.getBoundingClientRect();
		if (hostRect.width < 1 || hostRect.height < 1 || editorRect.width < 1 || editorRect.height < 1) {
			return false;
		}
		return Array.from(this.hostEl.querySelectorAll<HTMLElement>('.view-line')).some(line => {
			const rect = line.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && (line.textContent ?? '').trim().length > 0;
		});
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
		if (this.modeController.isEditable()) {
			this.layout();
			return;
		}
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

	setNoteScrollerProvider(noteScrollerProvider: (() => HTMLElement | null) | undefined): void {
		this.noteScrollerProvider = noteScrollerProvider;
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
		this.editableDeactivationGuardUntil = Date.now() + 8000;
		this.editor?.updateOptions({ readOnly: false, domReadOnly: false, contextmenu: true, renderLineHighlight: 'line' });
		this.updateModeClass();
		if (cursorPoint) {
			await this.waitForEditorFrame();
			this.placeCursorFromPoint(cursorPoint.clientX, cursorPoint.clientY);
			for (const delayMs of [50, 150, 300]) {
				window.setTimeout(() => {
					this.placeCursorFromPoint(cursorPoint.clientX, cursorPoint.clientY);
				}, delayMs);
			}
		} else {
			this.editor?.focus();
		}
	}

	placeCursorAt(clientX: number, clientY: number, focus = true): void {
		this.selectionController.placeCursor(clientX, clientY, focus);
	}

	deactivateToReadonly(): void {
		const deactivationGuardActive = Date.now() < this.editableDeactivationGuardUntil && this.modeController.isEditable();
		if (deactivationGuardActive) {
			const deactivationTrace = (window as unknown as { __shikiMonacoDeactivationTrace?: unknown }).__shikiMonacoDeactivationTrace;
			if (Array.isArray(deactivationTrace)) {
				deactivationTrace.push({ blockId: this.block.id, skipped: true, stack: new Error().stack });
			}
			return;
		}
		const deactivationTrace = (window as unknown as { __shikiMonacoDeactivationTrace?: unknown }).__shikiMonacoDeactivationTrace;
		if (Array.isArray(deactivationTrace)) {
			deactivationTrace.push({ blockId: this.block.id, stack: new Error().stack });
		}
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
		const metrics = this.blockSizer.measure(this.modeController.isEditable() ? { ...this.block, code: this.editor.getValue() } : this.block, this.hostEl);
		const showLineNumbers = this.plugin.loadedSettings.ecDefaultShowLineNumbers;
		this.hostEl.style.height = `${metrics.height}px`;
		this.editorEl!.style.height = `${metrics.height}px`;
		this.editor.updateOptions({
			fontSize: metrics.fontSize,
			fontFamily: metrics.fontFamily,
			lineHeight: metrics.lineHeight,
			lineNumbers: showLineNumbers ? 'on' : 'off',
			lineNumbersMinChars: showLineNumbers ? 4 : 0,
			lineDecorationsWidth: showLineNumbers ? 8 : 0,
			wordWrap: this.plugin.loadedSettings.ecDefaultWrap ? 'on' : 'off',
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

	private placeCursorFromPoint(clientX: number, clientY: number): void {
		if (!this.editor) {
			return;
		}
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const modelLines = model.getValue().split(/\r\n|\r|\n/);
		const getLineCount = (): number => Math.max(1, modelLines.length);
		const getLineMaxColumn = (lineNumber: number): number => (modelLines[lineNumber - 1] ?? '').length + 1;
		type GeometryEditor = MonacoEditorLike & {
			getTargetAtClientPoint?: (clientX: number, clientY: number) => { position?: { lineNumber: number; column: number } } | null;
			getScrolledVisiblePosition?: (position: { lineNumber: number; column: number }) => { left: number } | null;
		};
		const geometryEditor = this.editor as GeometryEditor;

		const targetPosition = geometryEditor.getTargetAtClientPoint?.(clientX, clientY)?.position;
		const firstViewLineRect = this.hostEl.querySelector<HTMLElement>('.view-line')?.getBoundingClientRect();
		const pointInsideFirstViewLine = firstViewLineRect ? clientY >= firstViewLineRect.top && clientY <= firstViewLineRect.bottom : false;
		const targetLooksStaleNativeMobile =
			document.activeElement?.classList?.contains('native-edit-context') === true &&
			targetPosition?.lineNumber === 1 &&
			targetPosition.column === 1 &&
			this.hostEl.querySelectorAll('.view-line').length > 0 &&
			!pointInsideFirstViewLine;
		const targetVisiblePosition = targetPosition ? geometryEditor.getScrolledVisiblePosition?.(targetPosition) : null;
		const editorRect = this.editorEl?.getBoundingClientRect() ?? this.hostEl.getBoundingClientRect();
		const targetClientLeft = targetVisiblePosition ? editorRect.left + targetVisiblePosition.left : undefined;
		const targetLooksMisaligned = targetClientLeft !== undefined && Math.abs(clientX - targetClientLeft) > 32;
		if (targetPosition && !targetLooksStaleNativeMobile && !targetLooksMisaligned) {
			const lineNumber = Math.max(1, Math.min(getLineCount(), targetPosition.lineNumber));
			this.editor.setPosition({
				lineNumber,
				column: Math.max(1, Math.min(getLineMaxColumn(lineNumber), targetPosition.column)),
			});
			this.editor.focus();
			return;
		}

		const viewLines = Array.from(this.hostEl.querySelectorAll<HTMLElement>('.view-line'));
		if (viewLines.length === 0) {
			this.editor.focus();
			return;
		}

		let bestLineElement: HTMLElement | null = null;
		let bestLineDistance = Number.POSITIVE_INFINITY;
		for (const lineEl of viewLines) {
			const rect = lineEl.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				continue;
			}
			const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
			if (distance < bestLineDistance) {
				bestLineDistance = distance;
				bestLineElement = lineEl;
			}
		}
		if (!bestLineElement) {
			this.editor.focus();
			return;
		}

		const lineRect = bestLineElement.getBoundingClientRect();
		const lineHeight = Math.max(1, lineRect.height || Number.parseFloat(getComputedStyle(bestLineElement).lineHeight) || 20);
		const topMatchedLine = Number.parseFloat(bestLineElement.style.top || '');
		const topMatchedLineNumber = Number.isFinite(topMatchedLine) ? Math.round(topMatchedLine / lineHeight) + 1 : -1;
		const renderedText = (bestLineElement.textContent ?? '').replace(/\u00a0/g, ' ');
		const textMatchedLine = modelLines.findIndex(line => line === renderedText);
		const sortedLines = viewLines
			.map((lineEl, index) => ({ lineEl, index, top: lineEl.getBoundingClientRect().top }))
			.sort((a, b) => a.top - b.top || a.index - b.index);
		const visualLineIndex = sortedLines.findIndex(entry => entry.lineEl === bestLineElement);
		const fallbackLineNumber = Math.max(0, visualLineIndex) + 1;
		const lineNumber = Math.max(
			1,
			Math.min(getLineCount(), topMatchedLineNumber > 0 ? topMatchedLineNumber : textMatchedLine >= 0 ? textMatchedLine + 1 : fallbackLineNumber),
		);
		const maxColumn = getLineMaxColumn(lineNumber);
		if (maxColumn <= 1) {
			this.editor.setPosition({ lineNumber, column: 1 });
			this.editor.focus();
			return;
		}

		const contentLeft = lineRect.left;
		let low = 1;
		let high = maxColumn;
		let bestColumn = 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const visiblePosition = geometryEditor.getScrolledVisiblePosition?.({ lineNumber, column: mid });
			const left = visiblePosition
				? editorRect.left + visiblePosition.left
				: contentLeft + ((mid - 1) / Math.max(1, maxColumn - 1)) * Math.max(1, lineRect.width);
			if (left <= clientX) {
				bestColumn = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		const nextColumn = Math.min(maxColumn, bestColumn + 1);
		const bestVisible = geometryEditor.getScrolledVisiblePosition?.({ lineNumber, column: bestColumn });
		const nextVisible = geometryEditor.getScrolledVisiblePosition?.({ lineNumber, column: nextColumn });
		const bestLeft = bestVisible ? editorRect.left + bestVisible.left : contentLeft;
		const nextLeft = nextVisible ? editorRect.left + nextVisible.left : lineRect.right;
		const column = Math.abs(clientX - nextLeft) < Math.abs(clientX - bestLeft) ? nextColumn : bestColumn;
		this.editor.setPosition({ lineNumber, column: Math.max(1, Math.min(maxColumn, column)) });
		this.editor.focus();
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
		const editorScrollLeft = this.editor?.getScrollLeft() ?? 0;
		const viewLine = this.hostEl.querySelector<HTMLElement>('.view-line');
		const viewLineRect = viewLine?.getBoundingClientRect();
		const contentLeft = viewLineRect?.left ?? hostRect.left + 34;
		const measuredWidth = viewLineRect?.width ?? 0;
		const measuredCharWidth = line.length > 0 && measuredWidth > 0 ? measuredWidth / line.length : 0;
		const charWidth = Number.isFinite(measuredCharWidth) && measuredCharWidth > 2 ? measuredCharWidth : 8;
		const column = Math.round((clientX - contentLeft + editorScrollLeft) / charWidth) + 1;
		return { lineNumber: lineIndex + 1, column: Math.max(1, Math.min(line.length + 1, column)) };
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
				this.noteScrollerProvider?.() ??
				(this.hostEl
					.closest('.markdown-source-view, .markdown-preview-view')
					?.querySelector('.cm-scroller, .markdown-preview-sizer') as HTMLElement | null) ??
				this.attachedParent ??
				this.hostEl,
			nativeInteraction: this.nativeMobileInteraction,
			onActivate: this.activationHandler,
			isEditable: (): boolean => this.modeController.isEditable(),
		});
	}
}
