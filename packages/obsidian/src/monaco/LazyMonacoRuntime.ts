import type ShikiPlugin from 'packages/obsidian/src/main';
import { getSpecialLanguages, isMarkdownProcessorSafeLanguage } from 'packages/obsidian/src/runtime/LanguageMetadata';
import type { MonacoRuntime } from 'packages/obsidian/src/modern-monaco-entry';

export class LazyMonacoRuntime {
	private readonly plugin: ShikiPlugin;
	private runtime: MonacoRuntime | undefined;
	private loading: Promise<MonacoRuntime> | undefined;
	private aliasMap: Map<string, string> | undefined;

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	async load(): Promise<MonacoRuntime> {
		if (this.runtime) {
			return this.runtime;
		}

		this.loading ??= (async () => {
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
	}

	async reload(): Promise<void> {
		await this.unload();
	}

	async obsidianSafeLanguageNames(): Promise<string[]> {
		const { loadModernMonacoGrammars } = await import('packages/obsidian/src/ModernMonacoLoader');
		const grammars = await loadModernMonacoGrammars(this.plugin);
		const allNames = new Set<string>();
		this.aliasMap ??= new Map<string, string>();
		for (const grammar of grammars as Array<{ injectTo?: unknown; name: string; aliases?: string[] }>) {
			if (grammar.injectTo) {
				continue;
			}
			allNames.add(grammar.name);
			this.aliasMap.set(grammar.name.toLowerCase(), grammar.name);
			for (const alias of grammar.aliases ?? []) {
				allNames.add(alias);
				this.aliasMap.set(alias.toLowerCase(), grammar.name);
			}
		}
		for (const special of getSpecialLanguages()) {
			allNames.add(special);
		}
		return [...allNames].filter(isMarkdownProcessorSafeLanguage);
	}

	resolveLanguageAlias(lang: string): string | undefined {
		return this.aliasMap?.get(lang.toLowerCase());
	}
}
