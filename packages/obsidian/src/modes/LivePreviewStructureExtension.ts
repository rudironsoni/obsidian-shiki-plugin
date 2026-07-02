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
		this.renderContainer(container, true);
		return container;
	}

	updateDOM(container: HTMLElement): boolean {
		this.renderContainer(container, false);
		return true;
	}

	private renderContainer(container: HTMLElement, rebuild: boolean): void {
		const active = container.querySelector<HTMLTextAreaElement>('.shiki-live-preview-editor') === container.ownerDocument.activeElement;
		const selectionStart = active ? container.querySelector<HTMLTextAreaElement>('.shiki-live-preview-editor')?.selectionStart ?? 0 : 0;
		const selectionEnd = active ? container.querySelector<HTMLTextAreaElement>('.shiki-live-preview-editor')?.selectionEnd ?? selectionStart : selectionStart;
		const scrollLeft = this.getPreservedScrollLeft(container);

		container.className = 'shiki-live-preview-block';
		if (this.wrapLines) {
			container.classList.add('wrap-lines');
		}
		container.dataset.shikiBlockId = this.block.id;
		container.dataset.lang = this.block.language;
		if (!rebuild) {
			this.updateExistingContainer(container, active, selectionStart, selectionEnd, scrollLeft);
			return;
		}

		container.empty();

		const header = container.createDiv({ cls: 'shiki-block-header' });
		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: this.block.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		this.bindCopyButton(copyBtn);

		const body = container.createDiv({ cls: 'shiki-block-body' });
		this.bindBodyScroll(body, container);
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
		const editor = scroll.createEl('textarea', { cls: 'shiki-live-preview-editor' });
		editor.value = this.block.code;
		editor.spellcheck = false;
		editor.setAttribute('aria-label', `${this.block.language || 'code'} code block editor`);
		this.syncEditorSize(editor, pre);
		this.bindEditor(editor);
		this.renderCachedTokens(code, container);
		void this.renderTokens(code, container);

		this.bindContainerClick(container, editor);

		requestAnimationFrame(() => {
			if (!container.isConnected) return;
			this.restoreEditorState(editor, pre, body, active, selectionStart, selectionEnd, scrollLeft);
		});
	}

	private updateExistingContainer(container: HTMLElement, active: boolean, selectionStart: number, selectionEnd: number, scrollLeft: number): void {
		const lang = container.querySelector<HTMLElement>('.shiki-lang-name');
		if (lang) lang.textContent = this.block.language;
		const copyBtn = container.querySelector<HTMLButtonElement>('.shiki-copy-button');
		if (copyBtn) this.bindCopyButton(copyBtn);

		const body = container.querySelector<HTMLElement>('.shiki-block-body');
		const lineNumbers = container.querySelector<HTMLElement>('.shiki-line-numbers');
		if (lineNumbers) this.updateLineNumbers(lineNumbers);
		const pre = container.querySelector('pre');
		const code = container.querySelector<HTMLElement>('code');
		const editor = container.querySelector<HTMLTextAreaElement>('.shiki-live-preview-editor');
		if (!body || !pre || !code || !editor) {
			this.renderContainer(container, true);
			return;
		}
		this.bindBodyScroll(body, container);

		if (editor.value !== this.block.code) {
			editor.value = this.block.code;
		}
		this.bindEditor(editor);
		this.bindContainerClick(container, editor);
		this.renderPlainLines(code);
		this.renderCachedTokens(code, container);
		void this.renderTokens(code, container);
		requestAnimationFrame(() => {
			if (!container.isConnected) return;
			this.restoreEditorState(editor, pre, body, active, selectionStart, selectionEnd, scrollLeft);
		});
	}

	private bindCopyButton(copyBtn: HTMLButtonElement): void {
		copyBtn.onclick = (event): void => {
			event.preventDefault();
			event.stopPropagation();
			navigator.clipboard.writeText(this.block.code).catch(() => {});
		};
	}

	private bindEditor(editor: HTMLTextAreaElement): void {
		editor.oninput = (): void => {
			const body = editor.closest<HTMLElement>('.shiki-block-body');
			const scrollLeft = this.getPreservedScrollLeft(editor.closest<HTMLElement>('.shiki-live-preview-block'));
			this.replaceCode(editor.value, editor.selectionStart, editor.selectionEnd);
			this.restoreBodyScroll(body, scrollLeft);
		};
		editor.onclick = (): void => {
			const position = this.lineAndCharacterForOffset(editor.selectionStart);
			this.syncSourceSelection(position.lineIndex, position.ch);
		};
		editor.onkeyup = (): void => {
			const position = this.lineAndCharacterForOffset(editor.selectionStart);
			this.syncSourceSelection(position.lineIndex, position.ch);
		};
		editor.onscroll = (): void => {
			editor.scrollLeft = 0;
			editor.scrollTop = 0;
		};
	}

	private bindContainerClick(container: HTMLElement, editor: HTMLTextAreaElement): void {
		container.onclick = (event): void => {
			if (event.target instanceof Element && event.target.closest('.shiki-copy-button')) {
				return;
			}
			if (event.target instanceof Element && event.target.closest('.shiki-live-preview-editor')) {
				return;
			}
			const targetLine = event.target instanceof Element ? event.target.closest<HTMLElement>('.shiki-code-line') : null;
			const body = container.querySelector<HTMLElement>('.shiki-block-body');
			const scrollLeft = body?.scrollLeft ?? 0;
			container.dataset.shikiScrollLeft = String(scrollLeft);
			container.dataset.shikiSuppressScrollPersist = 'true';
			const lineIndex = Number.parseInt(targetLine?.dataset.lineIndex ?? '0', 10) || 0;
			const ch = this.estimateCharacter(event, targetLine);
			const offset = this.offsetForLineAndCharacter(lineIndex, ch);
			editor.focus();
			editor.setSelectionRange(offset, offset);
			this.restoreBodyScroll(body, scrollLeft);
			this.syncSourceSelection(lineIndex, ch);
		};
	}

	private bindBodyScroll(body: HTMLElement, container: HTMLElement): void {
		body.onscroll = (): void => {
			if (container.dataset.shikiSuppressScrollPersist === 'true') return;
			container.dataset.shikiScrollLeft = String(body.scrollLeft);
		};
	}

	private getPreservedScrollLeft(container: HTMLElement | null): number {
		const stored = Number.parseFloat(container?.dataset.shikiScrollLeft ?? '');
		if (Number.isFinite(stored)) return stored;
		return container?.querySelector<HTMLElement>('.shiki-block-body')?.scrollLeft ?? 0;
	}

	private restoreBodyScroll(body: HTMLElement | null, scrollLeft: number): void {
		if (!body) return;
		const container = body.closest<HTMLElement>('.shiki-live-preview-block');
		if (container) container.dataset.shikiSuppressScrollPersist = 'true';
		body.scrollLeft = scrollLeft;
		if (container) container.dataset.shikiScrollLeft = String(scrollLeft);
		requestAnimationFrame(() => {
			if (body.isConnected) {
				body.scrollLeft = scrollLeft;
				requestAnimationFrame(() => {
					if (container) delete container.dataset.shikiSuppressScrollPersist;
				});
			}
		});
	}

	private updateLineNumbers(lineNumbers: HTMLElement): void {
		const lineCount = Math.max(1, this.block.code.split('\n').length);
		if (lineNumbers.children.length === lineCount) return;
		lineNumbers.empty();
		for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
			lineNumbers.createSpan({ text: String(lineNumber) });
		}
	}

	private restoreEditorState(
		editor: HTMLTextAreaElement,
		pre: Element,
		body: HTMLElement,
		active: boolean,
		selectionStart: number,
		selectionEnd: number,
		scrollLeft: number,
	): void {
		this.syncEditorSize(editor, pre);
		body.scrollLeft = scrollLeft;
		if (active) {
			editor.focus();
			editor.setSelectionRange(Math.min(selectionStart, editor.value.length), Math.min(selectionEnd, editor.value.length));
		}
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
		const pre = code.closest('pre');
		const editor = code.closest('.shiki-code-scroll')?.querySelector<HTMLTextAreaElement>('.shiki-live-preview-editor');
		if (pre && editor) {
			this.syncEditorSize(editor, pre);
		}
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

	private syncSourceSelection(lineIndex: number, ch: number): void {
		const view = this.getActiveEditorView();
		if (!view || this.block.openingFenceLine === undefined) {
			return;
		}
		const line = view.state.doc.line(Math.min(view.state.doc.lines, this.block.openingFenceLine + lineIndex + 1));
		view.dispatch({ selection: { anchor: Math.min(line.to, line.from + ch) } });
	}

	private replaceCode(code: string, selectionStart: number, selectionEnd: number): void {
		const view = this.getActiveEditorView();
		const range = view ? this.getCurrentCodeRange(view.state) : null;
		if (!view || !range) {
			return;
		}
		view.dispatch({
			changes: { from: range.from, to: range.to, insert: code },
			selection: { anchor: range.from + selectionStart, head: range.from + selectionEnd },
		});
	}

	private getActiveEditorView(): EditorView | null {
		const sourceViewRoot = this.plugin.app.workspace.activeLeaf?.view?.containerEl.querySelector<HTMLElement>('.markdown-source-view.mod-cm6');
		return (sourceViewRoot as { __shikiLivePreviewAdapterOwner?: { view?: EditorView } } | null)?.__shikiLivePreviewAdapterOwner?.view ?? null;
	}

	private getCurrentCodeRange(state: EditorState): { from: number; to: number } | null {
		if (this.block.openingFenceLine === undefined || this.block.openingFenceLine >= state.doc.lines) {
			return null;
		}
		const openingLine = state.doc.line(this.block.openingFenceLine);
		const fence = /^\s*(```+|~~~+)/.exec(openingLine.text)?.[1];
		if (!fence) {
			return null;
		}
		for (let lineNumber = this.block.openingFenceLine + 1; lineNumber <= state.doc.lines; lineNumber++) {
			const line = state.doc.line(lineNumber);
			if (line.text.trimStart().startsWith(fence)) {
				const startLine = state.doc.line(this.block.openingFenceLine + 1);
				return { from: startLine.from, to: Math.max(startLine.from, line.from - 1) };
			}
		}
		return null;
	}

	private offsetForLineAndCharacter(lineIndex: number, ch: number): number {
		const lines = this.block.code.split('\n');
		let offset = 0;
		for (let index = 0; index < Math.min(lineIndex, lines.length); index++) {
			offset += (lines[index]?.length ?? 0) + 1;
		}
		return Math.min(this.block.code.length, offset + ch);
	}

	private lineAndCharacterForOffset(offset: number): { lineIndex: number; ch: number } {
		const lines = this.block.code.split('\n');
		let remaining = Math.max(0, offset);
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const lineLength = lines[lineIndex]?.length ?? 0;
			if (remaining <= lineLength) {
				return { lineIndex, ch: remaining };
			}
			remaining -= lineLength + 1;
		}
		const lastLineIndex = Math.max(0, lines.length - 1);
		return { lineIndex: lastLineIndex, ch: lines[lastLineIndex]?.length ?? 0 };
	}

	private syncEditorSize(editor: HTMLTextAreaElement, pre: Element): void {
		const rect = pre.getBoundingClientRect();
		editor.style.width = `${Math.max(pre.scrollWidth, rect.width)}px`;
		editor.style.height = `${Math.max(pre.scrollHeight, rect.height)}px`;
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
		return event.target instanceof Element && event.target.closest('.shiki-live-preview-block') !== null;
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


			if (!plugin.loadedSettings.wrapLines && block.fenceTo !== undefined) {
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
