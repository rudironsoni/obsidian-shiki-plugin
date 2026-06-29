import { Decoration, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { EditorSelection, RangeSetBuilder, type Range } from '@codemirror/state';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';

const LIVE_PREVIEW_ADAPTER_OWNER = '__shikiLivePreviewAdapterOwner';

type LivePreviewOwnerElement = HTMLElement & { [LIVE_PREVIEW_ADAPTER_OWNER]?: LivePreviewAdapter };

class ShikiLivePreviewWidget extends WidgetType {
	private readonly showLineNumbers: boolean;
	private readonly wrapLines: boolean;

	constructor(
		private readonly block: CodeBlockModel,
		private readonly plugin: ShikiPlugin,
		private readonly editorView: EditorView,
		private readonly editing = false,
	) {
		super();
		this.showLineNumbers = this.plugin.loadedSettings.showLineNumbers;
		this.wrapLines = this.plugin.loadedSettings.wrapLines;
	}

	eq(other: ShikiLivePreviewWidget): boolean {
		return other.block.id === this.block.id && other.showLineNumbers === this.showLineNumbers && other.wrapLines === this.wrapLines && other.editing === this.editing;
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'shiki-live-preview-block';
		if (this.editing) {
			container.classList.add('is-editing');
		}
		container.dataset.shikiBlockId = this.block.id;
		container.dataset.lang = this.block.language;

		if (this.plugin.loadedSettings.wrapLines) {
			container.classList.add('wrap-lines');
		}

		const focusCodeBlockEditor = (e: Event): void => {
			const clickedCopyButton = e.composedPath().some(node => (node as Element).closest?.('.shiki-copy-button'));
			if (clickedCopyButton) {
				return;
			}
			if (this.block.codeFrom === undefined) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.editorView.focus();
			this.editorView.dispatch({
				selection: EditorSelection.cursor(this.block.codeFrom),
				scrollIntoView: true,
			});
		};

		container.addEventListener('pointerdown', focusCodeBlockEditor);
		container.addEventListener('click', focusCodeBlockEditor);

		// Header
		const header = container.createDiv({ cls: 'shiki-block-header' });
		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: this.block.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		copyBtn.onclick = (e): void => {
			e.stopPropagation();
			navigator.clipboard.writeText(this.block.code).catch(() => {});
		};
		if (this.editing) {
			return container;
		}

		// Body
		const body = container.createDiv({ cls: 'shiki-block-body' });
		const scrollContainer = body.createDiv({ cls: 'shiki-code-scroll' });
		scrollContainer.style.overflowX = 'auto';
		const pre = scrollContainer.createEl('pre');
		pre.style.margin = '0';
		const codeEl = pre.createEl('code');

		if (this.plugin.loadedSettings.wrapLines) {
			pre.style.whiteSpace = 'pre-wrap';
			codeEl.style.whiteSpace = 'pre-wrap';
			codeEl.style.wordBreak = 'break-word';
		} else {
			pre.style.whiteSpace = 'pre';
			codeEl.style.whiteSpace = 'pre';
		}

		// Render tokens asynchronously (with line numbers)
		void this.renderTokens(codeEl, body);

		return container;
	}

	private async renderTokens(codeEl: HTMLElement, bodyEl: HTMLElement): Promise<void> {
		const highlight = await this.plugin.highlighter.getHighlightTokens(this.block.code, this.block.language);
		if (!highlight) {
			codeEl.textContent = this.block.code;
			return;
		}

		const lines = this.block.code.split('\n');

		for (const lineNumbers of [...bodyEl.querySelectorAll('.shiki-line-numbers')]) {
			lineNumbers.remove();
		}
		if (!this.plugin.loadedSettings.showLineNumbers) {
			bodyEl.style.display = '';
		}

		// Add line numbers if enabled
		if (this.plugin.loadedSettings.showLineNumbers) {
			const lineNumbers = document.createElement('div');
			lineNumbers.className = 'shiki-line-numbers';
			for (let i = 1; i <= lines.length; i++) {
				lineNumbers.createSpan({ text: String(i) });
			}
			bodyEl.insertBefore(lineNumbers, bodyEl.firstChild);
		}

		for (let i = 0; i < lines.length; i++) {
			const lineTokens = highlight.tokens[i];
			if (!lineTokens) {
				codeEl.appendChild(document.createTextNode(lines[i] ?? ''));
			} else {
				for (const token of lineTokens) {
					const span = codeEl.createSpan({
						text: token.content,
						attr: { style: `color: ${token.color ?? 'inherit'}` },
					});
					if (token.fontStyle) {
						if (token.fontStyle & 1) span.style.fontStyle = 'italic';
						if (token.fontStyle & 2) span.style.fontWeight = 'bold';
						if (token.fontStyle & 4) span.style.textDecoration = 'underline';
					}
				}
			}
			if (i < lines.length - 1) {
				codeEl.appendChild(document.createTextNode('\n'));
			}
		}
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export class LivePreviewAdapter {
	private static readonly HIDDEN_GUTTER_CLASS = 'shiki-gutter-line-hidden';
	decorations: DecorationSet = Decoration.none;
	private structuralDecorations: DecorationSet = Decoration.none;
	private editTokenDecorations: DecorationSet = Decoration.none;
	private readonly plugin: ShikiPlugin;
	private readonly requestDecorationRefresh: () => void;
	private readonly parser = new CodeBlockParser();
	private readonly modeClassObserver: MutationObserver;
	private readonly view: EditorView;
	private blocks: CodeBlockModel[] = [];
	private destroyed = false;
	private livePreviewActive = false;
	private lastRootLivePreviewClass = false;
	private tokenizationRequest = 0;

	private readonly gutterObserver: MutationObserver;

	constructor(plugin: ShikiPlugin, view: EditorView, requestDecorationRefresh: () => void) {
		this.plugin = plugin;
		this.view = view;
		this.requestDecorationRefresh = requestDecorationRefresh;
		const sourceViewRoot = (this.view.dom.closest('.markdown-source-view.mod-cm6') ?? this.view.dom) as LivePreviewOwnerElement;
		this.lastRootLivePreviewClass = sourceViewRoot.classList.contains('is-live-preview');
		this.modeClassObserver = new MutationObserver(this.handleModeClassChange);
		this.modeClassObserver.observe(sourceViewRoot, { attributes: true, attributeFilter: ['class'] });
		this.gutterObserver = new MutationObserver(() => this.syncGutterVisibility());
		const gutterEl = this.view.dom.querySelector('.cm-lineNumbers');
		if (gutterEl) {
			this.gutterObserver.observe(gutterEl, { childList: true, subtree: true });
		}
		if (this.plugin.isCurrentInstance()) {
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER]?.destroy();
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER] = this;
		}
	}

	update(update: ViewUpdate, isLivePreview: boolean): void {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			this.clearDecorationSets();
			return;
		}

		if (!this.isActuallyLivePreview(isLivePreview)) {
			this.clearLivePreviewState();
			return;
		}

		this.livePreviewActive = true;

		if (!update.docChanged && !update.viewportChanged && !update.selectionSet) {
			return;
		}

		this.rebuildBlocks();
	}

	private isActuallyLivePreview(isLivePreview: boolean): boolean {
		if (isLivePreview) return true;
		return this.getSourceViewRoot()?.classList.contains('is-live-preview') ?? false;
	}

	async forceRefresh(): Promise<void> {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			return;
		}
		this.livePreviewActive = true;
		this.rebuildBlocks();
		this.requestDecorationRefresh();
	}

	refreshForModeChange(): void {
		const isLivePreview = this.getSourceViewRoot().classList.contains('is-live-preview');
		this.lastRootLivePreviewClass = isLivePreview;
		if (!isLivePreview) {
			this.clearLivePreviewState();
			return;
		}
		this.livePreviewActive = true;
		this.rebuildBlocks();
	}

	refreshDomMounts(): void {
		// No-op in Shiki-based live preview (no DOM mounts to refresh)
	}

	destroy(): void {
		this.destroyed = true;
		this.modeClassObserver.disconnect();
		this.gutterObserver.disconnect();
		this.clearLivePreviewState();
	}

	private readonly handleModeClassChange = (): void => {
		const isLivePreview = this.getSourceViewRoot().classList.contains('is-live-preview');
		if (isLivePreview === this.lastRootLivePreviewClass) {
			return;
		}
		this.refreshForModeChange();
	};

	private rebuildBlocks(): void {
		const parsed = this.parser.parseLivePreviewBlocks(this.collectLines());
		this.blocks = parsed.map(block =>
			this.plugin.codeBlockRegistry.createModel({
				sourcePath: this.plugin.app.workspace.getActiveFile()?.path ?? '',
				hostMode: 'live-preview',
				language: block.language,
				meta: block.meta.raw.trim(),
				code: this.view.state.doc.sliceString(block.range.charFrom, block.range.charTo),
				fenceFrom: this.view.state.doc.line(block.openingFenceLine).from,
				fenceTo: this.view.state.doc.line(block.closingFenceLine).to,
				codeFrom: block.range.charFrom,
				codeTo: block.range.charTo,
				sectionStartLine: block.openingFenceLine,
				sectionEndLine: block.closingFenceLine,
				openingFence: block.meta.openingFence,
				openingFenceLine: block.openingFenceLine,
				closingFenceLine: block.closingFenceLine,
			}),
		);

		let selectedBlock: CodeBlockModel | undefined;
		const builder = new RangeSetBuilder<Decoration>();
		for (const block of this.blocks) {
			if (block.openingFenceLine === undefined) {
				continue;
			}
			const blockFrom = block.fenceFrom ?? block.codeFrom;
			const blockTo = block.fenceTo ?? block.codeTo;
			const blockIsSelected =
				blockFrom !== undefined &&
				blockTo !== undefined &&
				this.view.state.selection.ranges.some(range =>
					range.empty ? range.from >= blockFrom && range.from <= blockTo : range.from <= blockTo && range.to >= blockFrom,
				);
			if (blockIsSelected) {
				selectedBlock = block;
			}
			for (let lineNumber = block.openingFenceLine ?? 0; lineNumber <= (block.closingFenceLine ?? -1); lineNumber++) {
				const line = this.view.state.doc.line(lineNumber);
				let className: string;
				if (lineNumber === block.openingFenceLine) {
					className = 'shiki-editing-codeblock-fence';
				} else if (lineNumber === block.closingFenceLine) {
					className = 'shiki-editing-codeblock-fence shiki-editing-codeblock-closing-fence';
				} else if (blockIsSelected) {
					className = `shiki-editing-codeblock-active-line ${this.plugin.loadedSettings.wrapLines ? 'shiki-editing-codeblock-active-line-wrap' : 'shiki-editing-codeblock-active-line-nowrap'}`;
				} else {
					className = 'shiki-editing-codeblock-line';
				}
				builder.add(
					line.from,
					line.from,
					Decoration.line({
						attributes: {
							class: className,
							'data-shiki-editing-block-id': block.id,
						},
					}),
				);
				if (lineNumber === block.openingFenceLine) {
					builder.add(
						line.to,
						line.to,
						Decoration.widget({
							widget: new ShikiLivePreviewWidget(block, this.plugin, this.view, blockIsSelected),
							side: 1,
						}),
					);
				}
			}
			this.plugin.codeBlockRegistry.upsert(block);
		}
		this.structuralDecorations = builder.finish();
		this.refreshDecorationSet();
		void this.retokenizeSelectedBlock(selectedBlock);
	}

	private async retokenizeSelectedBlock(block: CodeBlockModel | undefined): Promise<void> {
		const requestId = ++this.tokenizationRequest;
		if (block?.codeFrom === undefined || block.codeTo === undefined || !block.language || this.plugin.loadedSettings.disabledLanguages.includes(block.language)) {
			this.editTokenDecorations = Decoration.none;
			this.refreshDecorationSet();
			this.requestDecorationRefresh();
			return;
		}

		const theme = getActiveTheme(this.plugin);
		const settingsSignature = JSON.stringify({ disabledLanguages: this.plugin.loadedSettings.disabledLanguages, theme });
		const cached = this.plugin.sourceModeTokenizationCache.get({
			sourcePath: block.sourcePath,
			language: block.language,
			theme,
			contentHash: block.contentHash,
			settingsSignature,
		});
		const highlight = cached ?? (await this.plugin.highlighter.getHighlightTokens(block.code, block.language));
		if (!cached) {
			this.plugin.sourceModeTokenizationCache.set(
				{ sourcePath: block.sourcePath, language: block.language, theme, contentHash: block.contentHash, settingsSignature },
				highlight,
			);
		}
		if (requestId !== this.tokenizationRequest || !highlight || block.codeFrom === undefined || block.codeTo === undefined) {
			return;
		}

		const builder = new RangeSetBuilder<Decoration>();
		for (const lineTokens of highlight.tokens) {
			for (const token of lineTokens) {
				const from = block.codeFrom + token.offset;
				const to = Math.min(from + token.content.length, block.codeTo);
				if (to <= from) {
					continue;
				}
				const tokenStyle = this.plugin.highlighter.getTokenStyle(token);
				builder.add(
					from,
					to,
					Decoration.mark({
						attributes: {
							style: tokenStyle.style,
							class: tokenStyle.classes.join(' '),
						},
					}),
				);
			}
		}

		if (requestId !== this.tokenizationRequest) {
			return;
		}
		this.editTokenDecorations = builder.finish();
		this.refreshDecorationSet();
		this.requestDecorationRefresh();
	}

	private refreshDecorationSet(): void {
		const ranges: Range<Decoration>[] = [];
		for (const set of [this.structuralDecorations, this.editTokenDecorations]) {
			set.between(0, this.view.state.doc.length, (from, to, value) => {
				ranges.push(value.range(from, to));
			});
		}
		this.decorations = ranges.length ? Decoration.set(ranges, true) : Decoration.none;
	}

	public syncGutterVisibility(): void {
		const lines = Array.from(this.view.dom.querySelectorAll('.cm-line'));
		const gutters = Array.from(this.view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement'));
		if (!this.plugin.loadedSettings.showLineNumbers) {
			for (const gutter of gutters) {
				gutter.classList.remove(LivePreviewAdapter.HIDDEN_GUTTER_CLASS);
			}
			return;
		}
		for (const gutter of gutters) {
			gutter.classList.remove(LivePreviewAdapter.HIDDEN_GUTTER_CLASS);
		}
		if (lines.length === 0 || gutters.length === 0) {
			return;
		}

		const gutterLines = gutters.map(gutter => ({
			element: gutter,
			top: gutter.getBoundingClientRect().top,
		}));

		let gutterIndex = 0;
		for (const line of lines) {
			const lineTop = line.getBoundingClientRect().top;

			while (gutterIndex + 1 < gutterLines.length && gutterLines[gutterIndex + 1].top <= lineTop) {
				gutterIndex += 1;
			}

			const gutter = gutterLines[gutterIndex];
			if (!gutter || Math.abs(gutter.top - lineTop) > 1) {
				continue;
			}

			if (line.classList.contains('shiki-editing-codeblock-line') || line.classList.contains('shiki-editing-codeblock-closing-fence')) {
				gutter.element.classList.add(LivePreviewAdapter.HIDDEN_GUTTER_CLASS);
			}
		}
	}

	private collectLines(): CodeBlockLineInfo[] {
		const lines: CodeBlockLineInfo[] = [];
		for (let lineNumber = 1; lineNumber <= this.view.state.doc.lines; lineNumber++) {
			const line = this.view.state.doc.line(lineNumber);
			lines.push({ lineNumber, text: line.text, from: line.from, to: line.to });
		}
		return lines;
	}

	private clearLivePreviewState(): void {
		this.livePreviewActive = false;
		this.clearDecorationSets();
		this.blocks = [];
		window.requestAnimationFrame(() => this.syncGutterVisibility());
	}

	private clearDecorationSets(): void {
		this.tokenizationRequest++;
		this.structuralDecorations = Decoration.none;
		this.editTokenDecorations = Decoration.none;
		this.decorations = Decoration.none;
	}

	private getSourceViewRoot(): HTMLElement {
		return this.view.dom.closest<HTMLElement>('.markdown-source-view.mod-cm6') ?? this.view.dom;
	}
}
