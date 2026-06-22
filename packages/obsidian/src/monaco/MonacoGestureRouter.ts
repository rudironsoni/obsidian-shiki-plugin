import { MonacoScrollState } from 'packages/obsidian/src/monaco/MonacoScrollState';
import { MonacoSelectionController } from 'packages/obsidian/src/monaco/MonacoSelectionController';

type MonacoEditorLike = {
	getScrollLeft(): number;
	setScrollLeft(value: number): void;
	focus(): void;
	getTargetAtClientPoint?(clientX: number, clientY: number): { position?: { lineNumber: number; column: number } | null } | null;
};

type GestureState = 'idle' | 'pending' | 'horizontal-scroll' | 'vertical-scroll' | 'selection';

export class MonacoGestureRouter {
	private readonly host: HTMLElement;
	private readonly editor: MonacoEditorLike;
	private readonly selectionController: MonacoSelectionController;
	private readonly scrollState: MonacoScrollState;
	private readonly getNoteScroller: () => HTMLElement;
	private readonly nativeInteraction: { placeCursor(position: { lineNumber: number; column: number }): void; selectWord(position: { lineNumber: number; column: number }): void } | undefined;
	private gestureState: GestureState = 'idle';
	private touchState: { startX: number; startY: number; scrollLeft: number; longPressTimer: number | undefined } | undefined;

	constructor(options: {
		host: HTMLElement;
		editor: MonacoEditorLike;
		selectionController: MonacoSelectionController;
		scrollState: MonacoScrollState;
		getNoteScroller: () => HTMLElement;
		nativeInteraction?: { placeCursor(position: { lineNumber: number; column: number }): void; selectWord(position: { lineNumber: number; column: number }): void };
	}) {
		this.host = options.host;
		this.editor = options.editor;
		this.selectionController = options.selectionController;
		this.scrollState = options.scrollState;
		this.getNoteScroller = options.getNoteScroller;
		this.nativeInteraction = options.nativeInteraction;
		this.host.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
		this.host.addEventListener('click', this.onClick);
		this.host.addEventListener('touchstart', this.onTouchStart, { passive: true, capture: true });
		this.host.addEventListener('touchmove', this.onTouchMove, { passive: false, capture: true });
		this.host.addEventListener('touchend', this.onTouchEnd, { passive: true, capture: true });
		this.host.addEventListener('touchcancel', this.onTouchCancel, { passive: true, capture: true });
	}

	dispose(): void {
		this.clearLongPressTimer();
		this.host.removeEventListener('wheel', this.onWheel, true);
		this.host.removeEventListener('click', this.onClick);
		this.host.removeEventListener('touchstart', this.onTouchStart, true);
		this.host.removeEventListener('touchmove', this.onTouchMove, true);
		this.host.removeEventListener('touchend', this.onTouchEnd, true);
		this.host.removeEventListener('touchcancel', this.onTouchCancel, true);
	}

	private readonly onClick = (event: MouseEvent): void => {
		if (this.placeNativeCursor(event.clientX, event.clientY)) {
			event.preventDefault();
			return;
		}
		this.selectionController.placeCursor(event.clientX, event.clientY, true);
	};

	private readonly onWheel = (event: WheelEvent): void => {
		const horizontalDelta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
		if (horizontalDelta !== 0) {
			event.preventDefault();
			event.stopPropagation();
			this.setScrollLeft(this.editor.getScrollLeft() + horizontalDelta);
			return;
		}
		if (event.deltaY !== 0) {
			event.preventDefault();
			this.getNoteScroller().scrollTop += event.deltaY;
		}
	};

	private readonly onTouchStart = (event: TouchEvent): void => {
		const touch = event.touches[0];
		if (!touch) {
			return;
		}
		if (this.selectionController.startHandleDrag(event.target)) {
			this.gestureState = 'selection';
			return;
		}
		this.gestureState = 'pending';
		this.touchState = {
			startX: touch.clientX,
			startY: touch.clientY,
			scrollLeft: this.editor.getScrollLeft(),
			longPressTimer: window.setTimeout(() => {
				this.gestureState = 'selection';
				if (this.selectNativeWord(touch.clientX, touch.clientY)) {
					return;
				}
				this.selectionController.selectWordAt(touch.clientX, touch.clientY);
			}, 350),
		};
	};

	private readonly onTouchMove = (event: TouchEvent): void => {
		const touch = event.touches[0];
		if (!touch || !this.touchState) {
			return;
		}
		if (this.gestureState === 'selection') {
			event.preventDefault();
			this.selectionController.updateHandleDrag(touch.clientX, touch.clientY);
			return;
		}

		const dx = touch.clientX - this.touchState.startX;
		const dy = touch.clientY - this.touchState.startY;
		if (this.gestureState === 'pending' && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
			this.clearLongPressTimer();
			this.gestureState = Math.abs(dx) > Math.abs(dy) ? 'horizontal-scroll' : 'vertical-scroll';
		}
		if (this.gestureState === 'horizontal-scroll') {
			event.preventDefault();
			event.stopPropagation();
			this.setScrollLeft(this.touchState.scrollLeft - dx);
			return;
		}
		if (this.gestureState === 'vertical-scroll') {
			return;
		}
	};

	private readonly onTouchEnd = (event: TouchEvent): void => {
		const touch = event.changedTouches[0];
		if (this.gestureState === 'selection') {
			this.selectionController.endHandleDrag();
		} else if (this.gestureState === 'pending' && touch) {
			if (this.placeNativeCursor(touch.clientX, touch.clientY)) {
				this.resetTouchState();
				return;
			}
			this.selectionController.placeCursor(touch.clientX, touch.clientY, false);
		}
		this.resetTouchState();
	};

	private placeNativeCursor(clientX: number, clientY: number): boolean {
		const position = this.editor.getTargetAtClientPoint?.(clientX, clientY)?.position;
		if (!position || !this.nativeInteraction) {
			return false;
		}
		this.selectionController.placeCursor(clientX, clientY, false);
		this.nativeInteraction.placeCursor(position);
		return true;
	}

	private selectNativeWord(clientX: number, clientY: number): boolean {
		const position = this.editor.getTargetAtClientPoint?.(clientX, clientY)?.position;
		if (!position || !this.nativeInteraction) {
			return false;
		}
		this.selectionController.selectWordAt(clientX, clientY);
		this.nativeInteraction.selectWord(position);
		return true;
	}

	private readonly onTouchCancel = (): void => {
		this.selectionController.endHandleDrag();
		this.resetTouchState();
	};

	private setScrollLeft(value: number): void {
		const next = Math.max(0, value);
		this.scrollState.setScrollLeft(next);
		this.editor.setScrollLeft(next);
	}

	private clearLongPressTimer(): void {
		if (this.touchState?.longPressTimer !== undefined) {
			window.clearTimeout(this.touchState.longPressTimer);
			this.touchState.longPressTimer = undefined;
		}
	}

	private resetTouchState(): void {
		this.clearLongPressTimer();
		this.touchState = undefined;
		this.gestureState = 'idle';
	}
}
