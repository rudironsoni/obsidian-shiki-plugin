import { describe, expect, test } from 'bun:test';
import {
	buildEditableCodeBlockDecorations,
	parseFenceInfo,
	shouldUpdateCodeBlockDecorations,
	type EditableCodeBlock,
} from 'packages/obsidian/src/codemirror/EditableCodeBlockDecorations';
import type { TokensResult } from 'shiki';

function tokenResult(tokens: TokensResult['tokens']): TokensResult {
	return {
		tokens,
		bg: '#ffffff',
		fg: '#111111',
		rootStyle: undefined,
		themeName: 'test-theme',
	} as TokensResult;
}

describe('editable CodeMirror code block decorations', () => {
	test('rebuilds fenced code block decorations when selection or viewport changes', () => {
		expect(shouldUpdateCodeBlockDecorations({ docChanged: false, selectionSet: true, viewportChanged: false })).toBe(true);
		expect(shouldUpdateCodeBlockDecorations({ docChanged: false, selectionSet: false, viewportChanged: true })).toBe(true);
		expect(shouldUpdateCodeBlockDecorations({ docChanged: false, selectionSet: false, viewportChanged: false })).toBe(false);
	});

	test('parses language and EC editing metadata from a fence line', () => {
		expect(parseFenceInfo('```cs showLineNumbers wrap title="Merge"')).toEqual({
			language: 'cs',
			meta: 'showLineNumbers wrap title="Merge"',
			showLineNumbers: true,
			wrap: true,
		});
		expect(parseFenceInfo('~~~ts')).toEqual({
			language: 'ts',
			meta: '',
			showLineNumbers: false,
			wrap: false,
		});
	});

	test('builds Shiki token marks and EC-like line decorations for editable code body', () => {
		const block: EditableCodeBlock = {
			from: 100,
			to: 119,
			language: 'cs',
			content: 'List<int[]> x = 1;',
			showLineNumbers: true,
			wrap: false,
			lineStarts: [100],
		};

		const decorations = buildEditableCodeBlockDecorations(
			block,
			tokenResult([
				[
					{ content: 'List', offset: 0, color: '#d73a49' },
					{ content: '<int[]>', offset: 4, color: '#6f42c1' },
					{ content: ' x = 1;', offset: 11, color: '#24292e' },
				],
			]),
		);

		const ranges = decorations.map(decoration => ({
			from: decoration.from,
			to: decoration.to,
			spec: decoration.value.spec,
		}));

		expect(ranges).toContainEqual(
			expect.objectContaining({
				from: 100,
				to: 104,
				spec: {
					attributes: {
						class: 'shiki-editing-token',
						style: 'color: #d73a49',
					},
				},
			}),
		);
		expect(ranges).toContainEqual(
			expect.objectContaining({
				from: 100,
				to: 100,
				spec: expect.objectContaining({
					attributes: expect.objectContaining({
						class: expect.stringContaining('shiki-editing-codeblock-line'),
					}),
				}),
			}),
		);
		expect(ranges).toContainEqual(
			expect.objectContaining({
				from: 100,
				to: 100,
				spec: expect.objectContaining({
					side: -1,
				}),
			}),
		);
	});
});
