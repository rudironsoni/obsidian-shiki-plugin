import { type Range } from '@codemirror/state';
import { Decoration, WidgetType } from '@codemirror/view';
import type { TokensResult } from 'shiki';

export interface CodeBlockUpdateFlags {
	docChanged: boolean;
	selectionSet: boolean;
	viewportChanged: boolean;
}

export interface FenceInfo {
	language: string;
	meta: string;
	showLineNumbers: boolean;
	wrap: boolean;
}

export interface EditableCodeBlock {
	from: number;
	to: number;
	language: string;
	content: string;
	showLineNumbers: boolean;
	wrap: boolean;
	lineStarts: number[];
}

class LineNumberWidget extends WidgetType {
	constructor(private readonly lineNumber: number) {
		super();
	}

	toDOM(): HTMLElement {
		const element = document.createElement('span');
		element.className = 'shiki-editing-line-number';
		element.textContent = String(this.lineNumber);
		element.setAttribute('aria-hidden', 'true');
		return element;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export function shouldUpdateCodeBlockDecorations(update: CodeBlockUpdateFlags): boolean {
	return update.docChanged || update.selectionSet || update.viewportChanged;
}

export function parseFenceInfo(content: string): FenceInfo {
	const match = /^(?:```|~~~)\s*([^\s`]*)\s*(.*)$/.exec(content.trim());
	const language = match?.[1] ?? '';
	const meta = match?.[2] ?? '';

	return {
		language,
		meta,
		showLineNumbers: /\b(?:showLineNumbers|lineNumbers)\b/i.test(meta),
		wrap: /\bwrap\b/i.test(meta),
	};
}

export function syncEditableCodeBlockScroll(root: ParentNode, source: HTMLElement): void {
	const blockId = source.dataset.shikiEditingBlockId;
	if (!blockId) {
		return;
	}

	const scope = source.isConnected ? source.ownerDocument : (source.closest('.cm-content') ?? root);
	for (const line of scope.querySelectorAll<HTMLElement>('.shiki-editing-codeblock-line[data-shiki-editing-block-id]')) {
		if (line !== source && line.dataset.shikiEditingBlockId === blockId) {
			line.scrollLeft = source.scrollLeft;
		}
	}
}

export interface EditableCodeBlockTouchPan {
	source: HTMLElement;
	startX: number;
	startY: number;
	startScrollLeft: number;
}

export function findEditableCodeBlockScrollSource(root: ParentNode, source: HTMLElement): HTMLElement | null {
	const blockId = source.dataset.shikiEditingBlockId;
	if (!blockId) {
		return source.scrollWidth > source.clientWidth ? source : null;
	}

	let scrollSource: HTMLElement | null = null;
	const scope = source.isConnected ? source.ownerDocument : (source.closest('.cm-content') ?? root);
	for (const line of scope.querySelectorAll<HTMLElement>('.shiki-editing-codeblock-line[data-shiki-editing-block-id]')) {
		if (line.dataset.shikiEditingBlockId !== blockId || line.scrollWidth <= line.clientWidth) {
			continue;
		}

		if (!scrollSource || line.scrollWidth - line.clientWidth > scrollSource.scrollWidth - scrollSource.clientWidth) {
			scrollSource = line;
		}
	}

	return scrollSource;
}

export function createEditableCodeBlockTouchPan(root: ParentNode, source: HTMLElement, startX: number, startY: number): EditableCodeBlockTouchPan | null {
	const scrollSource = findEditableCodeBlockScrollSource(root, source);
	if (!scrollSource) {
		return null;
	}

	return {
		source: scrollSource,
		startX,
		startY,
		startScrollLeft: scrollSource.scrollLeft,
	};
}

export function scrollEditableCodeBlockByDelta(root: ParentNode, source: HTMLElement, deltaX: number): boolean {
	const scrollSource = findEditableCodeBlockScrollSource(root, source);
	if (!scrollSource || Math.abs(deltaX) < 1) {
		return false;
	}

	scrollSource.scrollLeft += deltaX;
	syncEditableCodeBlockScroll(root, scrollSource);
	return true;
}

export function panEditableCodeBlockScroll(root: ParentNode, pan: EditableCodeBlockTouchPan, currentX: number, currentY: number): boolean {
	const deltaX = pan.startX - currentX;
	const deltaY = pan.startY - currentY;

	if (Math.abs(deltaX) < 4 || Math.abs(deltaX) <= Math.abs(deltaY) || pan.source.scrollWidth <= pan.source.clientWidth) {
		return false;
	}

	pan.source.scrollLeft = pan.startScrollLeft + deltaX;
	syncEditableCodeBlockScroll(root, pan.source);
	return true;
}

export function normalizeEditableCodeBlockScrollWidths(root: ParentNode): void {
	const blocks = new Map<string, HTMLElement[]>();
	for (const line of root.querySelectorAll<HTMLElement>('.shiki-editing-codeblock-line[data-shiki-editing-block-id]')) {
		const blockId = line.dataset.shikiEditingBlockId;
		if (!blockId) {
			continue;
		}

		const lines = blocks.get(blockId) ?? [];
		lines.push(line);
		blocks.set(blockId, lines);
		line.style.setProperty('--shiki-editing-scroll-spacer', '0px');
	}

	for (const lines of blocks.values()) {
		const maxScrollWidth = Math.max(...lines.map(line => line.scrollWidth));
		for (const line of lines) {
			line.style.setProperty('--shiki-editing-scroll-spacer', `${maxScrollWidth}px`);
		}
	}
}

export function buildEditableCodeBlockDecorations(block: EditableCodeBlock, highlight: TokensResult): Range<Decoration>[] {
	const decorations: Range<Decoration>[] = [];
	const tokens = highlight.tokens.flat(1);
	const lineStarts = block.lineStarts.length > 0 ? block.lineStarts : [block.from];
	const blockId = `${block.from}-${block.to}`;

	for (let index = 0; index < lineStarts.length; index++) {
		const lineStart = lineStarts[index];
		const classes = [
			'shiki-editing-codeblock-line',
			index === 0 ? 'shiki-editing-codeblock-first-line' : undefined,
			index === lineStarts.length - 1 ? 'shiki-editing-codeblock-last-line' : undefined,
			block.showLineNumbers ? 'shiki-editing-codeblock-with-line-numbers' : undefined,
			block.wrap ? 'shiki-editing-codeblock-wrap' : 'shiki-editing-codeblock-nowrap',
		].filter(Boolean) as string[];

		decorations.push(
			Decoration.line({
				attributes: {
					class: classes.join(' '),
					style: `background-color: ${highlight.bg ?? 'var(--shiki-code-background)'}; color: ${highlight.fg ?? 'var(--shiki-code-normal)'}`,
					'data-shiki-editing-block-id': blockId,
				},
			}).range(lineStart),
		);

		if (block.showLineNumbers) {
			decorations.push(
				Decoration.widget({
					widget: new LineNumberWidget(index + 1),
					side: -1,
				}).range(lineStart),
			);
		}
	}

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const nextToken = tokens[index + 1];
		const from = block.from + token.offset;
		const to = nextToken ? block.from + nextToken.offset : block.to;

		if (from >= to || from < block.from || to > block.to) {
			continue;
		}

		const classes = [
			'shiki-editing-token',
			(token.fontStyle ?? 0) & 1 ? 'shiki-italic' : undefined,
			(token.fontStyle ?? 0) & 2 ? 'shiki-bold' : undefined,
			(token.fontStyle ?? 0) & 4 ? 'shiki-ul' : undefined,
		].filter(Boolean) as string[];

		decorations.push(
			Decoration.mark({
				attributes: {
					class: classes.join(' '),
					style: token.color ? `color: ${token.color}` : '',
				},
			}).range(from, to),
		);
	}

	return decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to);
}
