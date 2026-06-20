// @ts-nocheck
// modern-monaco does not provide TypeScript declarations for subpath exports.
import type ShikiPlugin from 'packages/obsidian/src/main';
import { loadModernMonacoRuntime, loadModernMonacoGrammars, type MonacoRuntime } from 'packages/obsidian/src/ModernMonacoLoader';
import type { ThemedToken, TokensResult } from 'shiki';
import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/Constants';

// Some languages break Obsidian's `registerMarkdownCodeBlockProcessor`, so we blacklist them
const LANGUAGE_BLACKLIST = new Set(['c++', 'c#', 'f#', 'mermaid']);

// Some languages are considered "special" by shiki.isSpecialLang
const LANGUAGE_SPECIAL = new Set(['plaintext', 'txt', 'text', 'plain', 'ansi']);

export function getActiveTheme(plugin: ShikiPlugin): string {
	const isDark = document.body.classList.contains('theme-dark') || (!document.body.classList.contains('theme-light') && plugin.app.isDarkMode());
	const setting = isDark ? plugin.loadedSettings.darkTheme : plugin.loadedSettings.lightTheme;
	if (setting === OBSIDIAN_THEME_IDENTIFIER) {
		return isDark ? 'github-dark' : 'github-light';
	}
	return setting;
}

export class LazyHighlighter {
	private plugin: ShikiPlugin;
	private runtime: MonacoRuntime | undefined;
	private loading: Promise<MonacoRuntime> | undefined;

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	async load(): Promise<MonacoRuntime> {
		if (this.runtime) {
			return this.runtime;
		}

		this.loading ??= (async (): Promise<MonacoRuntime> => {
			await this.plugin.ensureSettingsLoaded();
			const runtime = await loadModernMonacoRuntime(this.plugin);
			this.runtime = runtime;
			return runtime;
		})();

		return this.loading;
	}

	async unload(): Promise<void> {
		this.runtime = undefined;
		this.loading = undefined;
	}

	async reload(): Promise<void> {
		await this.unload();
		await this.load();
	}

	async obsidianSafeLanguageNames(): Promise<string[]> {
		const grammars = await loadModernMonacoGrammars(this.plugin);
		const allNames = new Set<string>();
		this.aliasMap ??= new Map<string, string>();
		for (const g of grammars) {
			if (g.injectTo) continue;
			allNames.add(g.name);
			this.aliasMap.set(g.name.toLowerCase(), g.name);
			if (g.aliases) {
				for (const alias of g.aliases) {
					allNames.add(alias);
					this.aliasMap.set(alias.toLowerCase(), g.name);
				}
			}
		}
		for (const special of LANGUAGE_SPECIAL) {
			allNames.add(special);
		}
		return Array.from(allNames).filter(name => !LANGUAGE_BLACKLIST.has(name));
	}

	async renderWithMonaco(code: string, language: string, _meta: string, container: HTMLElement): Promise<void> {
		const runtime = await this.load();
		const { monaco } = runtime;

		// Dispose any existing editor before re-rendering
		const existingEditor = (container as any).__shikiMonacoEditor;
		if (existingEditor) {
			existingEditor.dispose();
			(container as any).__shikiMonacoEditor = undefined;
		}

		container.empty();
		container.classList.add('shiki-monaco-block');

		const el = container.createDiv({ cls: 'shiki-monaco-editor' });
		el.style.width = '100%';

		const theme = getActiveTheme(this.plugin);

		// Eagerly load grammar so tokenization is ready before editor creation
		// Failures are non-fatal - editor still renders without syntax highlighting
		try {
			await runtime.registerLanguage(language);
		} catch {
			/* ignore - grammar loading is best-effort */
		}

		const showLineNumbers = this.plugin.loadedSettings.ecDefaultShowLineNumbers;

		const editor = monaco.editor.create(el, {
			value: code,
			language,
			readOnly: true,
			domReadOnly: true,
			theme,
			fontSize: this.plugin.loadedSettings.ecEditorFontSize,
			fontFamily: this.plugin.loadedSettings.ecEditorFontFamily,
			lineHeight: this.plugin.loadedSettings.ecEditorLineHeight,
			lineNumbers: showLineNumbers ? 'on' : 'off',
			lineNumbersMinChars: showLineNumbers ? 4 : 0,
			wordWrap: this.plugin.loadedSettings.ecDefaultWrap ? 'on' : 'off',
			renderLineHighlight: 'none',
			minimap: { enabled: false },
			scrollbar: {
				horizontal: 'auto',
				vertical: 'hidden',
				handleMouseWheel: false,
				alwaysConsumeMouseWheel: false,
			},
			scrollBeyondLastLine: false,
			overviewRulerLanes: 0,
			hideCursorInOverviewRuler: true,
			contextmenu: false,
			folding: showLineNumbers,
			glyphMargin: false,
			lineDecorationsWidth: showLineNumbers ? 0 : 0,
			automaticLayout: true,
			roundedSelection: false,
			selectOnLineNumbers: false,
			selectionHighlight: false,
			occurrencesHighlight: 'off',
			links: false,
			colorDecorators: false,
			lightbulb: { enabled: 'off' as any },
			padding: { top: 8, bottom: 8 },
		});

		// Set explicit height from line count so Monaco never collapses.
		// getContentHeight() is unreliable when the element is not yet in the DOM.
		const lineCount = Math.max(1, code.split('\n').length);
		const contentHeight = lineCount * this.plugin.loadedSettings.ecEditorLineHeight + 16; // + padding
		el.style.height = `${contentHeight}px`;
		editor.layout();

		// Keep height in sync if content changes (e.g. word wrap)
		editor.onDidContentSizeChange(() => {
			const updatedHeight = editor.getContentHeight();
			if (updatedHeight > 0) {
				el.style.height = `${updatedHeight}px`;
				editor.layout();
			}
		});

		// Store editor on container for cleanup
		(container as any).__shikiMonacoEditor = editor;
	}

	async getHighlightTokens(code: string, lang: string): Promise<TokensResult | undefined> {
		const runtime = await this.load();
		const theme = getActiveTheme(this.plugin);
		try {
			// Load grammar before tokenizing - codeToTokens needs it
			await runtime.registerLanguage(lang);
			// Resolve alias for tokenization; Shiki's codeToTokens may not handle aliases
			const canonical = this.resolveLanguageAlias(lang) ?? lang;
			return runtime.highlighter.codeToTokens(code, { lang: canonical, theme });
		} catch {
			return undefined;
		}
	}

	private aliasMap: Map<string, string> | undefined;

	private resolveLanguageAlias(lang: string): string | undefined {
		return this.aliasMap?.get(lang.toLowerCase());
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
