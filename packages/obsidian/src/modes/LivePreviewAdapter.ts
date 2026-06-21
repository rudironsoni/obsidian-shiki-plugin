import { Decoration, type DecorationSet, EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { MonacoEditSync } from 'packages/obsidian/src/monaco/MonacoInputController';

export class LivePreviewAdapter {
	decorations: DecorationSet = Decoration.none;
	private readonly plugin: ShikiPlugin;
	private readonly parser = new CodeBlockParser();
	private readonly overlayRoot: HTMLDivElement;
	private readonly view: EditorView;
	private blocks: CodeBlockModel[] = [];
	private retrySyncTimer: number | undefined;

	constructor(plugin: ShikiPlugin, view: EditorView) {
		this.plugin = plugin;
		this.view = view;
		this.overlayRoot = document.createElement('div');
		this.overlayRoot.className = 'shiki-monaco-overlay-root';
		this.view.dom.appendChild(this.overlayRoot);
		this.view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true });
	}

	update(update: ViewUpdate, isLivePreview: boolean): void {
		if (!isLivePreview) {
			this.decorations = Decoration.none;
			void this.detachAll();
			return;
		}
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
			this.rebuildBlocks();
			this.scheduleSync();
		}
	}

	async forceRefresh(): Promise<void> {
		this.rebuildBlocks();
		await this.syncVisibleBlocks();
	}

	destroy(): void {
		if (this.retrySyncTimer !== undefined) {
			window.clearTimeout(this.retrySyncTimer);
		}
		this.view.scrollDOM.removeEventListener('scroll', this.handleScroll);
		void this.detachAll();
		this.overlayRoot.remove();
	}

	private readonly handleScroll = (): void => {
		this.scheduleSync();
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
			for (let lineNumber = block.openingFenceLine ?? 0; lineNumber <= (block.closingFenceLine ?? -1); lineNumber++) {
				const line = this.view.state.doc.line(lineNumber);
				builder.add(
					line.from,
					line.from,
					Decoration.line({
						attributes: {
							class: lineNumber === block.openingFenceLine || lineNumber === block.closingFenceLine ? 'shiki-editing-codeblock-fence shiki-editing-codeblock-line-hidden' : 'shiki-editing-codeblock-line shiki-editing-codeblock-line-hidden',
							'data-shiki-editing-block-id': block.id,
						},
					}),
				);
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

	private scheduleSync(): void {
		if (this.retrySyncTimer !== undefined) {
			window.clearTimeout(this.retrySyncTimer);
		}
		this.retrySyncTimer = window.setTimeout(() => {
			this.retrySyncTimer = undefined;
			void this.syncVisibleBlocks();
		}, 16);
	}

	private async syncVisibleBlocks(): Promise<void> {
		const visibleIds = new Set<string>();
		for (const block of this.blocks) {
			if (block.codeTo === undefined || block.codeFrom === undefined) {
				continue;
			}
			if (block.codeTo < this.view.viewport.from || block.codeFrom > this.view.viewport.to) {
				continue;
			}
			const lineElements = [...this.view.contentDOM.querySelectorAll(`.shiki-editing-codeblock-line-hidden[data-shiki-editing-block-id="${block.id}"]`)] as HTMLElement[];
			if (lineElements.length === 0) {
				continue;
			}
			const surface = await this.plugin.surfaceRegistry.getOrCreate(block);
			visibleIds.add(block.id);
			const first = lineElements[0];
			const last = lineElements[lineElements.length - 1];
			const rootRect = this.view.dom.getBoundingClientRect();
			const firstRect = first.getBoundingClientRect();
			const lastRect = last.getBoundingClientRect();
			surface.attach(this.overlayRoot);
			surface.hostEl.classList.add('shiki-monaco-codeblock');
			surface.hostEl.style.position = 'absolute';
			surface.hostEl.style.left = `${firstRect.left - rootRect.left}px`;
			surface.hostEl.style.top = `${firstRect.top - rootRect.top}px`;
			surface.hostEl.style.width = `${firstRect.width}px`;
			surface.hostEl.style.height = `${Math.max(lastRect.bottom - firstRect.top, first.offsetHeight)}px`;
			this.plugin.hydrationQueue.enqueue(surface);
		}

		for (const block of this.blocks) {
			if (!visibleIds.has(block.id)) {
				const surface = this.plugin.surfaceRegistry.get(block.id);
				surface?.hostEl.remove();
			}
		}
	}

	private async detachAll(): Promise<void> {
		for (const block of this.blocks) {
			this.plugin.surfaceRegistry.release(block.id);
			this.plugin.codeBlockRegistry.delete(block.id);
		}
		this.blocks = [];
	}

	createEditSync(block: CodeBlockModel): MonacoEditSync {
		return {
			commit: (value: string) => {
				const current = this.blocks.find(candidate => candidate.id === block.id);
				if (!current || current.codeFrom === undefined || current.codeTo === undefined) {
					return;
				}
				if (this.view.state.doc.sliceString(current.codeFrom, current.codeTo) === value) {
					return;
				}
				this.view.dispatch({ changes: { from: current.codeFrom, to: current.codeTo, insert: value } });
			},
			getCurrentRange: () => {
				const current = this.blocks.find(candidate => candidate.id === block.id);
				if (!current || current.codeFrom === undefined || current.codeTo === undefined) {
					return undefined;
				}
				return { from: current.codeFrom, to: current.codeTo };
			},
		};
	}

	async activateBlock(blockId: string): Promise<void> {
		const block = this.blocks.find(candidate => candidate.id === blockId);
		if (!block) {
			return;
		}
		const surface = await this.plugin.surfaceRegistry.getOrCreate(block);
		await surface.activateEditable(this.createEditSync(block));
	}

	deactivateBlock(blockId: string): void {
		this.plugin.surfaceRegistry.get(blockId)?.deactivateToReadonly();
	}
}
