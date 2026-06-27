import { debounce, Plugin, PluginSettingTab, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, type Settings } from 'packages/obsidian/src/settings/Settings';
import { LazyHighlighter } from 'packages/obsidian/src/LazyHighlighter';
import type { CodeBlock } from 'packages/obsidian/src/CodeBlock';
import type { InlineCodeBlock } from 'packages/obsidian/src/InlineCodeBlock';
import { CodeBlockRegistry } from 'packages/obsidian/src/codeblocks/CodeBlockRegistry';
import { LazyMonacoRuntime } from 'packages/obsidian/src/monaco/LazyMonacoRuntime';
import { MonacoSurfaceRegistry } from 'packages/obsidian/src/monaco/MonacoSurfaceRegistry';
import { HydrationQueue } from 'packages/obsidian/src/monaco/HydrationQueue';
import { SourceModeTokenizationCache } from 'packages/obsidian/src/runtime/SourceModeTokenizationCache';
import { getObsidianSafeLanguageNames } from 'packages/obsidian/src/runtime/LanguageMetadata';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';
import type { ReadingViewAdapter } from 'packages/obsidian/src/modes/ReadingViewAdapter';

import 'packages/obsidian/src/styles.css';

export const SHIKI_INLINE_REGEX = /^\{([^\s]+)\} (.*)/i; // format: `{lang} code`
const SHIKI_INSTANCE_KEY = '__shikiHighlighterInstanceId';

type ShikiWindow = Window & { [SHIKI_INSTANCE_KEY]?: number };

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
	private inlineCodeProcessorRegistered = false;
	private settingsLoaded: Promise<void> | undefined;
	private instanceId = 0;

	async onload(): Promise<void> {
		this.unloaded = false;
		this.instanceId = ((window as ShikiWindow)[SHIKI_INSTANCE_KEY] ?? 0) + 1;
		(window as ShikiWindow)[SHIKI_INSTANCE_KEY] = this.instanceId;
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

		this.deferStartupWork((): void => {
			this.registerInlineCodeProcessor();
		});

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

		const refreshEditorIntegration = debounce(
			() => {
				void this.updateCm6Plugin?.();
			},
			100,
			true,
		);
		this.registerEvent(this.app.workspace.on('layout-change', refreshEditorIntegration));
		this.registerEvent(this.app.workspace.on('active-leaf-change', refreshEditorIntegration));
		this.registerEvent(this.app.workspace.on('file-open', refreshEditorIntegration));
		const livePreviewModeObserver = new MutationObserver(mutations => {
			if (mutations.some(mutation => mutation.type === 'attributes' && mutation.attributeName === 'class')) {
				refreshEditorIntegration();
			}
		});
		livePreviewModeObserver.observe(this.app.workspace.containerEl.ownerDocument.body, { attributes: true, attributeFilter: ['class'], subtree: true });
		this.register(() => livePreviewModeObserver.disconnect());
		const startEditorIntegrationSettle = (): void => {
			let attempts = 0;
			const interval = window.setInterval(() => {
				attempts += 1;
				refreshEditorIntegration();
				if (attempts >= 12) {
					window.clearInterval(interval);
				}
			}, 250);
			this.registerInterval(interval);
		};
		this.registerEvent(this.app.workspace.on('layout-change', startEditorIntegrationSettle));
		this.registerEvent(this.app.workspace.on('active-leaf-change', startEditorIntegrationSettle));
		this.registerEvent(this.app.workspace.on('file-open', startEditorIntegrationSettle));
		startEditorIntegrationSettle();

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

		if (!this.readingViewAdapter) {
			const { ReadingViewAdapter } = await import('packages/obsidian/src/modes/ReadingViewAdapter');
			this.readingViewAdapter = new ReadingViewAdapter(this);
		}
		const { CodeBlock } = await import('packages/obsidian/src/CodeBlock');
		let languages: Set<string>;
		try {
			languages = new Set(getObsidianSafeLanguageNames());
		} catch (error) {
			console.error('[Shiki] Failed to load language names, code blocks will not be highlighted:', error);
			return;
		}

		if (this.unloaded || this.codeBlockProcessorsRegistered) {
			return;
		}

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (this.unloaded || el.closest('.markdown-source-view')) {
				return;
			}

			const codeElements = el.querySelectorAll<HTMLElement>('pre > code[class*="language-"]');
			const processedPre = new Set<HTMLElement>();
			const sourceFromSectionInfo = (pre: HTMLElement): string => {
				const sectionInfo = ctx.getSectionInfo(pre);
				if (!sectionInfo) {
					return pre.textContent ?? '';
				}
				const lines = sectionInfo.text.split('\n');
				return lines.slice(sectionInfo.lineStart + 1, sectionInfo.lineEnd).join('\n');
			};
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
				if (processedPre.has(pre)) {
					continue;
				}

				// Keep the frontmatter preview hidden.
				if (pre.parentElement?.classList.contains('mod-frontmatter')) {
					continue;
				}

				processedPre.add(pre);
				const codeBlock = new CodeBlock(
					this,
					pre,
					codeElement.textContent?.trim() ? codeElement.textContent : sourceFromSectionInfo(pre),
					language,
					ctx,
				);
				ctx.addChild(codeBlock);
			}
			for (const pre of el.querySelectorAll<HTMLElement>('pre[class*="language-"]')) {
				const className = [...pre.classList].find(value => value.startsWith('language-'));
				const language = className?.slice('language-'.length) ?? '';
				if (language === '' || !languages.has(language) || processedPre.has(pre)) {
					continue;
				}
				if (pre.parentElement?.classList.contains('mod-frontmatter')) {
					continue;
				}
				processedPre.add(pre);
				const codeBlock = new CodeBlock(this, pre, pre.textContent?.trim() ? pre.textContent : sourceFromSectionInfo(pre), language, ctx);
				ctx.addChild(codeBlock);
			}
		}, 1000);

		this.codeBlockProcessorsRegistered = true;
		this.app.workspace.updateOptions();
	}

	registerInlineCodeProcessor(): void {
		if (this.unloaded || this.inlineCodeProcessorRegistered) {
			return;
		}

		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const inlineCodes = el.findAll(':not(pre) > code');
			let InlineCodeBlockConstructor: typeof InlineCodeBlock | undefined;
			for (const codeElm of inlineCodes) {
				const match = SHIKI_INLINE_REGEX.exec(codeElm.textContent ?? ''); // format: `{lang} code`
				if (!match) {
					continue;
				}

				InlineCodeBlockConstructor ??= (await import('packages/obsidian/src/InlineCodeBlock')).InlineCodeBlock;
				const codeBlock = new InlineCodeBlockConstructor(this, codeElm, match[2], match[1], ctx);
				ctx.addChild(codeBlock);
			}
		});
		this.inlineCodeProcessorRegistered = true;
	}

	onunload(): void {
		this.unloaded = true;
		void this.highlighter?.unload();
		this.surfaceRegistry.clear();
		this.hydrationQueue.clear();
		this.codeBlockRegistry.clear();
	}

	isCurrentInstance(): boolean {
		return !this.unloaded && (window as ShikiWindow)[SHIKI_INSTANCE_KEY] === this.instanceId;
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
			const { ShikiSettingsTab } = await import('packages/obsidian/src/settings/SettingsTab');
			const settingsTab = new ShikiSettingsTab(this.plugin);
			settingsTab.containerEl = this.containerEl;
			settingsTab.display();
		});
	}
}
