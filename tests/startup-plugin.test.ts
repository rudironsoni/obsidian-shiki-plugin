import { afterEach, describe, expect, test } from 'bun:test';
import { clearHighlighterEntryCache } from 'packages/obsidian/src/HighlighterEntryLoader';
import ShikiPlugin from 'packages/obsidian/src/main';

function createTestPlugin(): ShikiPlugin {
	const TestPlugin = ShikiPlugin as unknown as new () => ShikiPlugin;
	const plugin = new TestPlugin();
	plugin.app.vault.adapter.read = async (path: string): Promise<string> => {
		if (path.endsWith('highlighter.js')) {
			return 'exports.CodeHighlighter = class CodeHighlighter { async load() {} obsidianSafeLanguageNames() { return ["ts"]; } async unload() {} }; exports.createCm6Plugin = () => "cm6"; exports.filterHighlightAllPlugin = () => ({ reject: { addSelector: () => {} } });';
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
		const originalRequestIdleCallback = window.requestIdleCallback;
		const plugin = createTestPlugin();
		window.requestIdleCallback = (() => 1) as typeof window.requestIdleCallback;

		try {
			await plugin.onload();

			expect(plugin.highlighter).toBeDefined();
			expect(plugin.customThemeOptions).toEqual([]);
			expect((plugin as unknown as { settingTabs: unknown[] }).settingTabs).toHaveLength(1);
			expect((plugin as unknown as { markdownPostProcessors: unknown[] }).markdownPostProcessors).toHaveLength(1);
			expect((plugin as unknown as { markdownCodeBlockProcessors: unknown[] }).markdownCodeBlockProcessors).toHaveLength(0);
			expect((plugin as unknown as { commands: unknown[] }).commands).toHaveLength(1);
			expect((plugin as unknown as { editorExtensions: unknown[] }).editorExtensions).toHaveLength(0);
			expect((plugin.highlighter as unknown as { highlighter?: unknown }).highlighter).toBeUndefined();
		} finally {
			window.requestIdleCallback = originalRequestIdleCallback;
		}
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
			expect((plugin as unknown as { markdownCodeBlockProcessors: unknown[] }).markdownCodeBlockProcessors).toHaveLength(1);
			expect((plugin as unknown as { editorExtensions: unknown[] }).editorExtensions).toHaveLength(1);
			expect(updateOptionsCalls).toBe(2);
		} finally {
			window.requestIdleCallback = originalRequestIdleCallback;
		}
	});

	test('deferred startup work does not register integrations after unload', async () => {
		clearHighlighterEntryCache();
		const originalRequestIdleCallback = window.requestIdleCallback;
		const plugin = createTestPlugin();
		const deferredCallbacks: (() => void)[] = [];
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
			plugin.onunload();
			deferredCallbacks.forEach(callback => callback());
			await new Promise(resolve => setTimeout(resolve, 0));

			expect((plugin as unknown as { markdownCodeBlockProcessors: unknown[] }).markdownCodeBlockProcessors).toHaveLength(0);
			expect((plugin as unknown as { editorExtensions: unknown[] }).editorExtensions).toHaveLength(0);
		} finally {
			window.requestIdleCallback = originalRequestIdleCallback;
		}
	});

	test('async code block registration aborts when unload happens while Shiki is loading', async () => {
		clearHighlighterEntryCache();
		const originalRequestIdleCallback = window.requestIdleCallback;
		const plugin = createTestPlugin();
		let resolveLanguages!: (languages: string[]) => void;
		const languages = new Promise<string[]>(resolve => {
			resolveLanguages = resolve;
		});

		window.requestIdleCallback = (() => 1) as typeof window.requestIdleCallback;

		try {
			await plugin.onload();
			plugin.highlighter = {
				obsidianSafeLanguageNames: () => languages,
				unload: async (): Promise<void> => {},
			} as never;

			const registration = plugin.registerCodeBlockProcessors();
			plugin.onunload();
			resolveLanguages(['ts']);
			await registration;

			expect((plugin as unknown as { markdownCodeBlockProcessors: unknown[] }).markdownCodeBlockProcessors).toHaveLength(0);
		} finally {
			window.requestIdleCallback = originalRequestIdleCallback;
		}
	});

	test('code block processor renders into Obsidian-provided block container and skips frontmatter', async () => {
		const originalRequestIdleCallback = window.requestIdleCallback;
		const plugin = createTestPlugin();
		window.requestIdleCallback = (() => 1) as typeof window.requestIdleCallback;
		let processor!: (source: string, el: HTMLElement, ctx: unknown) => void;

		try {
			await plugin.onload();
			plugin.highlighter = {
				obsidianSafeLanguageNames: async (): Promise<string[]> => ['ts'],
				unload: async (): Promise<void> => {},
			} as never;
			await plugin.registerCodeBlockProcessors();
			processor = (
				plugin as unknown as { markdownCodeBlockProcessors: { language: string; processor: (source: string, el: HTMLElement, ctx: unknown) => void }[] }
			).markdownCodeBlockProcessors[0].processor;
		} finally {
			window.requestIdleCallback = originalRequestIdleCallback;
		}

		const container = document.createElement('div');
		const children: unknown[] = [];
		const ctx = {
			sourcePath: 'note.md',
			addChild: (child: unknown): void => {
				children.push(child);
			},
			getSectionInfo: () => null,
		};

		processor('const x = 1;', container, ctx);

		expect(children).toHaveLength(1);
		expect((children[0] as { language: string; source: string }).language).toBe('ts');
		expect((children[0] as { language: string; source: string }).source).toBe('const x = 1;');

		const frontmatterParent = document.createElement('div');
		frontmatterParent.classList.add('mod-frontmatter');
		const frontmatterContainer = document.createElement('div');
		frontmatterParent.appendChild(frontmatterContainer);
		processor('title: x', frontmatterContainer, ctx);
		expect(children).toHaveLength(1);

		plugin.onunload();
		processor('const stale = true;', container, ctx);
		expect(children).toHaveLength(1);
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

	test('settings changes save, refresh loaded settings, reload highlighter, and rerender active blocks', async () => {
		const plugin = createTestPlugin();
		await plugin.onload();
		let savedSettings: unknown;
		let reloads = 0;
		let cm6Updates = 0;
		let rerenders = 0;
		plugin.saveData = async (data: unknown): Promise<void> => {
			savedSettings = structuredClone(data);
		};
		plugin.highlighter = {
			reload: async (): Promise<void> => {
				reloads++;
			},
		} as never;
		plugin.updateCm6Plugin = async (): Promise<void> => {
			cm6Updates++;
		};
		plugin.activeCodeBlocks = new Map([
			[
				'note.md',
				[
					{
						forceRerender: async (): Promise<void> => {
							rerenders++;
						},
					} as never,
				],
			],
		]);

		plugin.settings.darkTheme = 'selected-dark-theme';
		await plugin.saveSettingsAndReloadHighlighter();

		expect((savedSettings as { darkTheme: string }).darkTheme).toBe('selected-dark-theme');
		expect(plugin.loadedSettings.darkTheme).toBe('selected-dark-theme');
		expect(reloads).toBe(1);
		expect(rerenders).toBe(1);
		expect(cm6Updates).toBe(1);
	});
});
