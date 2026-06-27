import { hashCodeBlockContent, makeCodeBlockIdentity } from 'packages/obsidian/src/codeblocks/CodeBlockIdentity';
import type { CodeBlockHostMode, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';

export interface CreateCodeBlockModelInput {
	sourcePath: string;
	hostMode: CodeBlockHostMode;
	language: string;
	meta: string;
	code: string;
	fenceFrom?: number;
	fenceTo?: number;
	codeFrom?: number;
	codeTo?: number;
	sectionStartLine?: number;
	sectionEndLine?: number;
	openingFence?: string;
	openingFenceLine?: number;
	closingFenceLine?: number;
}

export class CodeBlockRegistry {
	private readonly models = new Map<string, CodeBlockModel>();

	createModel(input: CreateCodeBlockModelInput): CodeBlockModel {
		const contentHash = hashCodeBlockContent(input.code);
		const id = makeCodeBlockIdentity({
			sourcePath: input.sourcePath,
			hostMode: input.hostMode,
			sectionStartLine: input.sectionStartLine,
			fenceFrom: input.fenceFrom,
			openingFenceLine: input.openingFenceLine,
			language: input.language,
			contentHash,
		});

		return {
			id,
			sourcePath: input.sourcePath,
			hostMode: input.hostMode,
			language: input.language,
			meta: input.meta,
			code: input.code,
			contentHash,
			fenceFrom: input.fenceFrom,
			fenceTo: input.fenceTo,
			codeFrom: input.codeFrom,
			codeTo: input.codeTo,
			sectionStartLine: input.sectionStartLine,
			sectionEndLine: input.sectionEndLine,
			openingFence: input.openingFence,
			openingFenceLine: input.openingFenceLine,
			closingFenceLine: input.closingFenceLine,
		};
	}

	upsert(block: CodeBlockModel): CodeBlockModel {
		this.models.set(block.id, block);
		return block;
	}

	get(blockId: string): CodeBlockModel | undefined {
		return this.models.get(blockId);
	}

	delete(blockId: string): void {
		this.models.delete(blockId);
	}

	clear(): void {
		this.models.clear();
	}
}
