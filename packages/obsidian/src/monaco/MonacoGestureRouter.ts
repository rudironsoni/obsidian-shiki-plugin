import type { MonacoScrollState } from 'packages/obsidian/src/monaco/MonacoScrollState';
import type { MonacoSelectionController } from 'packages/obsidian/src/monaco/MonacoSelectionController';

interface MonacoEditorLike {
	getScrollLeft(): number;
	setScrollLeft(value: number): void;
	blur?(): void;
	getTargetAtClientPoint?(clientX: number, clientY: number): { position?: { lineNumber: number; column: number } } | null;
}

interface NativeMobileInteraction {
	placeCursor(position: { lineNumber: number; column: number }): void;
}

type GestureAxis = 'pending' | 'horizontal' | 'vertical' | 'handle';

interface MonacoGestureRouterOptions {
	host: HTMLElement;
	editor: MonacoEditorLike;
	selectionController: MonacoSelectionController;
	scrollState: MonacoScrollState;
	getNoteScroller: () => HTMLElement | null;
	nativeInteraction?: NativeMobileInteraction;
	onActivate?: (point: { clientX: number; clientY: number }) => void;
}

export class MonacoGestureRouter {
	private readonly host: HTMLElement;
	private readonly editor: MonacoEditorLike;
	private readonly selectionController: MonacoSelectionController;
	private readonly scrollState: MonacoScrollState;
	private readonly getNoteScroller: () => HTMLElement | null;
	private nativeInteraction: NativeMobileInteraction | undefined;
	private onActivate: ((point: { clientX: number; clientY: number }) => void) | undefined;
	private touchState: { startX: number; startY: number; scrollLeft: number; axis: GestureAxis; handle: boolean } | null = null;
	private lastTouchTime = 0;
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: MonacoGestureRouterOptions) {
		this.host = options.host;
		this.editor = options.editor;
		this.selectionController = options.selectionController;
		this.scrollState = options.scrollState;
		this.getNoteScroller = options.getNoteScroller;
		this.nativeInteraction = options.nativeInteraction;
		this.onActivate = options.onActivate;

		this.host.addEventListener('wheel', this.onWheel, { passive: false });
		this.host.addEventListener('touchstart', this.onTouchStart, { passive: false, capture: true });
		this.host.addEventListener('touchmove', this.onTouchMove, { passive: false, capture: true });
		this.host.addEventListener('touchend', this.onTouchEnd, { passive: false, capture: true });
		this.host.addEventListener('touchcancel', this.onTouchCancel, { passive: false, capture: true });
		this.host.addEventListener('mousedown', this.onMouseDown, true);
	}

	setNativeInteraction(nativeInteraction: NativeMobileInteraction | undefined): void {
		this.nativeInteraction = nativeInteraction;
	}

	setActivationHandler(onActivate: ((point: { clientX: number; clientY: number }) => void) | undefined): void {
		this.onActivate = onActivate;
	}

	dispose(): void {
		this.clearLongPressTimer();
		this.host.removeEventListener('wheel', this.onWheel);
		this.host.removeEventListener('touchstart', this.onTouchStart, true);
		this.host.removeEventListener('touchmove', this.onTouchMove, true);
		this.host.removeEventListener('touchend', this.onTouchEnd, true);
		this.host.removeEventListener('touchcancel', this.onTouchCancel, true);
		this.host.removeEventListener('mousedown', this.onMouseDown, true);
	}

	private readonly onWheel = (event: WheelEvent): void => {
		const horizontalDelta = event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY) ? event.deltaY : event.deltaX;
		if (Math.abs(horizontalDelta) <= Math.abs(event.deltaY) || horizontalDelta === 0) {
			const noteScroller = this.getNoteScroller();
			if (noteScroller && event.deltaY !== 0) {
				noteScroller.scrollTop += event.deltaY;
			}
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		this.setScrollLeft(this.editor.getScrollLeft() + horizontalDelta);
	};

	private readonly onMouseDown = (event: MouseEvent): void => {
		if (Date.now() - this.lastTouchTime < 700) {
			return;
		}
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		this.onActivate?.({ clientX: event.clientX, clientY: event.clientY });
	};

	private readonly onTouchStart = (event: TouchEvent): void => {
		this.lastTouchTime = Date.now();
		const touch = event.touches[0];
		if (!touch) return;
		const handle = this.selectionController.startHandleDrag(event.target);
		this.touchState = {
			startX: touch.clientX,
			startY: touch.clientY,
			scrollLeft: this.editor.getScrollLeft(),
			axis: handle ? 'handle' : 'pending',
			handle,
		};
		if (handle) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		this.clearLongPressTimer();
		this.longPressTimer = setTimeout(() => {
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
			event.stopPropagation();
			this.setScrollLeft(this.touchState.scrollLeft - dx);
			return;
		}
		if (this.touchState.axis === 'vertical') {
			this.clearLongPressTimer();
		}
	};

	private readonly onTouchEnd = (event: TouchEvent): void => {
		this.lastTouchTime = Date.now();
		const touch = event.changedTouches[0];
		const state = this.touchState;
		this.touchState = null;
		this.selectionController.endHandleDrag();
		this.clearLongPressTimer();
		if (!touch || state?.axis !== 'pending') return;
		const nativePosition = this.editor.getTargetAtClientPoint?.(touch.clientX, touch.clientY)?.position ?? null;
		if (nativePosition && this.nativeInteraction) {
			event.preventDefault();
			event.stopPropagation();
			this.blurMonacoFocusTarget();
			this.nativeInteraction.placeCursor(nativePosition);
			window.setTimeout(() => {
				this.blurMonacoFocusTarget();
				this.nativeInteraction?.placeCursor(nativePosition);
			}, 50);
			return;
		}
		this.selectionController.placeCursor(touch.clientX, touch.clientY);
	};

	private readonly onTouchCancel = (): void => {
		this.lastTouchTime = Date.now();
		this.touchState = null;
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
		this.editor.setScrollLeft(Math.max(0, scrollLeft));
		this.scrollState.setScrollLeft(this.editor.getScrollLeft());
	}

	private clearLongPressTimer(): void {
		if (!this.longPressTimer) return;
		clearTimeout(this.longPressTimer);
		this.longPressTimer = null;
	}
}
