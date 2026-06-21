export class MonacoScrollState {
	private scrollLeft = 0;

	getScrollLeft(): number {
		return this.scrollLeft;
	}

	setScrollLeft(value: number): void {
		this.scrollLeft = Math.max(0, value);
	}
}
