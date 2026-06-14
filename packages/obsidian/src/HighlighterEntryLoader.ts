import type ShikiPlugin from 'packages/obsidian/src/main';
import type { HighlighterEntryModule } from 'packages/obsidian/src/highlighter-entry';

declare const require: (id: string) => unknown;
declare const __SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE_GZIP_BASE64__: string;

const highlighterEntryModules = new Map<string, Promise<HighlighterEntryModule>>();

async function decompressGzipBase64(source: string): Promise<string> {
	const bytes = Uint8Array.from(atob(source), character => character.charCodeAt(0));
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).text();
}

async function getEmbeddedHighlighterSource(plugin: ShikiPlugin, pluginDir: string): Promise<string> {
	const runtimeGlobal = globalThis as typeof globalThis & { __SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__?: string };
	if (typeof runtimeGlobal.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__ === 'string' && runtimeGlobal.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__) {
		return runtimeGlobal.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__;
	}

	if (typeof __SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE_GZIP_BASE64__ !== 'undefined' && __SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE_GZIP_BASE64__) {
		return decompressGzipBase64(__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE_GZIP_BASE64__);
	}

	const styles = await plugin.app.vault.adapter.read(`${pluginDir}/styles.css`);
	const match = /\/\* shiki-highlighter-fallback:([A-Za-z0-9+/=]+) \*\//.exec(styles);
	return match ? decompressGzipBase64(match[1]) : '';
}

function loadHighlighterSource(source: string): HighlighterEntryModule {
	const module = { exports: {} as HighlighterEntryModule };
	// Obsidian does not resolve sibling plugin files through require() or import().
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const loadModule = new Function('exports', 'module', 'require', source) as (
		exports: HighlighterEntryModule,
		module: { exports: HighlighterEntryModule },
		require: (id: string) => unknown,
	) => void;

	loadModule(module.exports, module, require);
	return module.exports;
}

export async function loadHighlighterEntry(plugin: ShikiPlugin): Promise<HighlighterEntryModule> {
	const pluginDir = plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
	if (!highlighterEntryModules.has(pluginDir)) {
		highlighterEntryModules.set(
			pluginDir,
			(async (): Promise<HighlighterEntryModule> => {
				try {
					return loadHighlighterSource(await plugin.app.vault.adapter.read(`${pluginDir}/highlighter.js`));
				} catch (error) {
					const embeddedSource = await getEmbeddedHighlighterSource(plugin, pluginDir);
					if (embeddedSource) {
						return loadHighlighterSource(embeddedSource);
					}
					throw error;
				}
			})(),
		);
	}

	return highlighterEntryModules.get(pluginDir)!;
}

export function clearHighlighterEntryCache(): void {
	highlighterEntryModules.clear();
}
