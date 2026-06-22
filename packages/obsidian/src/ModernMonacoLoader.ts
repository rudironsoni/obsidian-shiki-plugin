import type { MonacoRuntime } from 'packages/obsidian/src/modern-monaco-entry';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { loadBundledModernMonacoSource } from 'packages/obsidian/src/modern-monaco-inline';

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
			const { source: modernMonacoSource, requireFn } = await loadModernMonacoSource(plugin);

			const module = { exports: {} as { createMonacoRuntime?: (options?: unknown) => Promise<MonacoRuntime>; grammars?: unknown[] } };
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			const runtimeFactory = new Function('exports', 'module', 'require', modernMonacoSource) as (
				exports: unknown,
				module: { exports: unknown },
				require: (id: string) => unknown,
			) => void;
			runtimeFactory(module.exports, module, requireFn);
			console.log('[Shiki] modern-monaco module loaded');

			const entry = module.exports;
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

type RequireLike = (id: string) => unknown;

async function loadModernMonacoSource(plugin: ShikiPlugin): Promise<{ source: string; requireFn: RequireLike }> {
	const globals = globalThis as { electron?: { remote?: { require?: NodeRequire } }; require?: NodeRequire };
	const nativeRequire = globals.electron?.remote?.require ?? globals.require;
	const requireFn: RequireLike =
		nativeRequire ??
		((id: string): never => {
			throw new Error(`Cannot require ${id} while loading modern-monaco.js`);
		});

	try {
		if (!nativeRequire) {
			throw new Error('native require is unavailable');
		}
		console.log('[Shiki] Loading modern-monaco sidecar...');
		const fs = nativeRequire('fs') as { readFileSync(path: string, encoding: 'utf8'): string };
		const path = nativeRequire('path') as { isAbsolute(path: string): boolean; join(...parts: string[]): string };
		const appPlugins = (plugin.app as ShikiPlugin['app'] & { plugins?: { manifests?: Record<string, { dir?: string }> } }).plugins;
		const vaultBasePath = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? '';
		const pluginDir = (plugin.manifest as { dir?: string }).dir ?? appPlugins?.manifests?.[plugin.manifest.id]?.dir ?? __dirname;
		const pluginDirPath = path.isAbsolute(pluginDir) ? pluginDir : path.join(vaultBasePath, pluginDir);
		const modernMonacoPath = path.join(pluginDirPath, 'modern-monaco.js');
		return { source: fs.readFileSync(modernMonacoPath, 'utf8'), requireFn };
	} catch (error) {
		console.warn('[Shiki] Sidecar modern-monaco fs load failed, falling back to adapter read.', error);
		const appPlugins = (plugin.app as ShikiPlugin['app'] & { plugins?: { manifests?: Record<string, { dir?: string }> } }).plugins;
		const pluginDir =
			(plugin.manifest as { dir?: string }).dir ?? appPlugins?.manifests?.[plugin.manifest.id]?.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
		const adapterPath = `${pluginDir.replace(/\\/g, '/')}/modern-monaco.js`;
		try {
			const source = await plugin.app.vault.adapter.read(adapterPath);
			return { source, requireFn };
		} catch (adapterError) {
			console.warn('[Shiki] Sidecar modern-monaco adapter read failed, using bundled inline runtime.', adapterError);
			return { source: await loadBundledModernMonacoSource(plugin, requireFn), requireFn };
		}
	}
}
