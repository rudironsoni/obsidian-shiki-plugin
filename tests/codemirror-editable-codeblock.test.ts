import { describe, expect, test } from 'bun:test';
import {
	buildEditableCodeBlockDecorations,
	normalizeEditableCodeBlockScrollWidths,
	parseFenceInfo,
	shouldUpdateCodeBlockDecorations,
	syncEditableCodeBlockScroll,
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

	test('syncs horizontal scroll across every line in the same editable code block', () => {
		const root = document.createElement('div');
		const first = document.createElement('div');
		const second = document.createElement('div');
		const outside = document.createElement('div');
		first.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		second.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		outside.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		first.dataset.shikiEditingBlockId = '100-200';
		second.dataset.shikiEditingBlockId = '100-200';
		outside.dataset.shikiEditingBlockId = '300-400';
		root.append(first, second, outside);

		first.scrollLeft = 72;
		syncEditableCodeBlockScroll(root, first);

		expect(second.scrollLeft).toBe(72);
		expect(outside.scrollLeft).toBe(0);
	});

	test('gives short lines enough scrollable width to follow the whole editable code block', () => {
		const root = document.createElement('div');
		const first = document.createElement('div');
		const second = document.createElement('div');
		first.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		second.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		first.dataset.shikiEditingBlockId = '100-200';
		second.dataset.shikiEditingBlockId = '100-200';
		Object.defineProperty(first, 'scrollWidth', { configurable: true, value: 1200 });
		Object.defineProperty(second, 'scrollWidth', { configurable: true, value: 700 });
		root.append(first, second);

		normalizeEditableCodeBlockScrollWidths(root);

		expect(first.style.getPropertyValue('--shiki-editing-scroll-spacer')).toBe('1200px');
		expect(second.style.getPropertyValue('--shiki-editing-scroll-spacer')).toBe('1200px');
	});
});
