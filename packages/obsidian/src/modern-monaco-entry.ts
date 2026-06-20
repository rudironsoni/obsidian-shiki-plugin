// @ts-nocheck
// modern-monaco does not provide TypeScript declarations for subpath exports.
import * as monaco from 'modern-monaco/editor-core';
import { initShiki, initShikiMonacoTokenizer, registerShikiMonacoTokenizer, grammars, setDefaultWasmLoader } from 'modern-monaco/shiki';
import { getWasmInstance } from 'shiki-wasm';

// Set the default WASM loader BEFORE initShiki creates the engine.
setDefaultWasmLoader(getWasmInstance);

export interface MonacoRuntime {
	monaco: typeof monaco;
	highlighter: Awaited<ReturnType<typeof initShiki>>;
	registerLanguage: (id: string) => Promise<void>;
}

let runtimePromise: Promise<MonacoRuntime> | undefined;

// Build alias -> canonical name map from bundled grammars
const aliasToName = new Map<string, string>();
for (const g of grammars) {
	if (g.injectTo) continue;
	aliasToName.set(g.name.toLowerCase(), g.name);
	for (const alias of g.aliases ?? []) {
		aliasToName.set(alias.toLowerCase(), g.name);
	}
}

function resolveLanguage(id: string): string | undefined {
	return aliasToName.get(id.toLowerCase());
}

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
		}

		initShikiMonacoTokenizer(monaco, highlighter);

		// Set default theme
		if (options?.defaultTheme) {
			monaco.editor.setTheme(options?.defaultTheme);
		}

		const loadedGrammars = new Set<string>();

		const registerLanguage = async (id: string): Promise<void> => {
			const canonical = resolveLanguage(id);
			if (!canonical) {
				// Unknown language - register as plaintext so Monaco doesn't break
				const normalizedId = id.toLowerCase();
				if (!monaco.languages.getLanguages().some((l: { id: string }) => l.id === normalizedId)) {
					monaco.languages.register({ id: normalizedId });
				}
				return;
			}

			if (!monaco.languages.getLanguages().some((l: { id: string }) => l.id === canonical)) {
				monaco.languages.register({ id: canonical });
			}

			// Already loaded - skip
			if (loadedGrammars.has(canonical)) {
				registerShikiMonacoTokenizer(monaco, highlighter, canonical);
				return;
			}

			// Load grammar from CDN with retry - mobile networks can be flaky
			let lastError: unknown;
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					await highlighter.loadGrammarFromCDN(canonical);
					loadedGrammars.add(canonical);
					registerShikiMonacoTokenizer(monaco, highlighter, canonical);
					console.log(`[Shiki] Grammar loaded for ${canonical} (attempt ${attempt})`);
					return;
				} catch (error) {
					lastError = error;
					console.warn(`[Shiki] Grammar load attempt ${attempt}/3 failed for ${canonical}:`, error);
					if (attempt < 3) {
						await new Promise(r => setTimeout(r, 500 * attempt));
					}
				}
			}

			// All retries failed - register a basic fallback tokenizer so the editor
			// still has some syntax highlighting instead of plain text
			console.error(`[Shiki] All grammar load attempts failed for ${canonical}. Using fallback tokenizer.`);
			monaco.languages.setMonarchTokensProvider(canonical, {
				tokenizer: {
					root: [
						[/\/\/.*$/, 'comment'],
						[/\/\*.*\*\//, 'comment'],
						[/"(?:[^"\\]|\\.)*"/, 'string'],
						[/'(?:[^'\\]|\\.)*'/, 'string'],
						[
							/\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|true|false|null|undefined)\b/,
							'keyword',
						],
						[/\b(?:def|class|return|if|else|elif|for|while|try|except|import|from|as|with|lambda|yield|pass|break|continue)\b/, 'keyword'],
						[/\b\d+(?:\.\d+)?\b/, 'number'],
						[/[a-zA-Z_]\w*(?=\()/, 'function'],
					],
				},
			});
		};

		return { monaco, highlighter, registerLanguage };
	})();

	return runtimePromise;
}

export { monaco, grammars };
