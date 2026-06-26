interface MonacoEditorLike {
	getSelection(): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty(): boolean } | null;
	getModel(): {
		getWordAtPosition(position: { lineNumber: number; column: number }): { startColumn: number; endColumn: number } | null;
		getLineContent(lineNumber: number): string;
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
		const position =
			(editor ? this.positionFromClientPoint(clientX, clientY, editor) : undefined) ?? editor?.getTargetAtClientPoint?.(clientX, clientY)?.position;
		const model = editor?.getModel();
		if (!editor || !position || !model) {
			return;
		}
		const word = model.getWordAtPosition(position);
		const fallbackWord =
			word && word.endColumn > word.startColumn ? word : this.getWordRangeFromLine(model.getLineContent(position.lineNumber), position.column);
		if (!fallbackWord) {
			editor.setPosition(position);
			this.clearVisualSelection();
			return;
		}
		editor.setSelection({
			startLineNumber: position.lineNumber,
			startColumn: fallbackWord.startColumn,
			endLineNumber: position.lineNumber,
			endColumn: fallbackWord.endColumn,
		});
		this.renderSelectionUi();
	}

	placeCursor(clientX: number, clientY: number, focus = false): { lineNumber: number; column: number } | null {
		const editor = this.editor;
		if (!editor) return null;
		const fallbackPosition = this.positionFromClientPoint(clientX, clientY, editor);
		const hitPosition = editor.getTargetAtClientPoint?.(clientX, clientY)?.position ?? null;
		const hitVisiblePosition = hitPosition ? editor.getScrolledVisiblePosition(hitPosition) : null;
		const editorRect = this.host.querySelector<HTMLElement>('.monaco-editor')?.getBoundingClientRect() ?? this.host.getBoundingClientRect();
		const hitClientLeft = hitVisiblePosition ? editorRect.left + hitVisiblePosition.left : undefined;
		const hitLooksMisaligned = hitClientLeft !== undefined && Math.abs(clientX - hitClientLeft) > 32;
		const position = fallbackPosition ?? (hitPosition && !hitLooksMisaligned ? hitPosition : null);
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
		const model = editor?.getModel?.();
		const draggingHandle = this.draggingHandle;
		if (!editor || !model || !draggingHandle) {
			return;
		}

		const position = editor.getTargetAtClientPoint?.(clientX, clientY)?.position ?? this.positionFromClientPoint(clientX, clientY);
		if (!position) {
			return;
		}

		const selection = editor.getSelection?.();
		if (!selection) {
			return;
		}

		const anchor =
			draggingHandle === 'start'
				? { lineNumber: selection.endLineNumber, column: selection.endColumn }
				: { lineNumber: selection.startLineNumber, column: selection.startColumn };
		editor.setSelection({
			startLineNumber: draggingHandle === 'start' ? position.lineNumber : anchor.lineNumber,
			startColumn: draggingHandle === 'start' ? position.column : anchor.column,
			endLineNumber: draggingHandle === 'start' ? anchor.lineNumber : position.lineNumber,
			endColumn: draggingHandle === 'start' ? anchor.column : position.column,
		});
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

	private positionFromClientPoint(clientX: number, clientY: number, editor = this.editor): { lineNumber: number; column: number } | undefined {
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
		const lineHeight = Math.max(1, rect.height || Number.parseFloat(getComputedStyle(line).lineHeight) || 20);
		const topMatchedLine = Number.parseFloat(line.style.top || '');
		const lineNumber = Math.max(
			1,
			Math.min(
				editor?.getModel()?.getLineCount() ?? lines.length,
				Number.isFinite(topMatchedLine) ? Math.round(topMatchedLine / lineHeight) + 1 : bestIndex + 1,
			),
		);
		const maxColumn = editor?.getModel()?.getLineMaxColumn(lineNumber) ?? (line.textContent?.length ?? 0) + 1;
		if (!editor || maxColumn <= 1) {
			return { lineNumber, column: 1 };
		}

		const editorRect = this.host.querySelector<HTMLElement>('.monaco-editor')?.getBoundingClientRect() ?? this.host.getBoundingClientRect();
		let low = 1;
		let high = maxColumn;
		let bestColumn = 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const visiblePosition = editor.getScrolledVisiblePosition({ lineNumber, column: mid });
			const left = visiblePosition
				? editorRect.left + visiblePosition.left
				: rect.left + ((mid - 1) / Math.max(1, maxColumn - 1)) * Math.max(1, rect.width);
			if (left <= clientX) {
				bestColumn = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		const nextColumn = Math.min(maxColumn, bestColumn + 1);
		const bestVisible = editor.getScrolledVisiblePosition({ lineNumber, column: bestColumn });
		const nextVisible = editor.getScrolledVisiblePosition({ lineNumber, column: nextColumn });
		const bestLeft = bestVisible ? editorRect.left + bestVisible.left : rect.left;
		const nextLeft = nextVisible ? editorRect.left + nextVisible.left : rect.right;
		const column = Math.abs(clientX - nextLeft) < Math.abs(clientX - bestLeft) ? nextColumn : bestColumn;
		return { lineNumber, column: Math.max(1, Math.min(maxColumn, column)) };
	}

	private getWordRangeFromLine(line: string, column: number): { startColumn: number; endColumn: number } | null {
		const index = Math.max(0, Math.min(line.length - 1, column - 1));
		if (!/[A-Za-z0-9_]/.test(line[index] ?? '')) {
			return null;
		}

		let startIndex = index;
		while (startIndex > 0 && /[A-Za-z0-9_]/.test(line[startIndex - 1] ?? '')) {
			startIndex--;
		}

		let endIndex = index + 1;
		while (endIndex < line.length && /[A-Za-z0-9_]/.test(line[endIndex] ?? '')) {
			endIndex++;
		}

		return { startColumn: startIndex + 1, endColumn: endIndex + 1 };
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
