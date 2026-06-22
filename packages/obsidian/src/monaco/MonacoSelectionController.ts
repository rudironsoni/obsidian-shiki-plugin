interface MonacoEditorLike {
	getSelection(): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty(): boolean } | null;
	getModel(): {
		getWordAtPosition(position: { lineNumber: number; column: number }): { startColumn: number; endColumn: number } | null;
		getValueInRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string;
	} | null;
	getScrolledVisiblePosition(position: { lineNumber: number; column: number }): { left: number; top: number; height: number } | null;
	getTargetAtClientPoint?(clientX: number, clientY: number): { position?: { lineNumber: number; column: number } } | null;
	setPosition(position: { lineNumber: number; column: number }): void;
	setSelection(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): void;
	focus(): void;
	onDidChangeCursorSelection(callback: () => void): { dispose(): void };
	onDidScrollChange(callback: () => void): { dispose(): void };
	onDidLayoutChange(callback: () => void): { dispose(): void };
	onDidContentSizeChange(callback: () => void): { dispose(): void };
	onDidChangeModelContent(callback: () => void): { dispose(): void };
}

export class MonacoSelectionController {
	private readonly host: HTMLElement;
	private readonly toolbar: HTMLDivElement;
	private readonly startHandle: HTMLDivElement;
	private readonly endHandle: HTMLDivElement;
	private editor: MonacoEditorLike | undefined;
	private disposables: { dispose(): void }[] = [];
	private draggingHandle: 'start' | 'end' | undefined;

	constructor(host: HTMLElement) {
		this.host = host;
		this.toolbar = document.createElement('div');
		this.toolbar.className = 'shiki-monaco-selection-toolbar';
		this.toolbar.hidden = true;
		this.startHandle = document.createElement('div');
		this.startHandle.className = 'shiki-monaco-selection-handle is-start';
		this.startHandle.hidden = true;
		this.endHandle = document.createElement('div');
		this.endHandle.className = 'shiki-monaco-selection-handle is-end';
		this.endHandle.hidden = true;

		for (const [label, handler] of [
			['Copy', (): void => this.copySelection()],
			['Select All', (): void => this.selectAll()],
			['Clear', (): void => this.clearSelection()],
		] as const) {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = label;
			button.addEventListener('click', handler);
			this.toolbar.appendChild(button);
		}

		this.host.append(this.toolbar, this.startHandle, this.endHandle);
		this.bindHandle(this.startHandle, 'start');
		this.bindHandle(this.endHandle, 'end');
	}

	attach(editor: MonacoEditorLike): void {
		this.editor = editor;
		this.disposables.forEach(disposable => disposable.dispose());
		this.disposables = [
			editor.onDidChangeCursorSelection(() => this.renderSelectionUi()),
			editor.onDidScrollChange(() => this.renderSelectionUi()),
			editor.onDidLayoutChange(() => this.renderSelectionUi()),
			editor.onDidContentSizeChange(() => this.renderSelectionUi()),
			editor.onDidChangeModelContent(() => this.renderSelectionUi()),
		];
		this.renderSelectionUi();
	}

	detach(): void {
		this.editor = undefined;
		this.disposables.forEach(disposable => disposable.dispose());
		this.disposables = [];
		this.clearVisualSelection();
	}

	getSelectionText(): string {
		const selection = this.editor?.getSelection();
		const model = this.editor?.getModel();
		if (!selection || !model || selection.isEmpty()) {
			return '';
		}
		return model.getValueInRange(selection);
	}

	selectWordAt(clientX: number, clientY: number): void {
		const editor = this.editor;
		const position = editor?.getTargetAtClientPoint?.(clientX, clientY)?.position;
		const model = editor?.getModel();
		if (!editor || !position || !model) {
			return;
		}
		const word = model.getWordAtPosition(position);
		if (!word) {
			editor.setPosition(position);
			return;
		}
		editor.setSelection({
			startLineNumber: position.lineNumber,
			startColumn: word.startColumn,
			endLineNumber: position.lineNumber,
			endColumn: word.endColumn,
		});
	}

	placeCursor(clientX: number, clientY: number, focus: boolean): void {
		const editor = this.editor;
		const position = editor?.getTargetAtClientPoint?.(clientX, clientY)?.position;
		if (!editor || !position) {
			return;
		}
		editor.setPosition(position);
		if (focus) {
			editor.focus();
		}
	}

	isHandleTarget(target: EventTarget | null): boolean {
		return target === this.startHandle || target === this.endHandle;
	}

	startHandleDrag(target: EventTarget | null): boolean {
		if (target === this.startHandle) {
			this.draggingHandle = 'start';
			return true;
		}
		if (target === this.endHandle) {
			this.draggingHandle = 'end';
			return true;
		}
		return false;
	}

	updateHandleDrag(clientX: number, clientY: number): void {
		const editor = this.editor;
		const selection = editor?.getSelection();
		const position = editor?.getTargetAtClientPoint?.(clientX, clientY)?.position;
		if (!editor || !selection || !position || !this.draggingHandle) {
			return;
		}
		if (this.draggingHandle === 'start') {
			editor.setSelection({ ...selection, startLineNumber: position.lineNumber, startColumn: position.column });
		} else {
			editor.setSelection({ ...selection, endLineNumber: position.lineNumber, endColumn: position.column });
		}
	}

	endHandleDrag(): void {
		this.draggingHandle = undefined;
	}

	dispose(): void {
		this.detach();
		this.toolbar.remove();
		this.startHandle.remove();
		this.endHandle.remove();
	}

	private bindHandle(handle: HTMLDivElement, kind: 'start' | 'end'): void {
		handle.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
			this.draggingHandle = kind;
		});
	}

	private clearVisualSelection(): void {
		this.toolbar.hidden = true;
		this.startHandle.hidden = true;
		this.endHandle.hidden = true;
	}

	private renderSelectionUi(): void {
		const editor = this.editor;
		const selection = editor?.getSelection();
		if (!editor || !selection || selection.isEmpty()) {
			this.clearVisualSelection();
			return;
		}

		const start = editor.getScrolledVisiblePosition({ lineNumber: selection.startLineNumber, column: selection.startColumn });
		const end = editor.getScrolledVisiblePosition({ lineNumber: selection.endLineNumber, column: selection.endColumn });
		if (!start || !end) {
			this.clearVisualSelection();
			return;
		}

		this.positionHandle(this.startHandle, start.left, start.top + start.height);
		this.positionHandle(this.endHandle, end.left, end.top + end.height);
		this.positionToolbar((start.left + end.left) / 2, Math.min(start.top, end.top) - 32);
	}

	private positionHandle(handle: HTMLDivElement, left: number, top: number): void {
		handle.hidden = false;
		handle.style.left = `${left}px`;
		handle.style.top = `${top}px`;
	}

	private positionToolbar(centerX: number, top: number): void {
		this.toolbar.hidden = false;
		this.toolbar.style.left = `${centerX}px`;
		this.toolbar.style.top = `${Math.max(0, top)}px`;
	}

	private selectAll(): void {
		const editor = this.editor;
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}
		const value = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: Number.MAX_SAFE_INTEGER, endColumn: Number.MAX_SAFE_INTEGER });
		const lines = value.split('\n');
		editor.setSelection({
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: lines.length,
			endColumn: (lines[lines.length - 1]?.length ?? 0) + 1,
		});
	}

	private clearSelection(): void {
		const editor = this.editor;
		const selection = editor?.getSelection();
		if (!editor || !selection) {
			return;
		}
		editor.setPosition({ lineNumber: selection.endLineNumber, column: selection.endColumn });
		this.clearVisualSelection();
	}

	private copySelection(): void {
		const value = this.getSelectionText();
		if (!value) {
			return;
		}
		void navigator.clipboard?.writeText(value);
	}
}
