export interface CodeBlockMeta {
	language: string;
	rawMeta: string;
	openingFence: string;
}

const OPENING_FENCE_RE = /^\s*([`~]{3,})([^\s`~]*)?(.*)$/;

export interface ParsedCodeBlockMeta {
	language: string;
	rawMeta: string;
	openingFence: string;
	normalizedLanguage: string;
}

export function parseCodeBlockMeta(lineText: string): ParsedCodeBlockMeta | undefined {
	const match = OPENING_FENCE_RE.exec(lineText);
	if (!match) {
		return undefined;
	}

	const openingFence = match[1] ?? '';
	const language = match[2] ?? '';
	const rawMeta = match[3] ?? '';
	const normalizedLanguage = language.trim().toLowerCase();

	return {
		language,
		rawMeta,
		openingFence,
		normalizedLanguage,
	};
}

export function buildCodeBlockMeta(lineText: string): CodeBlockMeta | undefined {
	const result = parseCodeBlockMeta(lineText);
	if (!result) {
		return undefined;
	}

	return {
		language: result.normalizedLanguage,
		rawMeta: result.rawMeta,
		openingFence: result.openingFence,
	};
}
