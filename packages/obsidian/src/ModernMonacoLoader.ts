import type { MonacoRuntime } from 'packages/obsidian/src/modern-monaco-entry';
import { MODERN_MONACO_SOURCE } from 'packages/obsidian/src/modern-monaco-inline';
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
			console.log('[Shiki] Loading modern-monaco from inlined source...');

			const module = { exports: {} as { createMonacoRuntime?: (options?: unknown) => Promise<MonacoRuntime>; grammars?: unknown[] } };
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			const loadModule = new Function('exports', 'module', 'require', MODERN_MONACO_SOURCE) as (
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

			const { getActiveTheme } = await import('packages/obsidian/src/runtime/ThemeBridge');
			const themes = new Set<string>();
			const resolveTheme = (raw: string, mode: 'dark' | 'light'): string => {
				const sentinel = raw === 'obsidian-theme';
				return sentinel ? (mode === 'dark' ? 'github-dark' : 'github-light') : raw;
			};
			const darkResolved = resolveTheme(plugin.loadedSettings.darkTheme, 'dark');
			const lightResolved = resolveTheme(plugin.loadedSettings.lightTheme, 'light');
			if (darkResolved) themes.add(darkResolved);
			if (lightResolved) themes.add(lightResolved);

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
