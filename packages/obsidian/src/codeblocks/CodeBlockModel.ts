export type CodeBlockHostMode = 'reading' | 'live-preview' | 'source';

export interface CodeBlockRange {
	lineFrom: number;
	lineTo: number;
	charFrom: number;
	charTo: number;
}

export interface CodeBlockModel {
	id: string;
	sourcePath: string;
	hostMode: CodeBlockHostMode;
	language: string;
	meta: string;
	code: string;
	contentHash: string;
	fenceFrom?: number;
	fenceTo?: number;
	codeFrom?: number;
	codeTo?: number;
	sectionStartLine?: number;
	sectionEndLine?: number;
	openingFence?: string;
	openingFenceLine?: number;
	closingFenceLine?: number;
	range?: CodeBlockRange;
}

export interface ParsedCodeBlockModel {
	blockId: string;
	language: string;
	range: CodeBlockRange;
	meta: {
		raw: string;
		openingFence: string;
	};
	openingFenceLine: number;
	closingFenceLine: number;
}

export interface CodeBlockLineInfo {
	lineNumber: number;
	text: string;
	from: number;
	to: number;
}

export type CodeBlockModelList = CodeBlockModel[];
