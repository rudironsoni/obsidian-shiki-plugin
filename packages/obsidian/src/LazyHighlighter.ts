import type { CodeToTokensOptions, ThemedToken, TokensResult } from 'shiki';
import type ShikiPlugin from 'packages/obsidian/src/main';

export class LazyHighlighter {
	private readonly plugin: ShikiPlugin;

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	async unload(): Promise<void> {
		await this.plugin.monacoRuntime.unload();
	}

	async reload(): Promise<void> {
		await this.plugin.monacoRuntime.reload();
	}

	async obsidianSafeLanguageNames(): Promise<string[]> {
		return this.plugin.monacoRuntime.obsidianSafeLanguageNames();
	}

	async supportedLanguages(): Promise<string[]> {
		return this.obsidianSafeLanguageNames();
	}

	resolveLanguageAlias(lang: string): string | undefined {
		return this.plugin.monacoRuntime.resolveLanguageAlias(lang);
	}

	async getHighlightTokens(code: string, lang: string): Promise<TokensResult | undefined> {
		const normalized = lang.toLowerCase();
		if (this.plugin.loadedSettings.disabledLanguages.includes(normalized)) {
			return undefined;
		}
		const runtime = await this.plugin.monacoRuntime.load();
		const theme = this.plugin.getActiveTheme();
		try {
			await runtime.registerLanguage(normalized);
			const canonical = this.resolveLanguageAlias(normalized) ?? normalized;
			return runtime.highlighter.codeToTokens(code, { lang: canonical, theme } satisfies CodeToTokensOptions) as TokensResult;
		} catch {
			return undefined;
		}
	}

	async renderWithEc(code: string, lang: string, meta: string, container: HTMLElement): Promise<void> {
		container.empty();
		container.classList.add('shiki-ec-fallback');
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
