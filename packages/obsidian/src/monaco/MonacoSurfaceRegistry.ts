import type { CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { MonacoCodeBlockSurface } from 'packages/obsidian/src/monaco/MonacoCodeBlockSurface';

export class MonacoSurfaceRegistry {
	private readonly plugin: ShikiPlugin;
	private readonly surfaces = new Map<string, MonacoCodeBlockSurface>();

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	getOrCreate(block: CodeBlockModel): MonacoCodeBlockSurface {
		const existing = this.surfaces.get(block.id);
		if (existing) {
			existing.updateBlock(block);
			return existing;
		}
		const surface = new MonacoCodeBlockSurface(this.plugin, block);
		this.surfaces.set(block.id, surface);
		return surface;
	}

	adoptSurface(previousBlockId: string, block: CodeBlockModel): MonacoCodeBlockSurface | undefined {
		if (previousBlockId === block.id) {
			return this.getOrCreate(block);
		}
		const existing = this.surfaces.get(previousBlockId);
		if (!existing) {
			return undefined;
		}
		const stale = this.surfaces.get(block.id);
		if (stale && stale !== existing) {
			stale.dispose();
		}
		this.surfaces.delete(previousBlockId);
		existing.updateBlock(block);
		this.surfaces.set(block.id, existing);
		return existing;
	}

	get(blockId: string): MonacoCodeBlockSurface | undefined {
		return this.surfaces.get(blockId);
	}

	release(blockId: string): void {
		const surface = this.surfaces.get(blockId);
		if (!surface) {
			return;
		}
		surface.dispose();
		this.surfaces.delete(blockId);
	}

	updateThemes(): void {
		for (const surface of this.surfaces.values()) {
			surface.updateTheme();
		}
	}

	clear(): void {
		for (const surface of this.surfaces.values()) {
			surface.dispose();
		}
		this.surfaces.clear();
	}
}
