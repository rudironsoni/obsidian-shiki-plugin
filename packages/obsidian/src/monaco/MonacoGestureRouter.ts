import type { MonacoScrollState } from 'packages/obsidian/src/monaco/MonacoScrollState';
import type { MonacoSelectionController } from 'packages/obsidian/src/monaco/MonacoSelectionController';

interface MonacoEditorLike {
	getScrollLeft(): number;
	setScrollLeft(value: number): void;
	setScrollPosition?(position: { scrollLeft?: number; scrollTop?: number }): void;
	blur?(): void;
	getTargetAtClientPoint?(clientX: number, clientY: number): { position?: { lineNumber: number; column: number } } | null;
	setPosition(position: { lineNumber: number; column: number }): void;
	focus?(): void;
}

interface NativeMobileInteraction {
	placeCursor(position: { lineNumber: number; column: number }): void;
}

type GestureAxis = 'pending' | 'horizontal' | 'vertical' | 'handle';

interface TouchGestureState {
	startX: number;
	startY: number;
	lastY: number;
	startedAt: number;
	scrollLeft: number;
	axis: GestureAxis;
	longPressed: boolean;
	handle: boolean;
}

type TouchGestureHost = HTMLElement & { __shikiMonacoTouchState?: TouchGestureState };

interface MonacoGestureRouterOptions {
	host: HTMLElement;
	editor: MonacoEditorLike;
	selectionController: MonacoSelectionController;
	scrollState: MonacoScrollState;
	getNoteScroller: () => HTMLElement | null;
	nativeInteraction?: NativeMobileInteraction;
	onActivate?: (point: { clientX: number; clientY: number }) => void;
	isEditable?: () => boolean;
}

export class MonacoGestureRouter {
	private readonly host: HTMLElement;
	private readonly editor: MonacoEditorLike;
	private readonly selectionController: MonacoSelectionController;
	private readonly scrollState: MonacoScrollState;
	private readonly getNoteScroller: () => HTMLElement | null;
	private readonly isEditable: () => boolean;
	private nativeInteraction: NativeMobileInteraction | undefined;
	private onActivate: ((point: { clientX: number; clientY: number }) => void) | undefined;
	private mouseDown: { clientX: number; clientY: number; button: number } | null = null;
	private touchState: TouchGestureState | null = null;
	private lastReadonlyNativePosition: { lineNumber: number; column: number } | undefined;
	private lastTouchTime = 0;
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private longPressActivated = false;
	private pointerTouchStart: { pointerId: number; clientX: number; clientY: number; lastY: number; scrollLeft: number; axis: GestureAxis } | null = null;

	constructor(options: MonacoGestureRouterOptions) {
		this.host = options.host;
		this.editor = options.editor;
		this.selectionController = options.selectionController;
		this.scrollState = options.scrollState;
		this.getNoteScroller = options.getNoteScroller;
		this.nativeInteraction = options.nativeInteraction;
		this.isEditable = options.isEditable ?? ((): boolean => false);
		this.onActivate = options.onActivate;

		this.host.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
		this.host.addEventListener('touchstart', this.onTouchStart, { passive: false, capture: true });
		this.host.addEventListener('touchmove', this.onTouchMove, { passive: false, capture: true });
		this.host.addEventListener('touchend', this.onTouchEnd, { passive: false, capture: true });
		this.host.addEventListener('touchcancel', this.onTouchCancel, { passive: false, capture: true });
		this.host.addEventListener('pointerdown', this.onPointerDown, { passive: true, capture: true });
		this.host.addEventListener('pointermove', this.onPointerMove, { passive: false, capture: true });
		this.host.addEventListener('pointerup', this.onPointerUp, { passive: false, capture: true });
		this.host.addEventListener('pointercancel', this.onPointerCancel, { passive: true, capture: true });
		this.host.addEventListener('focusin', this.onFocusIn, true);
		this.host.addEventListener('mousedown', this.onMouseDown, true);
		this.host.addEventListener('mouseup', this.onMouseUp, true);
		this.host.addEventListener('mouseup', this.onMouseUpBubble);
		this.host.addEventListener('click', this.onClick, true);
		this.host.addEventListener('click', this.onClickBubble);
		document.addEventListener('touchstart', this.onTouchStart, { passive: false, capture: true });
		document.addEventListener('touchmove', this.onTouchMove, { passive: false, capture: true });
		document.addEventListener('touchend', this.onTouchEnd, { passive: false, capture: true });
		document.addEventListener('touchcancel', this.onTouchCancel, { passive: false, capture: true });
		document.addEventListener('mousedown', this.onDocumentMouseDown, true);
		document.addEventListener('mouseup', this.onDocumentMouseUp, true);
		document.addEventListener('click', this.onDocumentClick, true);
	}

	setNativeInteraction(nativeInteraction: NativeMobileInteraction | undefined): void {
		this.nativeInteraction = nativeInteraction;
	}

	setActivationHandler(onActivate: ((point: { clientX: number; clientY: number }) => void) | undefined): void {
		this.onActivate = onActivate;
	}

	dispose(): void {
		this.clearLongPressTimer();
		this.host.removeEventListener('wheel', this.onWheel, { capture: true });
		this.host.removeEventListener('touchstart', this.onTouchStart, true);
		this.host.removeEventListener('touchmove', this.onTouchMove, true);
		this.host.removeEventListener('touchend', this.onTouchEnd, true);
		this.host.removeEventListener('touchcancel', this.onTouchCancel, true);
		this.host.removeEventListener('pointerdown', this.onPointerDown, true);
		this.host.removeEventListener('pointermove', this.onPointerMove, true);
		this.host.removeEventListener('pointerup', this.onPointerUp, true);
		this.host.removeEventListener('pointercancel', this.onPointerCancel, true);
		this.host.removeEventListener('focusin', this.onFocusIn, true);
		this.host.removeEventListener('mousedown', this.onMouseDown, true);
		this.host.removeEventListener('mouseup', this.onMouseUp, true);
		this.host.removeEventListener('mouseup', this.onMouseUpBubble);
		this.host.removeEventListener('click', this.onClick, true);
		this.host.removeEventListener('click', this.onClickBubble);
		document.removeEventListener('touchstart', this.onTouchStart, true);
		document.removeEventListener('touchmove', this.onTouchMove, true);
		document.removeEventListener('touchend', this.onTouchEnd, true);
		document.removeEventListener('touchcancel', this.onTouchCancel, true);
		document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
		document.removeEventListener('mouseup', this.onDocumentMouseUp, true);
		document.removeEventListener('click', this.onDocumentClick, true);
	}

	private readonly onWheel = (event: WheelEvent): void => {
		const horizontalDelta = event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY) ? event.deltaY : event.deltaX;
		const isHorizontalIntent = event.shiftKey ? horizontalDelta !== 0 : Math.abs(horizontalDelta) > Math.abs(event.deltaY);
		if (!isHorizontalIntent) {
			const noteScroller = this.getNoteScroller();
			if (noteScroller && event.deltaY !== 0) {
				noteScroller.scrollTop += event.deltaY;
			}
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		this.setScrollLeft(this.editor.getScrollLeft() + horizontalDelta);
	};

	private readonly onMouseDown = (event: MouseEvent): void => {
		if (this.isSelectionUiEvent(event) || Date.now() - this.lastTouchTime < 700 || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) {
			this.mouseDown = null;
			return;
		}
		this.mouseDown = { clientX: event.clientX, clientY: event.clientY, button: event.button };
		if (!this.isEditable()) {
			this.onActivate?.({ clientX: event.clientX, clientY: event.clientY });
		}
	};

	private traceGesture(event: string, detail: Record<string, unknown> = {}): void {
		const target = (window as unknown as { __shikiMonacoGestureTrace?: unknown }).__shikiMonacoGestureTrace;
		if (!Array.isArray(target)) {
			return;
		}
		target.push({ event, ...detail });
	}

	readonly onPointerDown = (event: PointerEvent): void => {
		this.traceGesture('pointerdown:start', { pointerType: event.pointerType, isPrimary: event.isPrimary, clientX: event.clientX, clientY: event.clientY });
		if (!event.isPrimary || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) {
			this.traceGesture('pointerdown:ignored-kind', { pointerType: event.pointerType, isPrimary: event.isPrimary });
			return;
		}
		const targetNode = event.target instanceof Node ? event.target : null;
		const eventStartedInsideHost = targetNode ? this.host.contains(targetNode) : false;
		if (!eventStartedInsideHost && !this.isPointInsideHost(event.clientX, event.clientY)) {
			this.traceGesture('pointerdown:outside', { clientX: event.clientX, clientY: event.clientY });
			return;
		}
		this.longPressActivated = false;
		this.pointerTouchStart = {
			pointerId: event.pointerId,
			clientX: event.clientX,
			clientY: event.clientY,
			lastY: event.clientY,
			scrollLeft: this.editor.getScrollLeft(),
			axis: 'pending',
		};
		this.clearLongPressTimer();
		this.longPressTimer = setTimeout(() => {
			this.longPressActivated = true;
			this.selectionController.selectWordAt(event.clientX, event.clientY);
		}, 700);
	};

	readonly onPointerMove = (event: PointerEvent): void => {
		const state = this.pointerTouchStart;
		if (event.pointerId !== state?.pointerId || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) {
			return;
		}
		const dx = event.clientX - state.clientX;
		const dy = event.clientY - state.clientY;
		if (state.axis === 'pending' && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
			state.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
			this.clearLongPressTimer();
		}
		if (state.axis === 'horizontal') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.setScrollLeft(state.scrollLeft - dx);
			return;
		}
		if (state.axis === 'vertical') {
			const noteScroller = this.getNoteScroller();
			if (noteScroller) {
				event.preventDefault();
				event.stopImmediatePropagation();
				noteScroller.scrollTop += state.lastY - event.clientY;
			}
			state.lastY = event.clientY;
		}
	};

	readonly onPointerUp = (event: PointerEvent): void => {
		this.traceGesture('pointerup:start', {
			pointerType: event.pointerType,
			isPrimary: event.isPrimary,
			pointerId: event.pointerId,
			clientX: event.clientX,
			clientY: event.clientY,
			hasStart: Boolean(this.pointerTouchStart),
			startPointerId: this.pointerTouchStart?.pointerId,
		});
		if (event.pointerId !== this.pointerTouchStart?.pointerId) {
			this.traceGesture('pointerup:ignored-no-start', { pointerId: event.pointerId });
			return;
		}
		this.clearLongPressTimer();
		const start = this.pointerTouchStart;
		this.pointerTouchStart = null;
		if (this.longPressActivated) {
			this.longPressActivated = false;
			return;
		}
		if (Math.abs(event.clientX - start.clientX) > 6 || Math.abs(event.clientY - start.clientY) > 6) {
			this.traceGesture('pointerup:ignored-moved', { dx: event.clientX - start.clientX, dy: event.clientY - start.clientY });
			return;
		}
		if (!this.isEditable()) {
			event.preventDefault();
			event.stopImmediatePropagation();
			const nativePosition = this.positionFromClientPoint(event.clientX, event.clientY);
			this.lastReadonlyNativePosition = nativePosition;
			this.blurMonacoFocusTarget();
			if (nativePosition) {
				this.nativeInteraction?.placeCursor(nativePosition);
				for (const delayMs of [25, 75, 150, 225])
					window.setTimeout(() => {
						this.blurMonacoFocusTarget();
						this.nativeInteraction?.placeCursor(nativePosition);
					}, delayMs);
			}
			return;
		}
		this.traceGesture('pointerup:focus', { clientX: event.clientX, clientY: event.clientY });
		this.focusEditorAtPoint(event.clientX, event.clientY);
		this.deferFocusEditorAtPoint(event.clientX, event.clientY);
	};

	readonly onPointerCancel = (event: PointerEvent): void => {
		if (event.pointerId !== this.pointerTouchStart?.pointerId) {
			return;
		}
		this.clearLongPressTimer();
		this.pointerTouchStart = null;
		this.longPressActivated = false;
	};

	private readonly onTouchStart = (event: TouchEvent): void => {
		this.lastTouchTime = Date.now();
		const touch = event.touches[0];
		if (!touch) return;
		const targetNode = event.target instanceof Node ? event.target : null;
		if (targetNode && !this.host.contains(targetNode) && !this.isPointInsideHost(touch.clientX, touch.clientY)) {
			this.touchState = null;
			delete (this.host as TouchGestureHost).__shikiMonacoTouchState;
			return;
		}
		const handle = this.selectionController.startHandleDrag(document.elementFromPoint(touch.clientX, touch.clientY) ?? event.target);
		this.longPressActivated = false;
		this.touchState = {
			startX: touch.clientX,
			startY: touch.clientY,
			lastY: touch.clientY,
			startedAt: Date.now(),
			scrollLeft: this.editor.getScrollLeft(),
			longPressed: false,
			axis: handle ? 'handle' : 'pending',
			handle,
		};
		(this.host as TouchGestureHost).__shikiMonacoTouchState = this.touchState;
		if (handle) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		this.clearLongPressTimer();
		this.longPressTimer = setTimeout(() => {
			if (this.touchState) {
				this.touchState.longPressed = true;
			}
			this.longPressActivated = true;
			this.selectionController.selectWordAt(touch.clientX, touch.clientY);
		}, 450);
	};

	private readonly onTouchMove = (event: TouchEvent): void => {
		const touch = event.touches[0];
		if (!touch || !this.touchState) return;
		if (this.touchState.axis === 'handle') {
			event.preventDefault();
			event.stopPropagation();
			this.selectionController.updateHandleDrag(touch.clientX, touch.clientY);
			return;
		}

		const dx = touch.clientX - this.touchState.startX;
		const dy = touch.clientY - this.touchState.startY;
		if (this.touchState?.axis === 'pending' && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
			this.touchState.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
			if (this.touchState.axis === 'horizontal') {
				this.clearLongPressTimer();
			}
		}

		if (this.touchState.axis === 'horizontal') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.setScrollLeft(this.touchState.scrollLeft - dx);
			return;
		}
		if (this.touchState.axis === 'vertical') {
			this.clearLongPressTimer();
			const noteScroller = this.getNoteScroller();
			if (noteScroller) {
				event.preventDefault();
				event.stopImmediatePropagation();
				noteScroller.scrollTop += this.touchState.lastY - touch.clientY;
			}
			this.touchState.lastY = touch.clientY;
		}
	};

	private readonly onTouchEnd = (event: TouchEvent): void => {
		this.lastTouchTime = Date.now();
		const touch = event.changedTouches[0];
		const state = this.touchState ?? (this.host as TouchGestureHost).__shikiMonacoTouchState ?? null;
		this.touchState = null;
		delete (this.host as TouchGestureHost).__shikiMonacoTouchState;
		this.selectionController.endHandleDrag();
		this.clearLongPressTimer();
		if (this.longPressActivated) {
			this.touchState = null;
			this.longPressActivated = false;
			return;
		}

		if (state?.longPressed) {
			event.preventDefault();
			event.stopPropagation();
			this.touchState = null;
			this.lastTouchTime = Date.now();
			return;
		}
		if (state?.axis === 'pending' && Date.now() - state.startedAt >= 450) {
			event.preventDefault();
			event.stopPropagation();
			this.selectionController.selectWordAt(state.startX, state.startY);
			this.touchState = null;
			this.lastTouchTime = Date.now();
			return;
		}
		if (!touch || state?.axis !== 'pending') return;
		const nativePosition = this.positionFromClientPoint(touch.clientX, touch.clientY) ?? null;
		if (this.isEditable()) {
			event.preventDefault();
			event.stopPropagation();
			const placedPosition = nativePosition ?? this.selectionController.placeCursor(touch.clientX, touch.clientY, true);
			if (placedPosition) {
				this.editor.setPosition(placedPosition);
			}
			this.editor.focus?.();
			window.setTimeout(() => {
				if (placedPosition) {
					this.editor.setPosition(placedPosition);
				}
				this.editor.focus?.();
			}, 0);
			this.lastTouchTime = Date.now();
			return;
		}

		if (nativePosition && this.nativeInteraction && !this.isEditable()) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.lastReadonlyNativePosition = nativePosition;
			this.blurMonacoFocusTarget();
			this.nativeInteraction.placeCursor(nativePosition);
			for (const delayMs of [25, 75, 150, 225])
				window.setTimeout(() => {
					this.blurMonacoFocusTarget();
					this.nativeInteraction?.placeCursor(nativePosition);
				}, delayMs);
			return;
		}
		this.selectionController.placeCursor(touch.clientX, touch.clientY);
	};
	private readonly onMouseUp = (event: MouseEvent): void => {
		const mouseDown = this.mouseDown;
		this.mouseDown = null;
		if (
			this.isSelectionUiEvent(event) ||
			!mouseDown ||
			!this.isEditable() ||
			event.button !== 0 ||
			event.detail > 1 ||
			event.shiftKey ||
			event.altKey ||
			event.metaKey ||
			event.ctrlKey
		) {
			return;
		}
		if (Math.abs(event.clientX - mouseDown.clientX) > 3 || Math.abs(event.clientY - mouseDown.clientY) > 3) {
			return;
		}
		this.focusEditorAtPoint(event.clientX, event.clientY);
		this.deferFocusEditorAtPoint(event.clientX, event.clientY);
	};

	private readonly onMouseUpBubble = (event: MouseEvent): void => {
		this.onMouseUp(event);
	};
	private readonly onClick = (event: MouseEvent): void => {
		if (
			this.isSelectionUiEvent(event) ||
			!this.isEditable() ||
			event.button !== 0 ||
			event.detail > 1 ||
			event.shiftKey ||
			event.altKey ||
			event.metaKey ||
			event.ctrlKey
		) {
			return;
		}
		this.focusEditorAtPoint(event.clientX, event.clientY);
		this.deferFocusEditorAtPoint(event.clientX, event.clientY);
	};

	private readonly onClickBubble = (event: MouseEvent): void => {
		this.onClick(event);
	};

	private readonly onFocusIn = (event: FocusEvent): void => {
		if (this.isEditable()) {
			return;
		}
		const target = event.target;
		if (!(target instanceof HTMLElement) || !this.host.contains(target)) {
			return;
		}
		this.blurMonacoFocusTarget();
		const nativePosition = this.lastReadonlyNativePosition;
		if (!nativePosition) {
			return;
		}
		this.nativeInteraction?.placeCursor(nativePosition);
		window.setTimeout(() => {
			this.blurMonacoFocusTarget();
			this.nativeInteraction?.placeCursor(nativePosition);
		}, 0);
	};

	private isPointInsideHost(clientX: number, clientY: number): boolean {
		const rect = this.host.getBoundingClientRect();
		return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
	}

	private isPlainPrimaryMouse(event: MouseEvent): boolean {
		return event.button === 0 && event.detail <= 1 && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
	}

	private readonly onDocumentMouseDown = (event: MouseEvent): void => {
		if (!this.isEditable() || this.isSelectionUiEvent(event) || !this.isPlainPrimaryMouse(event) || !this.isPointInsideHost(event.clientX, event.clientY)) {
			return;
		}
		this.mouseDown = { clientX: event.clientX, clientY: event.clientY, button: event.button };
	};

	private readonly onDocumentMouseUp = (event: MouseEvent): void => {
		const mouseDown = this.mouseDown;
		if (!this.isEditable() || this.isSelectionUiEvent(event) || !this.isPlainPrimaryMouse(event) || !this.isPointInsideHost(event.clientX, event.clientY)) {
			return;
		}
		if (mouseDown && (Math.abs(event.clientX - mouseDown.clientX) > 3 || Math.abs(event.clientY - mouseDown.clientY) > 3)) {
			return;
		}
		this.focusEditorAtPoint(event.clientX, event.clientY);
		this.deferFocusEditorAtPoint(event.clientX, event.clientY);
	};

	private readonly onDocumentClick = (event: MouseEvent): void => {
		if (!this.isEditable() || this.isSelectionUiEvent(event) || !this.isPlainPrimaryMouse(event) || !this.isPointInsideHost(event.clientX, event.clientY)) {
			return;
		}
		this.focusEditorAtPoint(event.clientX, event.clientY);
		this.deferFocusEditorAtPoint(event.clientX, event.clientY);
	};

	private isSelectionUiEvent(event: Event): boolean {
		const target = event.target instanceof HTMLElement ? event.target : null;
		return target?.closest('.shiki-monaco-selection-toolbar, .shiki-monaco-selection-handle') !== null;
	}

	private readonly onTouchCancel = (): void => {
		this.lastTouchTime = Date.now();
		this.touchState = null;
		delete (this.host as TouchGestureHost).__shikiMonacoTouchState;
		this.selectionController.endHandleDrag();
		this.clearLongPressTimer();
	};

	private blurMonacoFocusTarget(): void {
		this.editor.blur?.();
		const active = document.activeElement;
		if (active instanceof HTMLElement && this.host.contains(active)) {
			active.blur();
		}
	}

	private setScrollLeft(scrollLeft: number): void {
		const nextScrollLeft = Math.max(0, scrollLeft);
		this.editor.setScrollPosition?.({ scrollLeft: nextScrollLeft });
		this.editor.setScrollLeft(nextScrollLeft);
		if (this.editor.getScrollLeft() !== nextScrollLeft) {
			window.requestAnimationFrame(() => {
				this.editor.setScrollPosition?.({ scrollLeft: nextScrollLeft });
				this.editor.setScrollLeft(nextScrollLeft);
				this.scrollState.setScrollLeft(this.editor.getScrollLeft());
				this.resetAncestorHorizontalScroll();
			});
		}
		this.scrollState.setScrollLeft(this.editor.getScrollLeft());
		this.resetAncestorHorizontalScroll();
	}

	private resetAncestorHorizontalScroll(): void {
		let current: HTMLElement | null = this.host.parentElement;
		while (current && current !== document.body) {
			if (!current.classList.contains('monaco-scrollable-element') && current.scrollLeft !== 0) {
				current.scrollLeft = 0;
			}
			current = current.parentElement;
		}
	}

	private clearLongPressTimer(): void {
		if (!this.longPressTimer) return;
		clearTimeout(this.longPressTimer);
		this.longPressTimer = null;
	}
	private deferFocusEditorAtPoint(clientX: number, clientY: number): void {
		for (const delayMs of [50, 150, 300]) {
			window.setTimeout(() => {
				this.focusEditorAtPoint(clientX, clientY);
			}, delayMs);
		}
	}

	private focusEditorAtPoint(clientX: number, clientY: number): void {
		const position = this.positionFromClientPoint(clientX, clientY);
		if (position) {
			(
				this.editor as MonacoEditorLike & {
					setSelection?: (selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => void;
				}
			).setSelection?.({
				startLineNumber: position.lineNumber,
				startColumn: position.column,
				endLineNumber: position.lineNumber,
				endColumn: position.column,
			});
			this.editor.setPosition(position);
		}
		this.editor.focus?.();
	}

	private positionFromClientPoint(clientX: number, clientY: number): { lineNumber: number; column: number } | undefined {
		const hitPosition = this.editor.getTargetAtClientPoint?.(clientX, clientY)?.position;
		const editorWithModel = this.editor as MonacoEditorLike & {
			getModel?: () => { getLineCount(): number; getLineContent(lineNumber: number): string; getLineMaxColumn(lineNumber: number): number } | null;
			getScrollTop?: () => number;
		};
		const model = editorWithModel.getModel?.();
		if (model === undefined || model === null) {
			const editorWithModel = this.editor as MonacoEditorLike & {
				getModel?: () => {
					getValue?: () => string;
					getLineCount?: () => number;
					getLineMaxColumn?: (lineNumber: number) => number;
				} | null;
				getTargetAtClientPoint?: (clientX: number, clientY: number) => { position?: { lineNumber: number; column: number } } | null;
				getScrolledVisiblePosition?: (position: { lineNumber: number; column: number }) => { left: number } | null;
			};
			const model = editorWithModel.getModel?.();
			const modelValue = model?.getValue?.() ?? '';
			const modelLines = modelValue.split(/\r\n|\r|\n/);
			const getLineCount = (): number => model?.getLineCount?.() ?? Math.max(1, modelLines.length);
			const getLineMaxColumn = (lineNumber: number): number => model?.getLineMaxColumn?.(lineNumber) ?? (modelLines[lineNumber - 1] ?? '').length + 1;

			const targetPosition = editorWithModel.getTargetAtClientPoint?.(clientX, clientY)?.position;
			const firstViewLineRect = this.host.querySelector<HTMLElement>('.view-line')?.getBoundingClientRect();
			const pointInsideFirstViewLine = firstViewLineRect ? clientY >= firstViewLineRect.top && clientY <= firstViewLineRect.bottom : false;
			const targetLooksStaleNativeMobile =
				document.activeElement?.classList?.contains('native-edit-context') === true &&
				targetPosition?.lineNumber === 1 &&
				targetPosition.column === 1 &&
				this.host.querySelectorAll('.view-line').length > 0 &&
				!pointInsideFirstViewLine;
			const targetVisiblePosition = targetPosition ? editorWithModel.getScrolledVisiblePosition?.(targetPosition) : null;
			const editorRect = (this.host.querySelector<HTMLElement>('.monaco-editor') ?? this.host).getBoundingClientRect();
			const targetClientLeft = targetVisiblePosition ? editorRect.left + targetVisiblePosition.left : undefined;
			const targetLooksMisaligned = targetClientLeft !== undefined && Math.abs(clientX - targetClientLeft) > 32;
			if (targetPosition && !targetLooksStaleNativeMobile && !targetLooksMisaligned) {
				const lineNumber = Math.max(1, Math.min(getLineCount(), targetPosition.lineNumber));
				return {
					lineNumber,
					column: Math.max(1, Math.min(getLineMaxColumn(lineNumber), targetPosition.column)),
				};
			}

			const viewLines = Array.from(this.host.querySelectorAll<HTMLElement>('.view-line'));
			if (viewLines.length === 0) {
				return undefined;
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
				return undefined;
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
				return { lineNumber, column: 1 };
			}

			const contentLeft = lineRect.left;
			let low = 1;
			let high = maxColumn;
			let bestColumn = 1;
			while (low <= high) {
				const mid = Math.floor((low + high) / 2);
				const visiblePosition = editorWithModel.getScrolledVisiblePosition?.({ lineNumber, column: mid });
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
			const bestVisible = editorWithModel.getScrolledVisiblePosition?.({ lineNumber, column: bestColumn });
			const nextVisible = editorWithModel.getScrolledVisiblePosition?.({ lineNumber, column: nextColumn });
			const bestLeft = bestVisible ? editorRect.left + bestVisible.left : contentLeft;
			const nextLeft = nextVisible ? editorRect.left + nextVisible.left : lineRect.right;
			const column = Math.abs(clientX - nextLeft) < Math.abs(clientX - bestLeft) ? nextColumn : bestColumn;
			return { lineNumber, column: Math.max(1, Math.min(maxColumn, column)) };
		}
		const editorEl = this.host.querySelector<HTMLElement>('.monaco-editor') ?? this.host;
		const rect = editorEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			return hitPosition ?? undefined;
		}
		const lineEl = this.host.querySelector<HTMLElement>('.view-line');
		const measuredLineHeight = lineEl?.getBoundingClientRect().height ?? 0;
		const lineHeight = measuredLineHeight > 0 ? measuredLineHeight : 20;
		const scrollLeft = this.editor.getScrollLeft?.() ?? 0;
		const lineCount = model.getLineCount();
		const lineNumber = Math.max(1, Math.min(lineCount, Math.floor((clientY - rect.top) / lineHeight) + 1));
		const maxColumn = model.getLineMaxColumn(lineNumber);
		const geometryEditor = this.editor as MonacoEditorLike & {
			getScrolledVisiblePosition?: (position: { lineNumber: number; column: number }) => { left: number; top: number; height: number } | null;
		};
		let column = 1;
		let closestDistance = Number.POSITIVE_INFINITY;
		if (geometryEditor.getScrolledVisiblePosition !== undefined) {
			const targetLeft = clientX - rect.left;
			for (let candidate = 1; candidate <= maxColumn; candidate++) {
				const visible = geometryEditor.getScrolledVisiblePosition({ lineNumber, column: candidate });
				if (visible === null) {
					continue;
				}
				const distance = Math.abs(visible.left - targetLeft);
				if (distance < closestDistance) {
					closestDistance = distance;
					column = candidate;
				}
			}
		} else {
			const lineContent = model.getLineContent(lineNumber);
			const contentLeft = rect.left + 34;
			const measuredCharWidth = lineEl !== null && lineContent.length > 0 ? lineEl.getBoundingClientRect().width / Math.max(1, lineContent.length) : 0;
			const charWidth = Number.isFinite(measuredCharWidth) && measuredCharWidth > 2 ? measuredCharWidth : 8;
			column = Math.max(1, Math.min(maxColumn, Math.round((clientX - contentLeft + scrollLeft) / charWidth) + 1));
		}
		return { lineNumber, column };
	}
}
