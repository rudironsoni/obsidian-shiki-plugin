import { describe, expect, test } from 'bun:test';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import { parseCodeBlockMeta } from 'packages/obsidian/src/codeblocks/CodeBlockMeta';

describe('code block parser', () => {
	test('parseCodeBlockMeta extracts language and meta', () => {
		const meta = parseCodeBlockMeta('```ts title="Example" showLineNumbers');

		expect(meta).toEqual({
			language: 'ts',
			rawMeta: ' title="Example" showLineNumbers',
			openingFence: '```',
			normalizedLanguage: 'ts',
		});
	});

	test('parseCodeBlockMeta parses mixed fence characters', () => {
		const meta = parseCodeBlockMeta('~~~');
		expect(meta).toEqual({
			language: '',
			rawMeta: '',
			openingFence: '~~~',
			normalizedLanguage: '',
		});
	});

	test('parseLivePreviewBlocks finds language blocks and block ranges', () => {
		const parser = new CodeBlockParser();
		const lines: CodeBlockLineInfo[] = [
			{ lineNumber: 1, from: 0, to: 2, text: '```ts' },
			{ lineNumber: 2, from: 3, to: 17, text: 'const x = 1;' },
			{ lineNumber: 3, from: 18, to: 3, text: '```' },
			{ lineNumber: 4, from: 22, to: 25, text: '~~~~py title="a"' },
			{ lineNumber: 5, from: 26, to: 43, text: 'print(1)' },
			{ lineNumber: 6, from: 44, to: 47, text: '~~~~' },
		];

		const blocks = parser.parseLivePreviewBlocks(lines);

		expect(blocks.map(block => block.blockId)).toEqual(['0:1:```', '22:4:~~~~']);
		expect(blocks[0]).toMatchObject({
			language: 'ts',
			range: {
				lineFrom: 2,
				lineTo: 2,
				charFrom: 3,
				charTo: 17,
			},
			openingFenceLine: 1,
			closingFenceLine: 3,
		});
		expect(blocks[1]).toMatchObject({
			language: 'py',
			range: {
				lineFrom: 5,
				lineTo: 5,
				charFrom: 26,
				charTo: 43,
			},
			openingFenceLine: 4,
			closingFenceLine: 6,
		});
	});
});
