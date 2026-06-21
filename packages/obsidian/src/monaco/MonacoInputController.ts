export interface MonacoEditSync {
	commit(value: string): void;
	getCurrentRange(): { from: number; to: number } | undefined;
}

export class MonacoInputController {
	private sync: MonacoEditSync | undefined;
	private suppressCommit = false;

	setSync(sync: MonacoEditSync | undefined): void {
		this.sync = sync;
	}

	withSuppressedCommit<T>(callback: () => T): T {
		this.suppressCommit = true;
		try {
			return callback();
		} finally {
			this.suppressCommit = false;
		}
	}

	commit(value: string): void {
		if (!this.suppressCommit) {
			this.sync?.commit(value);
		}
	}
}
