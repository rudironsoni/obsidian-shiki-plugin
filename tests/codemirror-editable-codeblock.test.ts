import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { resolveEditableCodeBlockBodyRange, selectionIsInsideCodeBlockBody } from 'packages/obsidian/src/codemirror/CodeBlockEditorWidget';
import {
	buildEditableCodeBlockDecorations,
	createEditableCodeBlockTouchPan,
	findEditableCodeBlockScrollSource,
	normalizeEditableCodeBlockScrollWidths,
	panEditableCodeBlockScroll,
	panEditableCodeBlockVerticalScroll,
	parseFenceInfo,
	scrollEditableCodeBlockByDelta,
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

describe('code block editor island selection', () => {
	const block: EditableCodeBlock = {
		from: 10,
		to: 30,
		language: 'ts',
		content: 'const value = 1;',
		showLineNumbers: true,
		wrap: false,
		lineStarts: [10],
	};

	function stateWithSelection(anchor: number, head = anchor): EditorState {
		return EditorState.create({
			doc: 'x'.repeat(40),
			selection: { anchor, head },
		});
	}

	test('activates only when the selection stays inside the code body', () => {
		expect(selectionIsInsideCodeBlockBody(stateWithSelection(10), block)).toBe(true);
		expect(selectionIsInsideCodeBlockBody(stateWithSelection(30), block)).toBe(true);
		expect(selectionIsInsideCodeBlockBody(stateWithSelection(9), block)).toBe(false);
		expect(selectionIsInsideCodeBlockBody(stateWithSelection(31), block)).toBe(false);
		expect(selectionIsInsideCodeBlockBody(stateWithSelection(12, 28), block)).toBe(true);
		expect(selectionIsInsideCodeBlockBody(stateWithSelection(8, 28), block)).toBe(false);
	});
});

describe('editable code block Monaco edit ranges', () => {
	test('resolves stale captured block coordinates to the current expanded body range', () => {
		expect(
			resolveEditableCodeBlockBodyRange({ from: 10, to: 30 }, 80, [
				{ from: 10, to: 48 },
				{ from: 60, to: 72 },
			]),
		).toEqual({ from: 10, to: 48 });
	});

	test('resolves stale captured block coordinates to the current shrunken body range', () => {
		expect(
			resolveEditableCodeBlockBodyRange({ from: 10, to: 30 }, 80, [
				{ from: 10, to: 16 },
				{ from: 60, to: 72 },
			]),
		).toEqual({ from: 10, to: 16 });
	});

	test('falls back to clamped captured coordinates when no syntax body matches', () => {
		expect(resolveEditableCodeBlockBodyRange({ from: 10, to: 90 }, 40, [])).toEqual({
			from: 10,
			to: 40,
		});
	});
});

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

		expect(first.style.getPropertyValue('--shiki-editing-scroll-left')).toBe('72px');
		expect(second.scrollLeft).toBe(72);
		expect(second.style.getPropertyValue('--shiki-editing-scroll-left')).toBe('72px');
		expect(outside.scrollLeft).toBe(0);
		expect(outside.style.getPropertyValue('--shiki-editing-scroll-left')).toBe('');
	});

	test('pans overflowing editable code block lines only for horizontal touch movement', () => {
		const root = document.createElement('div');
		const first = document.createElement('div');
		const second = document.createElement('div');
		first.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		second.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		first.dataset.shikiEditingBlockId = '100-200';
		second.dataset.shikiEditingBlockId = '100-200';
		Object.defineProperty(first, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(first, 'scrollWidth', { configurable: true, value: 900 });
		root.append(first, second);
		const pan = { source: first, verticalSource: root, startX: 100, startY: 100, startScrollLeft: 12, startScrollTop: 0 };

		const didPanVertically = panEditableCodeBlockScroll(root, pan, 94, 40);
		expect(didPanVertically).toBe(false);
		expect(first.scrollLeft).toBe(0);

		const didPanJitter = panEditableCodeBlockScroll(root, pan, 97, 100);
		expect(didPanJitter).toBe(false);
		expect(first.scrollLeft).toBe(0);

		const didPanHorizontally = panEditableCodeBlockScroll(root, pan, 40, 96);
		expect(didPanHorizontally).toBe(true);
		expect(first.scrollLeft).toBe(72);
		expect(second.scrollLeft).toBe(72);
	});

	test('starts editable code block pan from widest overflowing line in touched block', () => {
		const root = document.createElement('div');
		const shortLine = document.createElement('div');
		const wideLine = document.createElement('div');
		const outside = document.createElement('div');
		shortLine.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		wideLine.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		outside.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		shortLine.dataset.shikiEditingBlockId = '100-200';
		wideLine.dataset.shikiEditingBlockId = '100-200';
		outside.dataset.shikiEditingBlockId = '300-400';
		Object.defineProperty(shortLine, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(shortLine, 'scrollWidth', { configurable: true, value: 320 });
		Object.defineProperty(wideLine, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(wideLine, 'scrollWidth', { configurable: true, value: 900 });
		Object.defineProperty(outside, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(outside, 'scrollWidth', { configurable: true, value: 1200 });
		wideLine.scrollLeft = 24;
		root.append(shortLine, wideLine, outside);

		expect(findEditableCodeBlockScrollSource(root, shortLine)).toBe(wideLine);

		const pan = createEditableCodeBlockTouchPan(root, shortLine, 100, 100);
		expect(pan).toEqual({
			source: wideLine,
			verticalSource: root,
			startX: 100,
			startY: 100,
			startScrollLeft: 24,
			startScrollTop: 0,
		});

		expect(panEditableCodeBlockScroll(root, pan!, 40, 98)).toBe(true);
		expect(shortLine.scrollLeft).toBe(84);
		expect(wideLine.scrollLeft).toBe(84);
		expect(outside.scrollLeft).toBe(0);
	});

	test('pans editable code block vertically through editor scroller', () => {
		const root = document.createElement('div');
		const scroller = document.createElement('div');
		const line = document.createElement('div');
		root.append(scroller);
		scroller.className = 'cm-scroller';
		line.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		line.dataset.shikiEditingBlockId = '100-200';
		Object.defineProperty(line, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(line, 'scrollWidth', { configurable: true, value: 900 });
		scroller.scrollTop = 48;
		scroller.append(line);

		const pan = createEditableCodeBlockTouchPan(root, line, 100, 100);
		expect(pan?.verticalSource).toBe(scroller);
		expect(pan?.startScrollTop).toBe(48);

		expect(panEditableCodeBlockVerticalScroll(pan!, 98, 40)).toBe(true);
		expect(scroller.scrollTop).toBe(108);
		expect(line.scrollLeft).toBe(0);
	});

	test('scrolls whole editable code block from horizontal wheel delta', () => {
		const root = document.createElement('div');
		const shortLine = document.createElement('div');
		const wideLine = document.createElement('div');
		shortLine.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		wideLine.className = 'shiki-editing-codeblock-line shiki-editing-codeblock-nowrap';
		shortLine.dataset.shikiEditingBlockId = '100-200';
		wideLine.dataset.shikiEditingBlockId = '100-200';
		Object.defineProperty(shortLine, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(shortLine, 'scrollWidth', { configurable: true, value: 320 });
		Object.defineProperty(wideLine, 'clientWidth', { configurable: true, value: 320 });
		Object.defineProperty(wideLine, 'scrollWidth', { configurable: true, value: 900 });
		root.append(shortLine, wideLine);

		expect(scrollEditableCodeBlockByDelta(root, shortLine, 96)).toBe(true);
		expect(shortLine.scrollLeft).toBe(96);
		expect(wideLine.scrollLeft).toBe(96);
		expect(scrollEditableCodeBlockByDelta(root, shortLine, 0.5)).toBe(false);
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
