import type { MonacoRuntime } from 'packages/obsidian/src/modern-monaco-entry';
import type ShikiPlugin from 'packages/obsidian/src/main';

let runtimePromise: Promise<{ runtime: MonacoRuntime; grammars: unknown[] }> | undefined;

export async function loadModernMonacoRuntime(plugin: ShikiPlugin): Promise<MonacoRuntime> {
	const { runtime } = await loadModernMonacoModule(plugin);
	return runtime;
}

export async function loadModernMonacoGrammars(plugin: ShikiPlugin): Promise<unknown[]> {
	const { grammars } = await loadModernMonacoModule(plugin);
	return grammars;
}

async function loadModernMonacoModule(plugin: ShikiPlugin): Promise<{ runtime: MonacoRuntime; grammars: unknown[] }> {
	runtimePromise ??= (async (): Promise<{ runtime: MonacoRuntime; grammars: unknown[] }> => {
		try {
			await plugin.ensureSettingsLoaded();
			const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
			const filePath = `${pluginDir}/modern-monaco.js`;
			console.log('[Shiki] Loading modern-monaco from:', filePath);
			const source = await plugin.app.vault.adapter.read(filePath);
			console.log('[Shiki] modern-monaco source length:', source.length);

			const module = { exports: {} as { createMonacoRuntime?: (options?: unknown) => Promise<MonacoRuntime>; grammars?: unknown[] } };
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			const loadModule = new Function('exports', 'module', 'require', source) as (
				exports: unknown,
				module: { exports: unknown },
				require: (id: string) => unknown,
			) => void;
			loadModule(module.exports, module, require);
			console.log('[Shiki] modern-monaco module loaded');

			const entry = module.exports as { createMonacoRuntime?: (options?: unknown) => Promise<MonacoRuntime>; grammars?: unknown[] };
			if (!entry.createMonacoRuntime) {
				throw new Error('modern-monaco.js does not export createMonacoRuntime');
			}

			const { getActiveTheme } = await import('packages/obsidian/src/LazyHighlighter');
			const themes = new Set<string>();
			if (plugin.loadedSettings.darkTheme) themes.add(plugin.loadedSettings.darkTheme);
			if (plugin.loadedSettings.lightTheme) themes.add(plugin.loadedSettings.lightTheme);

			console.log('[Shiki] Creating Monaco runtime...');
			const runtime = await entry.createMonacoRuntime({
				defaultTheme: getActiveTheme(plugin),
				themes: Array.from(themes),
			});
			console.log('[Shiki] Monaco runtime created');

			return { runtime, grammars: entry.grammars ?? [] };
		} catch (error) {
			console.error('[Shiki] Failed to load modern-monaco:', error);
			throw error;
		}
	})();

	return runtimePromise;
}
