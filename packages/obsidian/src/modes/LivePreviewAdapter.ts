import { Decoration, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';

const LIVE_PREVIEW_ADAPTER_OWNER = '__shikiLivePreviewAdapterOwner';

type LivePreviewOwnerElement = HTMLElement & { [LIVE_PREVIEW_ADAPTER_OWNER]?: LivePreviewAdapter };

class ShikiLivePreviewWidget extends WidgetType {
	constructor(
		private readonly block: CodeBlockModel,
		private readonly plugin: ShikiPlugin,
	) {
		super();
	}

	eq(other: ShikiLivePreviewWidget): boolean {
		return other.block.id === this.block.id;
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'shiki-live-preview-block';
		container.dataset.shikiBlockId = this.block.id;
		container.dataset.lang = this.block.language;

		if (this.plugin.loadedSettings.wrapLines) {
			container.classList.add('wrap-lines');
		}

		// Header
		const header = container.createDiv({ cls: 'shiki-block-header' });
		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: this.block.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		copyBtn.onclick = (): void => {
			navigator.clipboard.writeText(this.block.code).catch(() => {});
		};

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

		// Add line numbers if enabled
		if (this.plugin.loadedSettings.showLineNumbers) {
			const lineNumbers = bodyEl.createDiv({ cls: 'shiki-line-numbers' });
			for (let i = 1; i <= lines.length; i++) {
				lineNumbers.createSpan({ text: String(i) });
			}
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
	decorations: DecorationSet = Decoration.none;
	private readonly plugin: ShikiPlugin;
	private readonly requestDecorationRefresh: () => void;
	private readonly parser = new CodeBlockParser();
	private readonly modeClassObserver: MutationObserver;
	private readonly view: EditorView;
	private blocks: CodeBlockModel[] = [];
	private destroyed = false;
	private livePreviewActive = false;
	private lastRootLivePreviewClass = false;

	constructor(plugin: ShikiPlugin, view: EditorView, requestDecorationRefresh: () => void) {
		this.plugin = plugin;
		this.view = view;
		this.requestDecorationRefresh = requestDecorationRefresh;
		const sourceViewRoot = (this.view.dom.closest('.markdown-source-view.mod-cm6') ?? this.view.dom) as LivePreviewOwnerElement;
		this.lastRootLivePreviewClass = sourceViewRoot.classList.contains('is-live-preview');
		this.modeClassObserver = new MutationObserver(this.handleModeClassChange);
		this.modeClassObserver.observe(sourceViewRoot, { attributes: true, attributeFilter: ['class'] });
		if (this.plugin.isCurrentInstance()) {
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER]?.destroy();
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER] = this;
		}
	}

	update(update: ViewUpdate, isLivePreview: boolean): void {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			this.decorations = Decoration.none;
			return;
		}

		if (!this.isActuallyLivePreview(isLivePreview)) {
			this.clearLivePreviewState();
			return;
		}

		this.livePreviewActive = true;

		if (!update.docChanged && !update.viewportChanged) {
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

		const builder = new RangeSetBuilder<Decoration>();
		for (const block of this.blocks) {
			if (block.openingFenceLine === undefined) {
				continue;
			}
			for (let lineNumber = block.openingFenceLine ?? 0; lineNumber <= (block.closingFenceLine ?? -1); lineNumber++) {
				const line = this.view.state.doc.line(lineNumber);
				builder.add(
					line.from,
					line.from,
					Decoration.line({
						attributes: {
							class:
								lineNumber === block.openingFenceLine || lineNumber === block.closingFenceLine
									? 'shiki-editing-codeblock-fence'
									: 'shiki-editing-codeblock-line',
							'data-shiki-editing-block-id': block.id,
						},
					}),
				);
				if (lineNumber === block.openingFenceLine) {
					builder.add(
						line.to,
						line.to,
						Decoration.widget({
							widget: new ShikiLivePreviewWidget(block, this.plugin),
							side: 1,
						}),
					);
				}
			}
			this.plugin.codeBlockRegistry.upsert(block);
		}
		this.decorations = builder.finish();
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
		this.decorations = Decoration.none;
		this.blocks = [];
	}

	private getSourceViewRoot(): HTMLElement {
		return this.view.dom.closest<HTMLElement>('.markdown-source-view.mod-cm6') ?? this.view.dom;
	}
}
