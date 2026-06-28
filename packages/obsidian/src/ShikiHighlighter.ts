import { createHighlighter, type Highlighter, type TokensResult, type ThemedToken } from 'shiki';
import { getConfiguredThemes } from 'packages/obsidian/src/runtime/ThemeBridge';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { getObsidianSafeLanguageNames, resolveLanguageAliasFromMetadata } from 'packages/obsidian/src/runtime/LanguageMetadata';

export class ShikiHighlighter {
	private highlighter: Highlighter | undefined;
	private readonly plugin: ShikiPlugin;
	private loadedLanguages = new Set<string>();

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	async init(): Promise<void> {
		const themes = getConfiguredThemes(this.plugin);
		this.highlighter = await createHighlighter({
			themes: themes.length > 0 ? themes : ['github-dark', 'github-light'],
			langs: [],
		});
	}

	async reload(): Promise<void> {
		await this.unload();
		await this.init();
	}

	async unload(): Promise<void> {
		this.highlighter = undefined;
		this.loadedLanguages.clear();
	}

	obsidianSafeLanguageNames(): string[] {
		return getObsidianSafeLanguageNames();
	}

	resolveLanguageAlias(lang: string): string | undefined {
		return resolveLanguageAliasFromMetadata(lang);
	}

	supportedLanguages(): string[] {
		return this.obsidianSafeLanguageNames();
	}

	async ensureLanguage(lang: string): Promise<void> {
		if (!this.highlighter || this.loadedLanguages.has(lang)) {
			return;
		}
		const canonical = this.resolveLanguageAlias(lang) ?? lang;
		try {
			// Shiki 3.x: load language dynamically
			await this.highlighter.loadLanguage(canonical as never);
			this.loadedLanguages.add(lang);
			this.loadedLanguages.add(canonical);
		} catch {
			// Language not available in Shiki
		}
	}

	async getHighlightTokens(code: string, lang: string): Promise<TokensResult | undefined> {
		const normalized = lang.toLowerCase();
		if (this.plugin.loadedSettings.disabledLanguages.includes(normalized)) {
			return undefined;
		}
		if (!this.highlighter) {
			await this.init();
		}
		const theme = this.plugin.getActiveTheme();
		const canonical = this.resolveLanguageAlias(normalized) ?? normalized;
		try {
			await this.ensureLanguage(canonical);
			return this.highlighter!.codeToTokens(code, { lang: canonical as never, theme });
		} catch {
			return undefined;
		}
	}

	async render(code: string, lang: string, container: HTMLElement, meta = ''): Promise<void> {
		return this.renderWithShiki(code, lang, meta, container);
	}

	async renderWithShiki(code: string, lang: string, meta: string, container: HTMLElement): Promise<void> {
		container.empty();
		container.classList.add('shiki-rendered-block');
		if (meta) {
			container.createDiv({ text: meta, cls: 'shiki-ec-meta' });
		}
		const pre = container.createEl('pre');
		const codeEl = pre.createEl('code');
		const highlight = await this.getHighlightTokens(code, lang);
		const tokens = highlight?.tokens.flat(1);
		if (!tokens?.length) {
			codeEl.textContent = code;
			return;
		}
		this.renderTokens(tokens, codeEl);
	}

	renderTokens(tokens: ThemedToken[], parent: HTMLElement): void {
		parent.empty();
		for (const token of tokens) {
			const span = parent.createSpan({
				text: token.content,
				attr: { style: `color: ${token.color ?? 'inherit'}` },
			});
			if (token.fontStyle) {
				if (token.fontStyle & 1) span.style.fontStyle = 'italic';
				if (token.fontStyle & 2) span.style.fontWeight = 'bold';
				if (token.fontStyle & 4) span.style.textDecoration = 'underline';
			}
		}
	}

	getTokenStyle(token: ThemedToken): { style: string; classes: string[] } {
		const styles: string[] = [];
		if (token.color) styles.push(`color: ${token.color}`);
		if (token.fontStyle) {
			if (token.fontStyle & 1) styles.push('font-style: italic');
			if (token.fontStyle & 2) styles.push('font-weight: bold');
			if (token.fontStyle & 4) styles.push('text-decoration: underline');
		}
		return { style: styles.join('; '), classes: [] };
	}
}
