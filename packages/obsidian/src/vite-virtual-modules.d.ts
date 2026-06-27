declare module 'virtual:ec-runtime';

declare module 'virtual:ec-styles.css';

declare module 'modern-monaco/shiki' {
	export const grammars: { name: string; aliases?: string[]; injectTo?: unknown }[];
	export function initShiki(options: { defaultTheme?: string; themes?: (string | object)[]; langs?: (string | object)[] }): Promise<{
		codeToTokens(code: string, options: { lang: string; theme: string }): unknown;
		loadGrammarFromCDN(language: string): Promise<void>;
	}>;
	export function initShikiMonacoTokenizer(monaco: unknown, highlighter: unknown): void;
	export function registerShikiMonacoTokenizer(monaco: unknown, highlighter: unknown, language: string): void;
	export function setDefaultWasmLoader(loader: () => Promise<WebAssembly.Instance>): void;
}

declare module 'shiki-wasm' {
	export function getWasmInstance(): Promise<WebAssembly.Instance>;
}
