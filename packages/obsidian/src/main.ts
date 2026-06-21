import { debounce, Plugin, PluginSettingTab, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, type Settings } from 'packages/obsidian/src/settings/Settings';
import { LazyHighlighter } from 'packages/obsidian/src/LazyHighlighter';
import { ShikiSettingsTab } from 'packages/obsidian/src/settings/SettingsTab';
import { CodeBlock } from 'packages/obsidian/src/CodeBlock';
import { InlineCodeBlock } from 'packages/obsidian/src/InlineCodeBlock';
import { CodeBlockRegistry } from 'packages/obsidian/src/codeblocks/CodeBlockRegistry';
import { LazyMonacoRuntime } from 'packages/obsidian/src/monaco/LazyMonacoRuntime';
import { MonacoSurfaceRegistry } from 'packages/obsidian/src/monaco/MonacoSurfaceRegistry';
import { HydrationQueue } from 'packages/obsidian/src/monaco/HydrationQueue';
import { SourceModeTokenizationCache } from 'packages/obsidian/src/runtime/SourceModeTokenizationCache';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';
import type { ReadingViewAdapter } from 'packages/obsidian/src/modes/ReadingViewAdapter';

import 'packages/obsidian/src/styles.css';

export const SHIKI_INLINE_REGEX = /^\{([^\s]+)\} (.*)/i; // format: `{lang} code`

export default class ShikiPlugin extends Plugin {
	highlighter!: LazyHighlighter;
	monacoRuntime!: LazyMonacoRuntime;
	codeBlockRegistry!: CodeBlockRegistry;
	surfaceRegistry!: MonacoSurfaceRegistry;
	hydrationQueue!: HydrationQueue;
	readingViewAdapter!: ReadingViewAdapter;
	sourceModeTokenizationCache!: SourceModeTokenizationCache;
	activeCodeBlocks!: Map<string, (CodeBlock | InlineCodeBlock)[]>;
	settings!: Settings;
	loadedSettings!: Settings;
	updateCm6Plugin!: () => Promise<void>;
	private unloaded = true;
	private cm6PluginRegistered = false;
	private codeBlockProcessorsRegistered = false;
	private settingsLoaded: Promise<void> | undefined;

	async onload(): Promise<void> {
		this.unloaded = false;
		this.settings = structuredClone(DEFAULT_SETTINGS);
		this.loadedSettings = structuredClone(this.settings);
		this.monacoRuntime = new LazyMonacoRuntime(this);
		this.highlighter = new LazyHighlighter(this);
		this.codeBlockRegistry = new CodeBlockRegistry();
		this.surfaceRegistry = new MonacoSurfaceRegistry(this);
		this.hydrationQueue = new HydrationQueue();
		this.readingViewAdapter = undefined as never;
		this.sourceModeTokenizationCache = new SourceModeTokenizationCache();
		this.activeCodeBlocks = new Map();
		this.updateCm6Plugin = async (): Promise<void> => {};

		this.addSettingTab(new LazyShikiSettingsTab(this));

		this.registerInlineCodeProcessor();

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
		// when the start line with the language changes, and we need that for the meta string
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
	}

	async reloadHighlighter(): Promise<void> {
		await this.ensureSettingsLoaded();
		this.loadedSettings = structuredClone(this.settings);

		await this.highlighter.reload();
		this.sourceModeTokenizationCache.clear();
		this.surfaceRegistry.updateThemes();

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

		const { createCm6Plugin } = await import('packages/obsidian/src/codemirror/Cm6_ViewPlugin');
		this.registerEditorExtension([createCm6Plugin(this)]);
		this.cm6PluginRegistered = true;
		this.app.workspace.updateOptions();
	}

	async registerCodeBlockProcessors(): Promise<void> {
		if (this.unloaded || this.codeBlockProcessorsRegistered) {
			return;
		}

		console.log('[Shiki] Registering reading mode code block processor...');
		if (!this.readingViewAdapter) {
			const { ReadingViewAdapter } = await import('packages/obsidian/src/modes/ReadingViewAdapter');
			this.readingViewAdapter = new ReadingViewAdapter(this);
		}
		let languages: Set<string>;
		try {
			languages = new Set(await this.highlighter.obsidianSafeLanguageNames());
		} catch (error) {
			console.error('[Shiki] Failed to load language names, code blocks will not be highlighted:', error);
			return;
		}
		console.log('[Shiki] Registering reading mode code block processor');

		if (this.unloaded || this.codeBlockProcessorsRegistered) {
			return;
		}

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (this.unloaded || el.closest('.markdown-source-view')) {
				return;
			}

			const codeElements = el.querySelectorAll('pre > code[class*="language-"]');
			for (const codeElement of codeElements) {
				const className = [...codeElement.classList].find(value => value.startsWith('language-'));
				const language = className?.slice('language-'.length) ?? '';
				if (language === '' || !languages.has(language)) {
					continue;
				}

				const pre = codeElement.parentElement;
				if (!(pre instanceof HTMLElement)) {
					continue;
				}

				// Keep the frontmatter preview hidden.
				if (pre.parentElement?.classList.contains('mod-frontmatter')) {
					continue;
				}

				const codeBlock = new CodeBlock(this, pre, codeElement.textContent ?? '', language, ctx);
				ctx.addChild(codeBlock);
			}
		}, 1000);

		this.codeBlockProcessorsRegistered = true;
		this.app.workspace.updateOptions();
		console.log('[Shiki] Reading mode code block processor registered');
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
		this.unloaded = true;
		void this.highlighter?.unload();
		this.surfaceRegistry.clear();
		this.hydrationQueue.clear();
		this.codeBlockRegistry.clear();
	}

	getActiveTheme(): string {
		return getActiveTheme(this);
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
