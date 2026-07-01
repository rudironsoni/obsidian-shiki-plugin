import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';
import type { ThemedToken } from 'shiki';

interface LivePreviewStructureState {
	decorations: DecorationSet;
}

class ShikiLivePreviewHeaderWidget extends WidgetType {
	constructor(
		private readonly block: CodeBlockModel,
		private readonly plugin: ShikiPlugin,
	) {
		super();
	}

	eq(other: ShikiLivePreviewHeaderWidget): boolean {
		return other.block.id === this.block.id && other.block.language === this.block.language && other.block.code === this.block.code;
	}

	toDOM(): HTMLElement {
		const header = document.createElement('div');
		header.className = 'shiki-live-preview-header shiki-block-header';
		header.dataset.shikiBlockId = this.block.id;
		header.dataset.lang = this.block.language;

		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: this.block.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		copyBtn.onclick = (event): void => {
			event.preventDefault();
			event.stopPropagation();
			navigator.clipboard.writeText(this.block.code).catch(() => {});
		};

		return header;
	}

	ignoreEvent(event: Event): boolean {
		return event.target instanceof Element && event.target.closest('.shiki-copy-button') !== null;
	}
}

class ShikiLivePreviewBlockWidget extends WidgetType {
	private readonly showLineNumbers: boolean;
	private readonly wrapLines: boolean;
	private readonly activeTheme: string;

	constructor(
		private readonly block: CodeBlockModel,
		private readonly plugin: ShikiPlugin,
	) {
		super();
		this.showLineNumbers = plugin.loadedSettings.showLineNumbers;
		this.wrapLines = plugin.loadedSettings.wrapLines;
		this.activeTheme = getActiveTheme(plugin);
	}

	eq(other: ShikiLivePreviewBlockWidget): boolean {
		return (
			other.block.id === this.block.id &&
			other.block.language === this.block.language &&
			other.block.code === this.block.code &&
			other.showLineNumbers === this.showLineNumbers &&
			other.wrapLines === this.wrapLines &&
			other.activeTheme === this.activeTheme
		);
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'shiki-live-preview-block';
		if (this.wrapLines) {
			container.classList.add('wrap-lines');
		}
		container.dataset.shikiBlockId = this.block.id;
		container.dataset.lang = this.block.language;

		const header = container.createDiv({ cls: 'shiki-block-header' });
		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: this.block.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		copyBtn.onclick = (event): void => {
			event.preventDefault();
			event.stopPropagation();
			navigator.clipboard.writeText(this.block.code).catch(() => {});
		};

		const body = container.createDiv({ cls: 'shiki-block-body' });
		if (this.showLineNumbers) {
			const lineNumbers = body.createDiv({ cls: 'shiki-line-numbers' });
			const lineCount = Math.max(1, this.block.code.split('\n').length);
			for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
				lineNumbers.createSpan({ text: String(lineNumber) });
			}
		}
		const scroll = body.createDiv({ cls: 'shiki-code-scroll' });
		const pre = scroll.createEl('pre');
		const code = pre.createEl('code');
		this.renderPlainLines(code);
		this.renderCachedTokens(code, container);
		void this.renderTokens(code, container);

		container.addEventListener('click', event => {
			if (event.target instanceof Element && event.target.closest('.shiki-copy-button')) {
				return;
			}
			this.focusSourceLine(event);
		});

		return container;
	}

	private async renderTokens(code: HTMLElement, container: HTMLElement): Promise<void> {
		const cached = this.getCachedHighlight();
		const highlight = cached ?? (await this.plugin.highlighter.getHighlightTokens(this.block.code, this.block.language));
		if (!container.isConnected || !highlight) {
			return;
		}
		if (!cached) {
			this.plugin.sourceModeTokenizationCache.set(this.cacheKey(), highlight);
		}
		this.renderHighlight(code, container, highlight);
	}

	private renderCachedTokens(code: HTMLElement, container: HTMLElement): void {
		const cached = this.getCachedHighlight();
		if (cached) {
			this.renderHighlight(code, container, cached);
		}
	}

	private renderPlainLines(code: HTMLElement): void {
		code.empty();
		const sourceLines = this.block.code.split('\n');
		for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
			const line = code.createSpan({ cls: 'shiki-code-line', text: sourceLines[lineIndex] ?? '' });
			line.dataset.lineIndex = String(lineIndex);
		}
	}

	private renderHighlight(code: HTMLElement, container: HTMLElement, highlight: { bg?: string; tokens: ThemedToken[][] }): void {
		const themeBackground = this.plugin.highlighter.getThemeBackground(highlight);
		if (themeBackground) {
			container.style.setProperty('--shiki-code-background', themeBackground);
		}
		const fragment = document.createDocumentFragment();
		const sourceLines = this.block.code.split('\n');
		for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
			const line = document.createElement('span');
			line.className = 'shiki-code-line';
			line.dataset.lineIndex = String(lineIndex);
			const lineTokens = highlight.tokens[lineIndex];
			if (!lineTokens) {
				line.appendText(sourceLines[lineIndex] ?? '');
			} else {
				for (const token of lineTokens) {
					const tokenStyle = this.plugin.highlighter.getTokenStyle(token);
					line.createSpan({ text: token.content, cls: tokenStyle.classes.join(' '), attr: { style: tokenStyle.style } });
				}
			}
			fragment.appendChild(line);
		}
		code.replaceChildren(fragment);
	}

	private getCachedHighlight(): { bg?: string; tokens: ThemedToken[][] } | undefined {
		return this.plugin.sourceModeTokenizationCache.get(this.cacheKey());
	}

	private cacheKey(): Parameters<ShikiPlugin['sourceModeTokenizationCache']['get']>[0] {
		return {
			sourcePath: this.block.sourcePath,
			language: this.block.language,
			theme: this.activeTheme,
			contentHash: this.block.contentHash,
			settingsSignature: JSON.stringify({ disabledLanguages: this.plugin.loadedSettings.disabledLanguages, theme: this.activeTheme }),
		};
	}

	private focusSourceLine(event: MouseEvent): void {
		const editor = this.plugin.app.workspace.activeEditor?.editor;
		if (!editor || this.block.openingFenceLine === undefined) {
			return;
		}
		const targetLine = event.target instanceof Element ? event.target.closest<HTMLElement>('.shiki-code-line') : null;
		const lineIndex = Number.parseInt(targetLine?.dataset.lineIndex ?? '0', 10) || 0;
		const ch = this.estimateCharacter(event, targetLine);
		editor.setCursor({ line: this.block.openingFenceLine + lineIndex, ch });
		editor.focus();
	}

	private estimateCharacter(event: MouseEvent, line: HTMLElement | null): number {
		if (!line) {
			return 0;
		}
		const rect = line.getBoundingClientRect();
		const scroll = line.closest<HTMLElement>('.shiki-block-body')?.scrollLeft ?? 0;
		const sample = line.ownerDocument.createElement('span');
		sample.textContent = '0000000000';
		sample.style.visibility = 'hidden';
		sample.style.position = 'absolute';
		sample.style.font = getComputedStyle(line).font;
		line.appendChild(sample);
		const charWidth = Math.max(1, sample.getBoundingClientRect().width / 10);
		sample.remove();
		return Math.max(0, Math.round((event.clientX - rect.left + scroll) / charWidth));
	}

	ignoreEvent(event: Event): boolean {
		return event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'click';
	}
}

class ShikiLivePreviewLineNumberWidget extends WidgetType {
	constructor(private readonly lineNumber: number) {
		super();
	}

	eq(other: ShikiLivePreviewLineNumberWidget): boolean {
		return other.lineNumber === this.lineNumber;
	}

	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = 'shiki-live-preview-line-number';
		span.textContent = String(this.lineNumber);
		span.setAttribute('aria-hidden', 'true');
		return span;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export function createLivePreviewStructureExtension(plugin: ShikiPlugin): Extension {
	const parser = new CodeBlockParser();

	const buildState = (state: EditorState): LivePreviewStructureState => {
		if (!isLivePreviewActive(plugin)) {
			return { decorations: Decoration.none };
		}
		const lines = collectLines(state);
		const parsed = parser.parseLivePreviewBlocks(lines);
		const decorations = new RangeSetBuilder<Decoration>();

		for (const parsedBlock of parsed) {
			const block = plugin.codeBlockRegistry.createModel({
				sourcePath: plugin.app.workspace.getActiveFile()?.path ?? '',
				hostMode: 'live-preview',
				language: parsedBlock.language,
				meta: parsedBlock.meta.raw.trim(),
				code: state.doc.sliceString(parsedBlock.range.charFrom, parsedBlock.range.charTo),
				fenceFrom: state.doc.line(parsedBlock.openingFenceLine).from,
				fenceTo: state.doc.line(parsedBlock.closingFenceLine).to,
				codeFrom: parsedBlock.range.charFrom,
				codeTo: parsedBlock.range.charTo,
				sectionStartLine: parsedBlock.openingFenceLine,
				sectionEndLine: parsedBlock.closingFenceLine,
				openingFence: parsedBlock.meta.openingFence,
				openingFenceLine: parsedBlock.openingFenceLine,
				closingFenceLine: parsedBlock.closingFenceLine,
			});
			plugin.codeBlockRegistry.upsert(block);

			if (block.fenceFrom === undefined || block.codeFrom === undefined || block.codeTo === undefined) {
				continue;
			}


			const blockIsSelected = isBlockSelected(state, block);
			if (!plugin.loadedSettings.wrapLines && !blockIsSelected && block.fenceTo !== undefined) {
				decorations.add(
					block.fenceFrom,
					block.fenceTo,
					Decoration.replace({ widget: new ShikiLivePreviewBlockWidget(block, plugin), block: true }),
				);
				continue;
			}

			decorations.add(block.fenceFrom, block.fenceFrom, Decoration.widget({ widget: new ShikiLivePreviewHeaderWidget(block, plugin), block: true, side: -1 }));

			for (let lineNumber = parsedBlock.openingFenceLine; lineNumber <= parsedBlock.closingFenceLine; lineNumber++) {
				const line = state.doc.line(lineNumber);
				const isOpeningFence = lineNumber === parsedBlock.openingFenceLine;
				const isClosingFence = lineNumber === parsedBlock.closingFenceLine;
				const className = isOpeningFence
					? 'shiki-live-preview-fence-line shiki-live-preview-opening-fence-line'
					: isClosingFence
						? 'shiki-live-preview-fence-line shiki-live-preview-closing-fence-line'
						: `shiki-live-preview-code-line${plugin.loadedSettings.wrapLines ? ' shiki-live-preview-code-line-wrap' : ' shiki-live-preview-code-line-nowrap'}`;
				decorations.add(
					line.from,
					line.from,
					Decoration.line({
						attributes: {
							class: className,
							'data-shiki-block-id': block.id,
							'data-shiki-editing-block-id': block.id,
						},
					}),
				);

				if (!isOpeningFence && !isClosingFence && plugin.loadedSettings.showLineNumbers) {
					decorations.add(
						line.from,
						line.from,
						Decoration.widget({ widget: new ShikiLivePreviewLineNumberWidget(lineNumber - parsedBlock.openingFenceLine), side: -1 }),
					);
				}
			}
		}

		return { decorations: decorations.finish() };
	};

	const structureField = StateField.define<LivePreviewStructureState>({
		create: buildState,
		update(_value, transaction) {
			return buildState(transaction.state);
		},
		provide: field => [
			EditorView.decorations.from(field, value => value.decorations),
		],
	});

	return structureField;
}

function isLivePreviewActive(plugin: ShikiPlugin): boolean {
	const activeContainer = plugin.app.workspace.activeLeaf?.view?.containerEl;
	return !!activeContainer && activeContainer.querySelector('.markdown-source-view.mod-cm6.is-live-preview') !== null;
}

function collectLines(state: EditorState): CodeBlockLineInfo[] {
	const lines: CodeBlockLineInfo[] = [];
	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
		const line = state.doc.line(lineNumber);
		lines.push({ lineNumber, text: line.text, from: line.from, to: line.to });
	}
	return lines;
}

function isBlockSelected(state: EditorState, block: CodeBlockModel): boolean {
	const blockFrom = block.fenceFrom ?? block.codeFrom;
	const blockTo = block.fenceTo ?? block.codeTo;
	if (blockFrom === undefined || blockTo === undefined) {
		return false;
	}
	return state.selection.ranges.some(range => (range.empty ? range.from >= blockFrom && range.from <= blockTo : range.from <= blockTo && range.to >= blockFrom));
}
