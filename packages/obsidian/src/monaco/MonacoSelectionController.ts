interface MonacoEditorLike {
	getSelection(): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty(): boolean } | null;
	getModel(): {
		getWordAtPosition(position: { lineNumber: number; column: number }): { startColumn: number; endColumn: number } | null;
		getValueInRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string;
		getLineCount(): number;
		getLineMaxColumn(lineNumber: number): number;
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
		const forceToolbarSelectAll = (event: Event): void => {
			const target = event.target instanceof HTMLElement ? event.target.closest('button') : null;
			if (target?.textContent?.trim() !== 'Select All') {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			const editor = this.editor;
			const model = editor?.getModel?.();
			if (!editor || !model) {
				return;
			}
			const lineCount = Math.max(1, model.getLineCount());
			const endColumn = model.getLineMaxColumn(lineCount);
			editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn });
			editor.focus?.();
		};
		for (const eventName of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
			this.toolbar.addEventListener(eventName, forceToolbarSelectAll, true);
		}
		this.toolbar.dataset.shikiSelectAllToolbarCapture = 'true';
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

	placeCursor(clientX: number, clientY: number, focus = false): { lineNumber: number; column: number } | null {
		const editor = this.editor;
		if (!editor) return null;
		const fallbackPosition = this.positionFromClientPoint(clientX, clientY);
		const hitPosition = editor.getTargetAtClientPoint?.(clientX, clientY)?.position ?? null;
		const position = hitPosition ?? fallbackPosition;
		if (!position) return null;
		editor.setPosition(position);
		if (focus) {
			editor.focus();
		}
		this.clearVisualSelection();
		return position;
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
		const position = editor?.getTargetAtClientPoint?.(clientX, clientY)?.position ?? this.positionFromClientPoint(clientX, clientY);
		if (!editor || !selection || !position || !this.draggingHandle) return;
		if (this.draggingHandle === 'start') {
			editor.setSelection({
				startLineNumber: position.lineNumber,
				startColumn: position.column,
				endLineNumber: selection.endLineNumber,
				endColumn: selection.endColumn,
			});
		} else {
			editor.setSelection({
				startLineNumber: selection.startLineNumber,
				startColumn: selection.startColumn,
				endLineNumber: position.lineNumber,
				endColumn: position.column,
			});
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

	private bindHandle(handle: HTMLElement, kind: 'start' | 'end'): void {
		handle.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
			this.draggingHandle = kind;
			const pointerId = event.pointerId;
			const move = (moveEvent: PointerEvent): void => {
				if (moveEvent.pointerId !== pointerId) {
					return;
				}
				moveEvent.preventDefault();
				moveEvent.stopPropagation();
				this.updateHandleDrag(moveEvent.clientX, moveEvent.clientY);
			};
			const end = (endEvent: PointerEvent): void => {
				if (endEvent.pointerId !== pointerId) {
					return;
				}
				endEvent.preventDefault();
				endEvent.stopPropagation();
				document.removeEventListener('pointermove', move, true);
				document.removeEventListener('pointerup', end, true);
				document.removeEventListener('pointercancel', end, true);
				this.endHandleDrag();
			};
			document.addEventListener('pointermove', move, true);
			document.addEventListener('pointerup', end, true);
			document.addEventListener('pointercancel', end, true);
		});
	}

	private positionFromClientPoint(clientX: number, clientY: number): { lineNumber: number; column: number } | undefined {
		const lines = [...this.host.querySelectorAll<HTMLElement>('.view-line')];
		if (lines.length === 0) {
			return undefined;
		}
		let bestIndex = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < lines.length; index++) {
			const rect = lines[index].getBoundingClientRect();
			const centerY = rect.top + rect.height / 2;
			const distance = Math.abs(centerY - clientY);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestIndex = index;
			}
		}
		const line = lines[bestIndex];
		if (!line) {
			return undefined;
		}
		const rect = line.getBoundingClientRect();
		const textLength = line.textContent?.length ?? 0;
		const progress = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
		return {
			lineNumber: bestIndex + 1,
			column: Math.max(1, Math.min(textLength + 1, Math.round(progress * textLength) + 1)),
		};
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
		const lineCount = model.getLineCount();
		const endColumn = model.getLineMaxColumn(lineCount);
		editor.setSelection({
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: lineCount,
			endColumn,
		});
		this.renderSelectionUi();
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

		const copyEvent = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
		copyEvent.clipboardData?.setData('text/plain', value);
		this.host.dispatchEvent(copyEvent);
		if (copyEvent.defaultPrevented) return;

		void navigator.clipboard?.writeText(value);
	}
}
