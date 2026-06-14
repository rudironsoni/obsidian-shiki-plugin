import type { ThemedToken, TokensResult } from 'shiki';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { CodeHighlighter, CustomTheme } from 'packages/obsidian/src/Highlighter';
import { loadHighlighterEntry } from 'packages/obsidian/src/HighlighterEntryLoader';

export interface ThemeOption {
	name: string;
	displayName: string;
	type: string;
}

export class LazyHighlighter {
	private plugin: ShikiPlugin;
	private highlighter: CodeHighlighter | undefined;
	private loading: Promise<CodeHighlighter> | undefined;

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	get customThemes(): CustomTheme[] {
		return this.highlighter?.customThemes ?? this.plugin.customThemeOptions;
	}

	async load(): Promise<CodeHighlighter> {
		if (this.highlighter) {
			return this.highlighter;
		}

		this.loading ??= (async (): Promise<CodeHighlighter> => {
			await this.plugin.ensureSettingsLoaded();
			const { CodeHighlighter } = await loadHighlighterEntry(this.plugin);
			const highlighter = new CodeHighlighter(this.plugin);
			await highlighter.load();
			this.highlighter = highlighter;
			this.plugin.customThemeOptions = highlighter.customThemes;
			this.plugin.customThemeOptionsLoadedFrom = this.plugin.loadedSettings.customThemeFolder;
			return highlighter;
		})();

		return this.loading;
	}

	async unload(): Promise<void> {
		const highlighter = await this.loading;
		this.highlighter = undefined;
		this.loading = undefined;
		this.plugin.customThemeOptions = [];
		this.plugin.customThemeOptionsLoadedFrom = undefined;
		await highlighter?.unload();
	}

	async reload(): Promise<void> {
		await this.unload();
		await this.load();
	}

	async supportedLanguages(): Promise<string[]> {
		return (await this.load()).supportedLanguages;
	}

	async obsidianSafeLanguageNames(): Promise<string[]> {
		return (await this.load()).obsidianSafeLanguageNames();
	}

	async renderWithEc(code: string, language: string, meta: string, container: HTMLElement): Promise<void> {
		await (await this.load()).renderWithEc(code, language, meta, container);
	}

	async getHighlightTokens(code: string, lang: string): Promise<TokensResult | undefined> {
		return (await this.load()).getHighlightTokens(code, lang);
	}

	renderTokens(tokens: ThemedToken[], parent: HTMLElement): void {
		this.highlighter?.renderTokens(tokens, parent);
	}

	getTokenStyle(token: ThemedToken): { style: string; classes: string[] } {
		return this.highlighter?.getTokenStyle(token) ?? { style: `color: ${token.color}`, classes: [] };
	}
}
