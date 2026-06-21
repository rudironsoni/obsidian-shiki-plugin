// Some languages break Obsidian's registerMarkdownCodeBlockProcessor.
const LANGUAGE_BLACKLIST = new Set(['c++', 'c#', 'f#', 'mermaid']);
const LANGUAGE_SPECIAL = new Set(['plaintext', 'txt', 'text', 'plain', 'ansi']);

export function isMarkdownProcessorSafeLanguage(language: string): boolean {
	return !LANGUAGE_BLACKLIST.has(language);
}

export function getSpecialLanguages(): string[] {
	return [...LANGUAGE_SPECIAL];
}
