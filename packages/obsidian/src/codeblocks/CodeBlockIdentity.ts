import type { CodeBlockHostMode } from 'packages/obsidian/src/codeblocks/CodeBlockModel';

export interface CodeBlockIdentityInput {
	sourcePath: string;
	hostMode: CodeBlockHostMode;
	sectionStartLine?: number;
	fenceFrom?: number;
	openingFenceLine?: number;
	language: string;
	contentHash: string;
}

export function hashCodeBlockContent(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

export function makeCodeBlockIdentity(input: CodeBlockIdentityInput): string {
	const sourcePath = input.sourcePath || '<unknown>';
	const sectionStartLine = input.sectionStartLine ?? -1;
	const fenceFrom = input.fenceFrom ?? -1;
	const openingFenceLine = input.openingFenceLine ?? -1;
	return [sourcePath, input.hostMode, sectionStartLine, fenceFrom, openingFenceLine, input.language, input.contentHash].join('::');
}

export function makeParsedCodeBlockIdentity(from: number, openingLine: number, openingFence: string): string {
	return `${from}:${openingLine}:${openingFence}`;
}
