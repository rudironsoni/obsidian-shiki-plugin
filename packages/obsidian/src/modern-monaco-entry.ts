// @ts-nocheck
// modern-monaco does not provide TypeScript declarations for subpath exports.
import * as monaco from 'modern-monaco/editor-core';
import { initShiki, initShikiMonacoTokenizer, registerShikiMonacoTokenizer, grammars } from 'modern-monaco/shiki';

export interface MonacoRuntime {
	monaco: typeof monaco;
	highlighter: Awaited<ReturnType<typeof initShiki>>;
}

let runtimePromise: Promise<MonacoRuntime> | undefined;

export async function createMonacoRuntime(options?: {
	themes?: (string | object)[];
	langs?: (string | object)[];
	defaultTheme?: string;
}): Promise<MonacoRuntime> {
	runtimePromise ??= (async (): Promise<MonacoRuntime> => {
		const highlighter = await initShiki({
			defaultTheme: options?.defaultTheme,
			themes: options?.themes,
			langs: options?.langs,
		});

		// Register all languages with Monaco and set up Shiki tokenization
		const allLanguages = new Set(grammars.filter((g: { injectTo?: unknown }) => !g.injectTo).map((g: { name: string }) => g.name));
		for (const id of allLanguages) {
			monaco.languages.register({ id });
			monaco.languages.onLanguage(id, async () => {
				// Load grammars lazily
				await highlighter.loadGrammarFromCDN(id);
				registerShikiMonacoTokenizer(monaco, highlighter, id);
			});
		}

		initShikiMonacoTokenizer(monaco, highlighter);

		// Set default theme
		if (options?.defaultTheme) {
			monaco.editor.setTheme(options.defaultTheme);
		}

		return { monaco, highlighter };
	})();

	return runtimePromise;
}

export { monaco, grammars };
