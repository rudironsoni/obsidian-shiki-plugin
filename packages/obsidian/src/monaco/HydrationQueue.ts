import { MonacoCodeBlockSurface } from 'packages/obsidian/src/monaco/MonacoCodeBlockSurface';

export class HydrationQueue {
	private readonly pending: MonacoCodeBlockSurface[] = [];
	private scheduled = false;

	enqueue(surface: MonacoCodeBlockSurface): void {
		if (surface.isDisposed() || surface.isHydrated() || this.pending.includes(surface)) {
			return;
		}
		this.pending.push(surface);
		this.schedule();
	}

	clear(): void {
		this.pending.length = 0;
	}

	private schedule(): void {
		if (this.scheduled) {
			return;
		}
		this.scheduled = true;
		const callback = (): void => {
			this.scheduled = false;
			void this.flushSlice();
		};
		if (typeof window.requestIdleCallback === 'function') {
			window.requestIdleCallback(callback, { timeout: 250 });
		} else {
			window.setTimeout(callback, 32);
		}
	}

	private async flushSlice(): Promise<void> {
		const batch = this.pending.splice(0, 2);
		for (const surface of batch) {
			if (!surface.isDisposed() && !surface.isHydrated()) {
				await surface.hydrateReadonly();
			}
		}
		if (this.pending.length > 0) {
			this.schedule();
		}
	}
}
