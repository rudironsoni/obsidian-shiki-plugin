import { debounce, loadPrism, Plugin, PluginSettingTab, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, type Settings } from 'packages/obsidian/src/settings/Settings';
import { LazyHighlighter, type ThemeOption } from 'packages/obsidian/src/LazyHighlighter';
import { loadHighlighterEntry } from 'packages/obsidian/src/HighlighterEntryLoader';
import { ShikiSettingsTab } from 'packages/obsidian/src/settings/SettingsTab';
import type { CodeBlock, InlineCodeBlock } from 'packages/obsidian/src/highlighter-entry';
import type { PrismWithFilterHighlightAll } from 'packages/obsidian/src/PrismPlugin';

import 'packages/obsidian/src/styles.css';
import 'virtual:ec-styles.css';

declare const __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__: string;
declare const __SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__: string;

export const SHIKI_INLINE_REGEX = /^\{([^\s]+)\} (.*)/i; // format: `{lang} code`

export default class ShikiPlugin extends Plugin {
	highlighter!: LazyHighlighter;
	activeCodeBlocks!: Map<string, (CodeBlock | InlineCodeBlock)[]>;
	settings!: Settings;
	loadedSettings!: Settings;
	updateCm6Plugin!: () => Promise<void>;
	customThemeOptions: ThemeOption[] = [];
	customThemeOptionsLoadedFrom: string | undefined;
	private unloaded = true;
	private cm6PluginRegistered = false;
	private codeBlockProcessorsRegistered = false;
	private prismPluginRegistered = false;
	private settingsLoaded: Promise<void> | undefined;

	async onload(): Promise<void> {
		this.unloaded = false;
		this.settings = structuredClone(DEFAULT_SETTINGS);
		this.loadedSettings = structuredClone(this.settings);
		this.highlighter = new LazyHighlighter(this);
		this.activeCodeBlocks = new Map();
		this.updateCm6Plugin = async (): Promise<void> => {};

		// Decompress and expose embedded Monaco sources so the highlighter bundle
		// (loaded dynamically) can access them even when BRAT only installs main.js.
		if (typeof __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__ !== 'undefined' && __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__) {
			try {
				const bytes = Uint8Array.from(atob(__SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE_GZIP_BASE64__), c => c.charCodeAt(0));
				const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
				(globalThis as typeof globalThis & { __SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE__?: string }).__SHIKI_EMBEDDED_MONACO_EDITOR_SOURCE__ = await new Response(stream).text();
			} catch {
				// Ignore decompression errors; the plugin will fall back to disk.
			}
		}
		if (typeof __SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__ !== 'undefined' && __SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__) {
			try {
				const bytes = Uint8Array.from(atob(__SHIKI_EMBEDDED_MONACO_CSS_SOURCE_GZIP_BASE64__), c => c.charCodeAt(0));
				const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
				(globalThis as typeof globalThis & { __SHIKI_EMBEDDED_MONACO_CSS_SOURCE__?: string }).__SHIKI_EMBEDDED_MONACO_CSS_SOURCE__ = await new Response(stream).text();
			} catch {
				// Ignore decompression errors; the plugin will fall back to disk.
			}
		}

		this.addSettingTab(new LazyShikiSettingsTab(this));

		this.registerInlineCodeProcessor();
		registerRenderedCodeBlockTouchScroll(this);

		this.deferStartupWork((): void => {
			void this.registerCodeBlockProcessors().catch(error => {
				console.warn('Unable to register Shiki code block processors.', error);
			});
		});

		this.deferStartupWork((): void => {
			void this.registerCm6Plugin().catch(error => {
				console.warn('Unable to register Shiki editor integration.', error);
			});
		});

		// this is a workaround for the fact that obsidian does not rerender the code block
		// when the start line with the language changes, and we need that for the EC meta string
		this.registerEvent(
			this.app.vault.on('modify', async file => {
				// sleep 0 so that the code block context is updated before we rerender
				await sleep(100);

				if (file instanceof TFile) {
					if (this.activeCodeBlocks.has(file.path)) {
						for (const codeBlock of this.activeCodeBlocks.get(file.path)!) {
							void codeBlock.rerenderOnNoteChange();
						}
					}
				}
			}),
		);

		const debouncedReload = debounce(
			() => {
				void this.reloadHighlighter();
			},
			500,
			true,
		);

		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				debouncedReload();
			}),
		);

		this.addCommand({
			id: 'reload-highlighter',
			name: 'Reload highlighter',
			callback: () => {
				void this.reloadHighlighter();
			},
		});

		this.deferStartupWork((): void => {
			void this.registerPrismPlugin().catch(error => {
				console.warn('Unable to register Shiki Prism integration.', error);
			});
		});
	}

	async reloadHighlighter(): Promise<void> {
		await this.ensureSettingsLoaded();
		this.loadedSettings = structuredClone(this.settings);

		await this.highlighter.reload();

		for (const [_, codeBlocks] of this.activeCodeBlocks) {
			for (const codeBlock of codeBlocks) {
				await codeBlock.forceRerender();
			}
		}

		await this.updateCm6Plugin();
	}

	async registerCm6Plugin(): Promise<void> {
		if (this.unloaded || this.cm6PluginRegistered) {
			return;
		}

		const { createCm6Plugin } = await loadHighlighterEntry(this);
		if (this.unloaded || this.cm6PluginRegistered) {
			return;
		}

		this.registerEditorExtension([createCm6Plugin(this)]);
		this.cm6PluginRegistered = true;
		this.app.workspace.updateOptions();
	}

	async registerPrismPlugin(): Promise<void> {
		if (this.unloaded || this.prismPluginRegistered) {
			return;
		}

		const { filterHighlightAllPlugin } = await loadHighlighterEntry(this);
		if (this.unloaded || this.prismPluginRegistered) {
			return;
		}

		const prism = (await loadPrism()) as PrismWithFilterHighlightAll;
		if (this.unloaded || this.prismPluginRegistered) {
			return;
		}

		const filterHighlightAll = filterHighlightAllPlugin(prism);
		filterHighlightAll?.reject.addSelector('div.expressive-code pre code');
		this.prismPluginRegistered = true;
	}

	async registerCodeBlockProcessors(): Promise<void> {
		if (this.unloaded || this.codeBlockProcessorsRegistered) {
			return;
		}

		const languages = await this.highlighter.obsidianSafeLanguageNames();
		const { CodeBlock } = await loadHighlighterEntry(this);
		if (this.unloaded || this.codeBlockProcessorsRegistered) {
			return;
		}

		for (const language of languages) {
			if (this.unloaded) {
				return;
			}

			try {
				this.registerMarkdownCodeBlockProcessor(
					language,
					async (source, el, ctx) => {
						if (this.unloaded) {
							return;
						}

						// we need to avoid making the hidden frontmatter code block visible
						if (el.parentElement?.classList.contains('mod-frontmatter')) {
							return;
						}

						const codeBlock = new CodeBlock(this, el, source, language, ctx);

						ctx.addChild(codeBlock);
					},
					1000,
				);
			} catch (e) {
				console.warn(`Failed to register code block processor for ${language}.`, e);
			}
		}

		this.codeBlockProcessorsRegistered = true;
		this.app.workspace.updateOptions();
	}

	registerInlineCodeProcessor(): void {
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const inlineCodes = el.findAll(':not(pre) > code');
			for (const codeElm of inlineCodes) {
				const match = SHIKI_INLINE_REGEX.exec(codeElm.textContent ?? ''); // format: `{lang} code`
				if (!match) {
					continue;
				}

				const { InlineCodeBlock } = await loadHighlighterEntry(this);
				const codeBlock = new InlineCodeBlock(this, codeElm, match[2], match[1], ctx);

				ctx.addChild(codeBlock);
			}
		});
	}

	onunload(): void {
		this.unloaded = true;
		void this.highlighter?.unload();
	}

	addActiveCodeBlock(codeBlock: CodeBlock | InlineCodeBlock): void {
		const filePath = codeBlock.ctx.sourcePath;

		if (!this.activeCodeBlocks.has(filePath)) {
			this.activeCodeBlocks.set(filePath, [codeBlock]);
		} else {
			this.activeCodeBlocks.get(filePath)!.push(codeBlock);
		}
	}

	removeActiveCodeBlock(codeBlock: CodeBlock | InlineCodeBlock): void {
		const filePath = codeBlock.ctx.sourcePath;

		if (this.activeCodeBlocks.has(filePath)) {
			const index = this.activeCodeBlocks.get(filePath)!.indexOf(codeBlock);
			if (index !== -1) {
				this.activeCodeBlocks.get(filePath)!.splice(index, 1);
			}
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as Settings;

		// migrate the theme to darkTheme and lightTheme
		if (this.settings.theme !== undefined) {
			this.settings.darkTheme = this.settings.theme;
			this.settings.lightTheme = this.settings.theme;
			this.settings.theme = undefined;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async ensureSettingsLoaded(): Promise<void> {
		this.settingsLoaded ??= this.loadSettings().then(() => {
			this.loadedSettings = structuredClone(this.settings);
		});
		await this.settingsLoaded;
	}

	async saveSettingsAndReloadHighlighter(): Promise<void> {
		this.settingsLoaded ??= Promise.resolve();
		await this.ensureSettingsLoaded();
		await this.saveSettings();
		await this.reloadHighlighter();
	}

	async getSupportedLanguages(): Promise<string[]> {
		await this.ensureSettingsLoaded();
		return this.highlighter.supportedLanguages();
	}

	async loadCustomThemeOptions(): Promise<void> {
		await this.ensureSettingsLoaded();
		const folder = this.loadedSettings.customThemeFolder;
		if (this.customThemeOptionsLoadedFrom === folder) {
			return;
		}

		const { loadCustomThemeOptions } = await loadHighlighterEntry(this);
		this.customThemeOptions = await loadCustomThemeOptions(this);
		this.customThemeOptionsLoadedFrom = folder;
	}

	private deferStartupWork(callback: () => void): void {
		const guardedCallback = (): void => {
			if (!this.unloaded) {
				callback();
			}
		};

		if (typeof window.requestIdleCallback === 'function') {
			window.requestIdleCallback(guardedCallback, { timeout: 1000 });
			return;
		}

		window.setTimeout(guardedCallback, 1000);
	}
}

class LazyShikiSettingsTab extends PluginSettingTab {
	private plugin: ShikiPlugin;

	constructor(plugin: ShikiPlugin) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.containerEl.empty();
		void this.plugin.ensureSettingsLoaded().then(async () => {
			const settingsTab = new ShikiSettingsTab(this.plugin);
			settingsTab.containerEl = this.containerEl;
			settingsTab.display();
		});
	}
}
import { registerRenderedCodeBlockTouchScroll } from 'packages/obsidian/src/RenderedCodeBlockTouchScroll';
