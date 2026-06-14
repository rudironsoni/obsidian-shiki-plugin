import { debounce, loadPrism, Plugin, TFile } from 'obsidian';
import { CodeBlock } from 'packages/obsidian/src/CodeBlock';
import { DEFAULT_SETTINGS, type Settings } from 'packages/obsidian/src/settings/Settings';
import { ShikiSettingsTab } from 'packages/obsidian/src/settings/SettingsTab';
import { InlineCodeBlock } from 'packages/obsidian/src/InlineCodeBlock';
import { LazyHighlighter, type ThemeOption } from 'packages/obsidian/src/LazyHighlighter';
import { loadHighlighterEntry } from 'packages/obsidian/src/HighlighterEntryLoader';
import { loadCustomThemeOptions } from 'packages/obsidian/src/settings/CustomThemeOptions';
import type { PrismWithFilterHighlightAll } from 'packages/obsidian/src/PrismPlugin';

import 'packages/obsidian/src/styles.css';
import 'virtual:ec-styles.css';

export const SHIKI_INLINE_REGEX = /^\{([^\s]+)\} (.*)/i; // format: `{lang} code`

export default class ShikiPlugin extends Plugin {
	highlighter!: LazyHighlighter;
	activeCodeBlocks!: Map<string, (CodeBlock | InlineCodeBlock)[]>;
	settings!: Settings;
	loadedSettings!: Settings;
	updateCm6Plugin!: () => Promise<void>;
	customThemeOptions: ThemeOption[] = [];
	customThemeOptionsLoadedFrom: string | undefined;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.loadedSettings = structuredClone(this.settings);
		this.highlighter = new LazyHighlighter(this);
		this.activeCodeBlocks = new Map();
		this.updateCm6Plugin = async (): Promise<void> => {};

		this.addSettingTab(new ShikiSettingsTab(this));

		this.registerInlineCodeProcessor();
		this.registerCodeBlockPostProcessor();

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
		const { createCm6Plugin } = await loadHighlighterEntry(this);
		this.registerEditorExtension([createCm6Plugin(this)]);
		this.app.workspace.updateOptions();
	}

	async registerPrismPlugin(): Promise<void> {
		const { filterHighlightAllPlugin } = await loadHighlighterEntry(this);
		const prism = (await loadPrism()) as PrismWithFilterHighlightAll;
		const filterHighlightAll = filterHighlightAllPlugin(prism);
		filterHighlightAll?.reject.addSelector('div.expressive-code pre code');
	}

	registerCodeBlockPostProcessor(): void {
		this.registerMarkdownPostProcessor((el, ctx) => {
			const codeBlocks = el.findAll('pre > code[class*="language-"]');
			for (const codeElm of codeBlocks) {
				if (codeElm.parentElement?.classList.contains('mod-frontmatter')) {
					continue;
				}

				const language = [...codeElm.classList].find(className => className.startsWith('language-'))?.substring('language-'.length);
				if (!language) {
					continue;
				}

				const containerEl = codeElm.parentElement ?? codeElm;
				const codeBlock = new CodeBlock(this, containerEl, codeElm.textContent ?? '', language, ctx);
				ctx.addChild(codeBlock);
			}
		});
	}

	registerInlineCodeProcessor(): void {
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const inlineCodes = el.findAll(':not(pre) > code');
			for (const codeElm of inlineCodes) {
				const match = SHIKI_INLINE_REGEX.exec(codeElm.textContent ?? ''); // format: `{lang} code`
				if (!match) {
					continue;
				}

				const codeBlock = new InlineCodeBlock(this, codeElm, match[2], match[1], ctx);

				ctx.addChild(codeBlock);
			}
		});
	}

	onunload(): void {
		void this.highlighter.unload();
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

	async getSupportedLanguages(): Promise<string[]> {
		return this.highlighter.supportedLanguages();
	}

	async loadCustomThemeOptions(): Promise<void> {
		const folder = this.loadedSettings.customThemeFolder;
		if (this.customThemeOptionsLoadedFrom === folder) {
			return;
		}

		this.customThemeOptions = await loadCustomThemeOptions(this);
		this.customThemeOptionsLoadedFrom = folder;
	}

	private deferStartupWork(callback: () => void): void {
		if (typeof window.requestIdleCallback === 'function') {
			window.requestIdleCallback(callback, { timeout: 1000 });
			return;
		}

		window.setTimeout(callback, 50);
	}
}
