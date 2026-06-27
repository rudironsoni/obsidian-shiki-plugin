import type ShikiPlugin from 'packages/obsidian/src/main';
import { getObsidianSafeLanguageNames, resolveLanguageAliasFromMetadata } from 'packages/obsidian/src/runtime/LanguageMetadata';
import type { MonacoRuntime } from 'packages/obsidian/src/modern-monaco-entry';

export class LazyMonacoRuntime {
	private readonly plugin: ShikiPlugin;
	private runtime: MonacoRuntime | undefined;
	private loading: Promise<MonacoRuntime> | undefined;

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	async load(): Promise<MonacoRuntime> {
		if (this.runtime) {
			return this.runtime;
		}

		this.loading ??= (async (): Promise<MonacoRuntime> => {
			await this.plugin.ensureSettingsLoaded();
			const { loadModernMonacoRuntime } = await import('packages/obsidian/src/ModernMonacoLoader');
			const runtime = await loadModernMonacoRuntime(this.plugin);
			this.runtime = runtime;
			return runtime;
		})();

		return this.loading;
	}

	isLoaded(): boolean {
		return this.runtime !== undefined;
	}

	async unload(): Promise<void> {
		this.runtime = undefined;
		this.loading = undefined;
		const { resetModernMonacoModule } = await import('packages/obsidian/src/ModernMonacoLoader');
		resetModernMonacoModule();
	}

	async reload(): Promise<void> {
		await this.unload();
	}

	async obsidianSafeLanguageNames(): Promise<string[]> {
		return getObsidianSafeLanguageNames();
	}

	resolveLanguageAlias(lang: string): string | undefined {
		return resolveLanguageAliasFromMetadata(lang);
	}
}
