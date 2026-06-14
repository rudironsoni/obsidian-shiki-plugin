import { afterEach, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { clearHighlighterEntryCache, loadHighlighterEntry } from 'packages/obsidian/src/HighlighterEntryLoader';

declare global {
	var __SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__: string | undefined;
}

describe('highlighter entry loader', () => {
	afterEach(() => {
		clearHighlighterEntryCache();
	});

	test('loads sidecar from plugin manifest directory through vault adapter', async () => {
		clearHighlighterEntryCache();
		const requestedPaths: string[] = [];
		const plugin = {
			manifest: { id: 'shiki-highlighter', dir: '.obsidian/plugins/shiki-highlighter' },
			app: {
				vault: {
					adapter: {
						read: async (path: string): Promise<string> => {
							requestedPaths.push(path);
							return 'exports.CodeHighlighter = class CodeHighlighter {}; exports.createCm6Plugin = () => \"cm6\"; exports.filterHighlightAllPlugin = () => \"prism\";';
						},
					},
				},
			},
		};

		const entry = await loadHighlighterEntry(plugin as never);

		expect(requestedPaths).toEqual(['.obsidian/plugins/shiki-highlighter/highlighter.js']);
		expect(entry.CodeHighlighter.name).toBe('CodeHighlighter');
		expect((entry.createCm6Plugin as unknown as () => string)()).toBe('cm6');
		expect((entry.filterHighlightAllPlugin as unknown as () => string)()).toBe('prism');
	});

	test('caches sidecar per plugin directory', async () => {
		clearHighlighterEntryCache();
		const requestedPaths: string[] = [];
		const createPlugin = (dir: string): unknown => ({
			manifest: { id: 'shiki-highlighter', dir },
			app: {
				vault: {
					adapter: {
						read: async (path: string): Promise<string> => {
							requestedPaths.push(path);
							return `exports.CodeHighlighter = class ${dir.endsWith('one') ? 'One' : 'Two'} {}; exports.createCm6Plugin = () => null; exports.filterHighlightAllPlugin = () => null;`;
						},
					},
				},
			},
		});

		await loadHighlighterEntry(createPlugin('.obsidian/plugins/one') as never);
		await loadHighlighterEntry(createPlugin('.obsidian/plugins/one') as never);
		await loadHighlighterEntry(createPlugin('.obsidian/plugins/two') as never);

		expect(requestedPaths).toEqual(['.obsidian/plugins/one/highlighter.js', '.obsidian/plugins/two/highlighter.js']);
	});

	test('loads embedded sidecar when BRAT did not install highlighter.js', async () => {
		clearHighlighterEntryCache();
		const previousEmbeddedSource = globalThis.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__;
		globalThis.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__ =
			'exports.CodeHighlighter = class EmbeddedCodeHighlighter {}; exports.createCm6Plugin = () => "embedded-cm6"; exports.filterHighlightAllPlugin = () => "embedded-prism";';

		const plugin = {
			manifest: { id: 'shiki-highlighter', dir: '.obsidian/plugins/shiki-highlighter' },
			app: {
				vault: {
					adapter: {
						read: async (): Promise<string> => {
							throw new Error('highlighter.js is not installed');
						},
					},
				},
			},
		};

		try {
			const entry = await loadHighlighterEntry(plugin as never);

			expect(entry.CodeHighlighter.name).toBe('EmbeddedCodeHighlighter');
			expect((entry.createCm6Plugin as unknown as () => string)()).toBe('embedded-cm6');
			expect((entry.filterHighlightAllPlugin as unknown as () => string)()).toBe('embedded-prism');
		} finally {
			globalThis.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__ = previousEmbeddedSource;
		}
	});

	test('loads CSS-hosted fallback when BRAT did not install highlighter.js', async () => {
		clearHighlighterEntryCache();
		const previousEmbeddedSource = globalThis.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__;
		globalThis.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__ = undefined;
		const fallbackSource =
			'exports.CodeHighlighter = class CssFallbackHighlighter {}; exports.createCm6Plugin = () => "css-cm6"; exports.filterHighlightAllPlugin = () => "css-prism";';
		const fallback = gzipSync(fallbackSource).toString('base64');
		const requestedPaths: string[] = [];

		const plugin = {
			manifest: { id: 'shiki-highlighter', dir: '.obsidian/plugins/shiki-highlighter' },
			app: {
				vault: {
					adapter: {
						read: async (path: string): Promise<string> => {
							requestedPaths.push(path);
							if (path.endsWith('highlighter.js')) {
								throw new Error('highlighter.js is not installed');
							}
							return `body {}\n/* shiki-highlighter-fallback:${fallback} */\n`;
						},
					},
				},
			},
		};

		try {
			const entry = await loadHighlighterEntry(plugin as never);

			expect(requestedPaths).toEqual(['.obsidian/plugins/shiki-highlighter/highlighter.js', '.obsidian/plugins/shiki-highlighter/highlighter.css']);
			expect(entry.CodeHighlighter.name).toBe('CssFallbackHighlighter');
			expect((entry.createCm6Plugin as unknown as () => string)()).toBe('css-cm6');
			expect((entry.filterHighlightAllPlugin as unknown as () => string)()).toBe('css-prism');
		} finally {
			globalThis.__SHIKI_EMBEDDED_HIGHLIGHTER_SOURCE__ = previousEmbeddedSource;
		}
	});
});
