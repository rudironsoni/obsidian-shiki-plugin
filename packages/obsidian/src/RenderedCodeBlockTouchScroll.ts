import type { Plugin } from 'obsidian';

interface TouchPan {
	source: HTMLElement;
	startX: number;
	startY: number;
	startScrollLeft: number;
	horizontal: boolean;
}

function findScrollableCodeBlock(target: EventTarget | null, x: number, y: number): HTMLElement | null {
	const element = target instanceof Element ? target : null;
	const closest = element?.closest<HTMLElement>('div.expressive-code pre');
	const fromPoint =
		closest ??
		document
			.elementsFromPoint(x, y)
			.find((element): element is HTMLElement => element instanceof HTMLElement && element.matches('div.expressive-code pre'));

	if (!fromPoint || fromPoint.scrollWidth <= fromPoint.clientWidth) return null;
	return fromPoint;
}

export function registerRenderedCodeBlockTouchScroll(plugin: Plugin): void {
	let pan: TouchPan | null = null;

	const onTouchStart = (event: TouchEvent): void => {
		const touch = event.touches[0];
		if (!touch) return;

		const source = findScrollableCodeBlock(event.target, touch.clientX, touch.clientY);
		if (!source) return;

		pan = {
			source,
			startX: touch.clientX,
			startY: touch.clientY,
			startScrollLeft: source.scrollLeft,
			horizontal: false,
		};
		event.stopImmediatePropagation();
	};

	const onTouchMove = (event: TouchEvent): void => {
		if (!pan) return;
		const touch = event.touches[0];
		if (!touch) return;

		const deltaX = pan.startX - touch.clientX;
		const deltaY = pan.startY - touch.clientY;
		if (!pan.horizontal && Math.abs(deltaY) > Math.abs(deltaX)) return;
		if (!pan.horizontal && Math.abs(deltaX) < 6) return;

		pan.horizontal = true;
		pan.source.scrollLeft = pan.startScrollLeft + deltaX;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onTouchEnd = (): void => {
		pan = null;
	};

	window.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
	window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
	window.addEventListener('touchend', onTouchEnd, true);
	window.addEventListener('touchcancel', onTouchEnd, true);
	plugin.register?.(() => {
		window.removeEventListener?.('touchstart', onTouchStart, true);
		window.removeEventListener?.('touchmove', onTouchMove, true);
		window.removeEventListener?.('touchend', onTouchEnd, true);
		window.removeEventListener?.('touchcancel', onTouchEnd, true);
	});
}
