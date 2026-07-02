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
		this.renderNoteLineNumbers(container);

		const header = container.createDiv({ cls: 'shiki-block-header' });
		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: this.block.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		this.bindCopyButton(copyBtn);
		this.renderFenceLine(container, 'opening');

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
		editor.wrap = 'off';
		editor.spellcheck = false;
		editor.autocapitalize = 'off';
		editor.autocomplete = 'off';
		editor.setAttribute('autocorrect', 'off');
		editor.setAttribute('aria-label', `${this.block.language || 'code'} code block editor`);
		this.syncEditorSize(editor, pre);
		this.bindEditor(editor);
		this.renderCachedTokens(code, container);
		void this.renderTokens(code, container);
		this.renderFenceLine(container, 'closing');

		this.bindContainerClick(container, editor);

		requestAnimationFrame(() => {
			if (!container.isConnected) return;
			this.syncNoteLineNumberPosition(container);
			this.restoreEditorState(editor, pre, body, active, selectionStart, selectionEnd, scrollLeft);
		});
	}

	private updateExistingContainer(container: HTMLElement, active: boolean, selectionStart: number, selectionEnd: number, scrollLeft: number): void {
		this.renderNoteLineNumbers(container);
		const lang = container.querySelector<HTMLElement>('.shiki-lang-name');
		if (lang) lang.textContent = this.block.language;
		const copyBtn = container.querySelector<HTMLButtonElement>('.shiki-copy-button');
		if (copyBtn) this.bindCopyButton(copyBtn);

		const body = container.querySelector<HTMLElement>('.shiki-block-body');
		if (!container.querySelector('.shiki-live-preview-opening-fence') || !container.querySelector('.shiki-live-preview-closing-fence')) {
			this.renderContainer(container, true);
			return;
		}
		this.updateFenceLines(container);
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
			this.syncNoteLineNumberPosition(container);
			this.restoreEditorState(editor, pre, body, active, selectionStart, selectionEnd, scrollLeft);
		});
	}

	private renderNoteLineNumbers(container: HTMLElement): void {
		let noteLineNumbers = container.querySelector<HTMLElement>(':scope > .shiki-note-line-numbers');
		if (!noteLineNumbers) {
			noteLineNumbers = document.createElement('div');
			noteLineNumbers.className = 'shiki-note-line-numbers';
			noteLineNumbers.setAttribute('aria-hidden', 'true');
			container.prepend(noteLineNumbers);
		}
		const openingLine = this.block.openingFenceLine;
		const closingLine = this.block.closingFenceLine;
		if (openingLine === undefined || closingLine === undefined || closingLine < openingLine) {
			noteLineNumbers.empty();
			return;
		}
		const expectedCount = closingLine - openingLine + 1;
		if (noteLineNumbers.querySelectorAll('span').length === expectedCount && noteLineNumbers.querySelector('span')?.textContent === String(openingLine)) return;
		noteLineNumbers.empty();
		noteLineNumbers.createDiv({ cls: 'shiki-note-line-number-header-spacer' });
		for (let lineNumber = openingLine; lineNumber <= closingLine; lineNumber++) {
			noteLineNumbers.createSpan({ text: String(lineNumber) });
		}
	}

	private syncNoteLineNumberPosition(container: HTMLElement): void {
		const noteLineNumbers = container.querySelector<HTMLElement>(':scope > .shiki-note-line-numbers');
		if (!noteLineNumbers) return;
		noteLineNumbers.style.removeProperty('left');
		noteLineNumbers.style.removeProperty('width');
	}

	private renderFenceLine(container: HTMLElement, kind: 'opening' | 'closing'): void {
		container.createDiv({
			cls: `shiki-live-preview-fence shiki-live-preview-${kind}-fence`,
			text: kind === 'opening' ? this.openingFenceText() : (this.block.openingFence ?? '```'),
		});
	}

	private updateFenceLines(container: HTMLElement): void {
		const opening = container.querySelector<HTMLElement>('.shiki-live-preview-opening-fence');
		const closing = container.querySelector<HTMLElement>('.shiki-live-preview-closing-fence');
		if (opening) opening.textContent = this.openingFenceText();
		if (closing) closing.textContent = this.block.openingFence ?? '```';
	}

	private openingFenceText(): string {
		const fence = this.block.openingFence ?? '```';
		const meta = this.block.meta.trim();
		return `${fence}${this.block.language}${meta ? ` ${meta}` : ''}`;
	}

	private bindCopyButton(copyBtn: HTMLButtonElement): void {
		copyBtn.onclick = (event): void => {
			event.preventDefault();
			event.stopPropagation();
			navigator.clipboard.writeText(this.block.code).catch(() => {});
		};
	}

	private bindEditor(editor: HTMLTextAreaElement): void {
		this.bindEditorHorizontalPan(editor);
		editor.oninput = (): void => {
			const body = editor.closest<HTMLElement>('.shiki-block-body');
			const scrollLeft = this.getPreservedScrollLeft(editor.closest<HTMLElement>('.shiki-live-preview-block'));
			this.replaceCode(editor.value, editor.selectionStart, editor.selectionEnd);
			this.restoreBodyScroll(body, scrollLeft);
		};
		editor.onclick = (event): void => {
			const container = editor.closest<HTMLElement>('.shiki-live-preview-block');
			const position = this.isMobileApp()
				? (this.positionForPointer(container, event) ?? this.lineAndCharacterForOffset(editor.selectionStart))
				: this.lineAndCharacterForOffset(editor.selectionStart);
			const offset = this.offsetForLineAndCharacter(position.lineIndex, position.ch);
			editor.setSelectionRange(offset, offset);
			this.syncSourceSelection(position.lineIndex, position.ch);
			if (this.isMobileApp()) {
				editor.focus();
				this.showMobileToolbar();
			}
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

	private bindEditorHorizontalPan(editor: HTMLTextAreaElement): void {
		let pointerId: number | null = null;
		let startX = 0;
		let startY = 0;
		let startScrollLeft = 0;
		let isHorizontalPan = false;

		editor.onpointerdown = (event): void => {
			if (event.pointerType === 'mouse' && event.button !== 0) return;
			const body = editor.closest<HTMLElement>('.shiki-block-body');
			if (!body || body.scrollWidth <= body.clientWidth) return;
			pointerId = event.pointerId;
			startX = event.clientX;
			startY = event.clientY;
			startScrollLeft = body.scrollLeft;
			isHorizontalPan = false;
			editor.setPointerCapture?.(event.pointerId);
		};

		editor.onpointermove = (event): void => {
			if (pointerId !== event.pointerId) return;
			const body = editor.closest<HTMLElement>('.shiki-block-body');
			if (!body) return;
			const deltaX = event.clientX - startX;
			const deltaY = event.clientY - startY;
			if (!isHorizontalPan && Math.abs(deltaX) > 6 && Math.abs(deltaX) > Math.abs(deltaY)) {
				isHorizontalPan = true;
			}
			if (!isHorizontalPan) return;
			event.preventDefault();
			this.restoreBodyScroll(body, Math.max(0, startScrollLeft - deltaX));
		};

		const endPan = (event: PointerEvent): void => {
			if (pointerId !== event.pointerId) return;
			editor.releasePointerCapture?.(event.pointerId);
			pointerId = null;
			isHorizontalPan = false;
		};
		editor.onpointerup = endPan;
		editor.onpointercancel = endPan;
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
			if (this.isMobileApp()) {
				editor.focus();
				editor.setSelectionRange(offset, offset);
				this.syncSourceSelection(lineIndex, ch);
				this.showMobileToolbar();
			} else {
				editor.focus();
				editor.setSelectionRange(offset, offset);
				this.syncSourceSelection(lineIndex, ch);
			}
			this.restoreBodyScroll(body, scrollLeft);
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

	private showMobileToolbar(): void {
		requestAnimationFrame(() => {
			(this.plugin.app as { mobileToolbar?: { show?: () => void } }).mobileToolbar?.show?.();
		});
	}

	private isMobileApp(): boolean {
		return (this.plugin.app as { isMobile?: boolean }).isMobile === true;
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
		const preStyle = getComputedStyle(pre);
		editor.style.font = preStyle.font;
		editor.style.fontFamily = preStyle.fontFamily;
		editor.style.fontSize = preStyle.fontSize;
		editor.style.lineHeight = preStyle.lineHeight;
		editor.style.letterSpacing = preStyle.letterSpacing;
		editor.style.tabSize = preStyle.tabSize;
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

	private positionForPointer(container: HTMLElement | null, event: MouseEvent): { lineIndex: number; ch: number } | null {
		if (!container) return null;
		const lines = [...container.querySelectorAll<HTMLElement>('.shiki-code-line')];
		if (lines.length === 0) return null;
		let bestLine: HTMLElement | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const line of lines) {
			const rect = line.getBoundingClientRect();
			const distance = event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
			if (distance < bestDistance) {
				bestDistance = distance;
				bestLine = line;
			}
		}
		if (!bestLine) return null;
		const lineIndex = Number.parseInt(bestLine.dataset.lineIndex ?? '0', 10) || 0;
		return { lineIndex, ch: this.estimateCharacter(event, bestLine) };
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
