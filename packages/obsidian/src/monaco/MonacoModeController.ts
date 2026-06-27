export type MonacoSurfaceMode = 'readonly' | 'editable';

export class MonacoModeController {
	private mode: MonacoSurfaceMode = 'readonly';

	getMode(): MonacoSurfaceMode {
		return this.mode;
	}

	setMode(mode: MonacoSurfaceMode): void {
		this.mode = mode;
	}

	isEditable(): boolean {
		return this.mode === 'editable';
	}
}
