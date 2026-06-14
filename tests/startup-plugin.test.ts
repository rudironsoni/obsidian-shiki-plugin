import { afterEach, describe, expect, test } from 'bun:test';
import { clearHighlighterEntryCache } from 'packages/obsidian/src/HighlighterEntryLoader';
import ShikiPlugin from 'packages/obsidian/src/main';

function createTestPlugin(): ShikiPlugin {
	const TestPlugin = ShikiPlugin as unknown as new () => ShikiPlugin;
	const plugin = new TestPlugin();
	plugin.app.vault.adapter.read = async (path: string): Promise<string> => {
		if (path.endsWith('highlighter.js')) {
			return 'exports.CodeHighlighter = class CodeHighlighter {}; exports.createCm6Plugin = () => "cm6"; exports.filterHighlightAllPlugin = () => ({ reject: { addSelector: () => {} } });';
		}
		return '';
	};
	return plugin;
}

describe('plugin startup registration', () => {
	afterEach(() => {
		clearHighlighterEntryCache();
	});

	test('onload registers settings, processors, commands, and deferred integrations without loading highlighter', async () => {
		clearHighlighterEntryCache();
		const plugin = createTestPlugin();

		await plugin.onload();
		await new Promise(resolve => setTimeout(resolve, 60));

		expect(plugin.highlighter).toBeDefined();
		expect(plugin.customThemeOptions).toEqual([]);
		expect((plugin as unknown as { settingTabs: unknown[] }).settingTabs).toHaveLength(1);
		expect((plugin as unknown as { markdownPostProcessors: unknown[] }).markdownPostProcessors).toHaveLength(2);
		expect((plugin as unknown as { commands: unknown[] }).commands).toHaveLength(1);
		expect((plugin as unknown as { editorExtensions: unknown[] }).editorExtensions).toHaveLength(1);
		expect((plugin.highlighter as unknown as { highlighter?: unknown }).highlighter).toBeUndefined();
	});

	test('deferred Shiki editor registration refreshes existing editor views', async () => {
		clearHighlighterEntryCache();
		const originalRequestIdleCallback = window.requestIdleCallback;
		const plugin = createTestPlugin();
		const deferredCallbacks: (() => void)[] = [];
		let updateOptionsCalls = 0;
		plugin.app.workspace.updateOptions = (): void => {
			updateOptionsCalls++;
		};
		window.requestIdleCallback = ((callback: IdleRequestCallback): number => {
			deferredCallbacks.push(() =>
				callback({
					didTimeout: false,
					timeRemaining: () => 50,
				}),
			);
			return deferredCallbacks.length;
		}) as typeof window.requestIdleCallback;

		try {
			await plugin.onload();

			expect((plugin as unknown as { editorExtensions: unknown[] }).editorExtensions).toHaveLength(0);
			deferredCallbacks.forEach(callback => callback());
			await new Promise(resolve => setTimeout(resolve, 0));
			expect((plugin as unknown as { editorExtensions: unknown[] }).editorExtensions).toHaveLength(1);
			expect(updateOptionsCalls).toBe(1);
			expect((plugin.highlighter as unknown as { highlighter?: unknown }).highlighter).toBeUndefined();
		} finally {
			window.requestIdleCallback = originalRequestIdleCallback;
		}
	});

	test('code block postprocessor creates children for fenced language blocks and skips frontmatter', async () => {
		const plugin = createTestPlugin();
		await plugin.onload();
		const processor = (plugin as unknown as { markdownPostProcessors: ((el: HTMLElement, ctx: unknown) => void)[] }).markdownPostProcessors[1];
		const root = document.createElement('div');
		root.innerHTML = [
			'<pre><code class="language-ts">const x = 1;</code></pre>',
			'<pre class="mod-frontmatter"><code class="language-yaml">title: x</code></pre>',
			'<pre><code>plain</code></pre>',
		].join('');
		const children: unknown[] = [];
		const ctx = {
			sourcePath: 'note.md',
			addChild: (child: unknown): void => {
				children.push(child);
			},
			getSectionInfo: () => null,
		};

		processor(root, ctx);

		expect(children).toHaveLength(1);
		expect((children[0] as { language: string; source: string }).language).toBe('ts');
		expect((children[0] as { language: string; source: string }).source).toBe('const x = 1;');
	});

	test('inline postprocessor respects inline code syntax and ignores normal inline code', async () => {
		const plugin = createTestPlugin();
		await plugin.onload();
		const processor = (plugin as unknown as { markdownPostProcessors: ((el: HTMLElement, ctx: unknown) => void)[] }).markdownPostProcessors[0];
		const root = document.createElement('div');
		root.innerHTML = '<p><code>{ts} const x = 1</code><code>plain</code></p><pre><code>{ts} ignored</code></pre>';
		const children: unknown[] = [];
		const ctx = {
			sourcePath: 'note.md',
			addChild: (child: unknown): void => {
				children.push(child);
			},
		};

		await processor(root, ctx);

		expect(children).toHaveLength(1);
		expect((children[0] as { language: string; source: string }).language).toBe('ts');
		expect((children[0] as { language: string; source: string }).source).toBe('const x = 1');
	});
});
