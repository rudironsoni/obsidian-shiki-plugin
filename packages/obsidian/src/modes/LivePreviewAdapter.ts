import { Decoration, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { MonacoEditSync } from 'packages/obsidian/src/monaco/MonacoInputController';

const LIVE_PREVIEW_ADAPTER_OWNER = '__shikiLivePreviewAdapterOwner';

type LivePreviewOwnerElement = HTMLElement & { [LIVE_PREVIEW_ADAPTER_OWNER]?: LivePreviewAdapter };

export class LivePreviewAdapter {
	decorations: DecorationSet = Decoration.none;
	private readonly plugin: ShikiPlugin;
	private readonly requestDecorationRefresh: () => void;
	private readonly parser = new CodeBlockParser();
	private readonly modeClassObserver: MutationObserver;
	private readonly overlayRoot: HTMLDivElement;
	private readonly view: EditorView;
	private blocks: CodeBlockModel[] = [];
	private retrySyncTimer: number | undefined;
	private visibilityRefreshTimer: number | undefined;
	private activeBlockId: string | undefined;
	private lastMobileMode: boolean | undefined;
	private lastViewportKey = '';
	private mobileClassObserver: MutationObserver | undefined;
	private ownerRoot: LivePreviewOwnerElement | undefined;
	private destroyed = false;
	private missingLineRetryCount = 0;
	private readonly hiddenBlockIds = new Set<string>();

	constructor(plugin: ShikiPlugin, view: EditorView, requestDecorationRefresh: () => void) {
		window.addEventListener('resize', this.handleViewportModeChange);
		this.mobileClassObserver = new MutationObserver(this.handleViewportModeChange);
		this.mobileClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		this.plugin = plugin;
		this.view = view;
		this.modeClassObserver = new MutationObserver(() => this.refreshForModeChange());
		this.modeClassObserver.observe(this.getSourceViewRoot(), { attributes: true, attributeFilter: ['class'] });
		this.requestDecorationRefresh = requestDecorationRefresh;
		this.overlayRoot = document.createElement('div');
		this.overlayRoot.className = 'shiki-monaco-overlay-root';
		if (this.plugin.isCurrentInstance()) {
			const sourceViewRoot = (this.view.dom.closest('.markdown-source-view.mod-cm6') ?? this.view.dom) as LivePreviewOwnerElement;
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER]?.destroy();
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER] = this;
			this.ownerRoot = sourceViewRoot;
			this.getCleanupRoot()
				.querySelectorAll('.shiki-monaco-overlay-root')
				.forEach(root => root.remove());
			this.view.dom.appendChild(this.overlayRoot);
			this.view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true });
			window.addEventListener('resize', this.handleScroll, { passive: true });
		}
	}

	update(update: ViewUpdate, isLivePreview: boolean): void {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			this.decorations = Decoration.none;
			this.detachAll();
			return;
		}

		this.updateViewportMode();

		if (!isLivePreview) {
			this.decorations = Decoration.none;
			this.lastViewportKey = '';
			this.detachAll();
			return;
		}

		const viewportKey = this.getViewportKey();
		const viewportActuallyChanged = update.viewportChanged && viewportKey !== this.lastViewportKey;
		if (!update.docChanged && !viewportActuallyChanged) {
			return;
		}

		this.lastViewportKey = viewportKey;
		this.rebuildBlocks();
		this.scheduleSync();
	}

	private getViewportKey(): string {
		return this.view.visibleRanges.map(range => range.from + ':' + range.to).join('|');
	}

	async forceRefresh(): Promise<void> {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			return;
		}
		this.rebuildBlocks();
		this.requestDecorationRefresh();
		this.scheduleSync(50);
	}

	refreshForModeChange(): void {
		this.rebuildBlocks();
		this.scheduleSync(0);
	}

	destroy(): void {
		this.destroyed = true;
		this.modeClassObserver.disconnect();
		if (this.retrySyncTimer !== undefined) {
			window.clearTimeout(this.retrySyncTimer);
		}
		if (this.visibilityRefreshTimer !== undefined) {
			window.clearTimeout(this.visibilityRefreshTimer);
		}
		this.view.scrollDOM.removeEventListener('scroll', this.handleScroll);
		window.removeEventListener('resize', this.handleScroll);
		this.detachAll();
		this.overlayRoot.remove();
		if (this.ownerRoot?.[LIVE_PREVIEW_ADAPTER_OWNER] === this) {
			delete this.ownerRoot[LIVE_PREVIEW_ADAPTER_OWNER];
		}
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
			const hiddenClass = this.hiddenBlockIds.has(block.id) ? ' shiki-editing-codeblock-line-hidden' : '';
			for (let lineNumber = block.openingFenceLine ?? 0; lineNumber <= (block.closingFenceLine ?? -1); lineNumber++) {
				const line = this.view.state.doc.line(lineNumber);
				builder.add(
					line.from,
					line.from,
					Decoration.line({
						attributes: {
							class:
								lineNumber === block.openingFenceLine || lineNumber === block.closingFenceLine
									? `shiki-editing-codeblock-fence${hiddenClass}`
									: `shiki-editing-codeblock-line${hiddenClass}`,
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

	private scheduleSync(delayMs = 16): void {
		if (this.destroyed) {
			return;
		}
		if (this.retrySyncTimer !== undefined) {
			window.clearTimeout(this.retrySyncTimer);
		}
		this.retrySyncTimer = window.setTimeout(() => {
			this.retrySyncTimer = undefined;
			void this.syncVisibleBlocks();
		}, delayMs);
	}

	private async syncVisibleBlocks(): Promise<void> {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			this.detachAll();
			return;
		}
		this.ensureSingleOverlayRoot();
		const visibleIds = new Set<string>();
		let missingVisibleLines = false;
		for (const block of this.blocks) {
			if (block.codeTo === undefined || block.codeFrom === undefined) {
				continue;
			}
			if (block.codeTo < this.view.viewport.from || block.codeFrom > this.view.viewport.to) {
				continue;
			}
			const lineElements = [
				...this.view.contentDOM.querySelectorAll(`.shiki-editing-codeblock-line[data-shiki-editing-block-id="${block.id}"]`),
			] as HTMLElement[];
			if (lineElements.length === 0) {
				missingVisibleLines = true;
				continue;
			}
			this.missingLineRetryCount = 0;
			const surface = this.plugin.surfaceRegistry.getOrCreate(block);
			surface.setNoteScrollerProvider(() => this.view.scrollDOM);
			if (this.destroyed || !this.plugin.isCurrentInstance()) {
				return;
			}
			visibleIds.add(block.id);
			const first = lineElements[0];
			const last = lineElements[lineElements.length - 1];
			const rootRect = this.view.dom.getBoundingClientRect();
			const firstRect = first.getBoundingClientRect();
			const lastRect = last.getBoundingClientRect();
			this.prepareSurfaceHost(block, surface.hostEl);
			surface.attach(this.overlayRoot);
			this.removeDuplicateSurfaceHosts(block, surface.hostEl);
			this.removeDuplicateBlockSurfaces(block.id, surface.hostEl);
			const mobileMode = this.isMobile();
			if (mobileMode && this.activeBlockId !== block.id) {
				surface.deactivateToReadonly();
			}
			surface.setNativeMobileInteraction(mobileMode ? this.createNativeMobileInteraction(block) : undefined);
			surface.hostEl.classList.add('shiki-monaco-codeblock');
			surface.hostEl.dataset.shikiBlockId = block.id;
			surface.hostEl.onclick = event => {
				this.activateBlock(block.id, { clientX: event.clientX, clientY: event.clientY });
			};
			surface.hostEl.ontouchend = event => {
				const touch = event.changedTouches[0];
				this.activateBlock(block.id, { clientX: touch?.clientX ?? 0, clientY: touch?.clientY ?? 0 });
			};
			surface.setActivationHandler(point => void this.activateBlock(block.id, point));
			surface.hostEl.style.position = 'absolute';
			surface.hostEl.style.left = `${firstRect.left - rootRect.left}px`;
			surface.hostEl.style.top = `${firstRect.top - rootRect.top}px`;
			const overlayWidth = Math.max(firstRect.width, this.view.scrollDOM.clientWidth, rootRect.width);
			surface.hostEl.style.width = `${overlayWidth}px`;
			surface.hostEl.style.height = `${Math.max(lastRect.bottom - firstRect.top, first.offsetHeight)}px`;
			if (surface.isHydrated()) {
				this.setBlockHidden(block.id, true);
			} else {
				this.setBlockHidden(block.id, false);
				void surface.hydrateReadonly().then(() => {
					if (this.blocks.some(candidate => candidate.id === block.id)) {
						this.setBlockHidden(block.id, true);
					}
				});
			}
		}

		for (const block of this.blocks) {
			if (!visibleIds.has(block.id)) {
				const surface = this.plugin.surfaceRegistry.get(block.id);
				surface?.hostEl.remove();
				this.setBlockHidden(block.id, false);
			}
		}

		this.removeStaleOverlayChildren(visibleIds);
		this.ensureSingleOverlayRoot();
		if (missingVisibleLines && this.missingLineRetryCount < 20) {
			this.missingLineRetryCount++;
			this.requestDecorationRefresh();
			this.scheduleSync(50);
		}
	}

	private detachAll(): void {
		for (const block of this.blocks) {
			this.hiddenBlockIds.delete(block.id);
			this.plugin.surfaceRegistry.release(block.id);
			this.plugin.codeBlockRegistry.delete(block.id);
		}
		this.blocks = [];
	}

	private getCleanupRoot(): HTMLElement {
		const activeLeafView = this.plugin.app.workspace.activeLeaf?.view;
		const activeLeafContent = activeLeafView && 'contentEl' in activeLeafView ? activeLeafView.contentEl : undefined;
		return activeLeafContent instanceof HTMLElement ? activeLeafContent : (this.ownerRoot ?? this.view.dom);
	}

	private removeDuplicateBlockSurfaces(blockId: string, current: HTMLElement): void {
		this.getCleanupRoot()
			.querySelectorAll('.shiki-monaco-codeblock')
			.forEach(element => {
				if (element !== current && element.getAttribute('data-shiki-block-id') === blockId) {
					element.remove();
				}
			});
	}

	private setBlockHidden(blockId: string, hidden: boolean): void {
		const changed = hidden ? !this.hiddenBlockIds.has(blockId) : this.hiddenBlockIds.delete(blockId);
		if (hidden) {
			this.hiddenBlockIds.add(blockId);
		}
		if (!changed) {
			return;
		}
		this.rebuildBlocks();
		this.scheduleVisibilityRefresh();
	}

	private prepareSurfaceHost(block: CodeBlockModel, host: HTMLElement): void {
		host.setAttribute('data-shiki-live-anchor', this.getLiveBlockAnchor(block));
	}

	private getLiveBlockAnchor(block: CodeBlockModel): string {
		return [block.sourcePath, block.hostMode, block.openingFenceLine, block.codeFrom, block.language].join('::');
	}

	private ensureSingleOverlayRoot(): void {
		for (const root of Array.from(this.getCleanupRoot().querySelectorAll<HTMLElement>('.shiki-monaco-overlay-root'))) {
			if (root !== this.overlayRoot) {
				root.remove();
			}
		}
		for (const root of Array.from(document.querySelectorAll<HTMLElement>('.shiki-monaco-overlay-root'))) {
			if (root !== this.overlayRoot && root.querySelector('.shiki-monaco-block, .shiki-monaco-codeblock') === null) {
				root.remove();
			}
		}
		if (this.overlayRoot.parentElement !== this.view.dom) {
			this.view.dom.appendChild(this.overlayRoot);
		}
	}

	private removeDuplicateSurfaceHosts(block: CodeBlockModel, ownedHost: HTMLElement): void {
		const ownedAnchor = this.getLiveBlockAnchor(block);
		const currentIds = new Set(this.blocks.map(candidate => candidate.id));
		const liveSurfaceSelector = '.markdown-source-view.mod-cm6.is-live-preview .shiki-monaco-block, .markdown-source-view.mod-cm6.is-live-preview .shiki-monaco-codeblock';
		for (const element of Array.from(document.querySelectorAll<HTMLElement>(liveSurfaceSelector))) {
			if (element === ownedHost) {
				continue;
			}
			const id = element.getAttribute('data-shiki-block-id');
			const anchor = element.getAttribute('data-shiki-live-anchor');
			if (anchor === ownedAnchor || (id !== null && !currentIds.has(id))) {
				element.remove();
				if (id !== null && id !== block.id) {
					this.plugin.surfaceRegistry.release(id);
				}
			}
		}
	}

	private removeStaleOverlayChildren(visibleIds: Set<string>): void {
		for (const element of Array.from(this.overlayRoot.querySelectorAll<HTMLElement>('.shiki-monaco-block, .shiki-monaco-codeblock'))) {
			const id = element.getAttribute('data-shiki-block-id');
			if (id !== null && !visibleIds.has(id)) {
				element.remove();
				this.plugin.surfaceRegistry.release(id);
			}
		}
	}

	private scheduleVisibilityRefresh(): void {
		if (this.visibilityRefreshTimer !== undefined) {
			return;
		}
		this.visibilityRefreshTimer = window.setTimeout(() => {
			this.visibilityRefreshTimer = undefined;
			this.requestDecorationRefresh();
		}, 0);
	}

	createEditSync(block: CodeBlockModel): MonacoEditSync {
		return {
			commit: (value: string): void => {
				const current = this.blocks.find(candidate => candidate.id === block.id);
				if (current?.codeFrom === undefined || current.codeTo === undefined) {
					return;
				}
				if (this.view.state.doc.sliceString(current.codeFrom, current.codeTo) === value) {
					return;
				}
				this.view.dispatch({ changes: { from: current.codeFrom, to: current.codeTo, insert: value } });
			},
			getCurrentRange: (): { from: number; to: number } | undefined => {
				const current = this.blocks.find(candidate => candidate.id === block.id);
				if (current?.codeFrom === undefined || current.codeTo === undefined) {
					return undefined;
				}
				return { from: current.codeFrom, to: current.codeTo };
			},
		};
	}

	private createNativeMobileInteraction(block: CodeBlockModel): {
		placeCursor(position: { lineNumber: number; column: number }): void;
		selectWord(position: { lineNumber: number; column: number }): void;
	} {
		return {
			placeCursor: (position): void => {
				const editorPosition = this.monacoPositionToEditorPosition(block, position);
				const editor = this.getObsidianEditor();
				if (!editor || !editorPosition) {
					return;
				}
				editor.setCursor(editorPosition);
				editor.scrollIntoView({ from: editorPosition, to: editorPosition }, false);
				this.focusNativeEditor(editor);
			},
			selectWord: (position): void => {
				const editorPosition = this.monacoPositionToEditorPosition(block, position);
				const editor = this.getObsidianEditor();
				if (!editor || !editorPosition) {
					return;
				}
				const word = editor.wordAt(editorPosition);
				if (word) {
					editor.setSelection(word.from, word.to);
				} else {
					editor.setCursor(editorPosition);
				}
				this.focusNativeEditor(editor);
			},
		};
	}

	private focusNativeEditor(editor: { focus(): void }): void {
		editor.focus();
		this.view.focus();
		this.view.contentDOM.tabIndex = this.view.contentDOM.tabIndex < 0 ? -1 : this.view.contentDOM.tabIndex;
		this.view.contentDOM.focus({ preventScroll: true });
		const view = this.plugin.app.workspace.activeLeaf?.view as
			| { contentEl?: HTMLElement; editor?: { cm?: { focus?: () => void }; cmEditor?: { focus?: () => void } } }
			| undefined;
		view?.editor?.cm?.focus?.();
		view?.editor?.cmEditor?.focus?.();
		const content = view?.contentEl?.querySelector<HTMLElement>('.cm-content[contenteditable="true"], .cm-content');
		if (content) {
			content.tabIndex = content.tabIndex < 0 ? -1 : content.tabIndex;
			content.focus({ preventScroll: true });
		}
	}

	private monacoPositionToEditorPosition(block: CodeBlockModel, position: { lineNumber: number; column: number }): { line: number; ch: number } | undefined {
		if (block.codeFrom === undefined) {
			return undefined;
		}
		const lines = block.code.split('\n');
		const lineIndex = Math.max(0, Math.min(lines.length - 1, position.lineNumber - 1));
		let offsetInCode = 0;
		for (let index = 0; index < lineIndex; index++) {
			offsetInCode += (lines[index]?.length ?? 0) + 1;
		}
		offsetInCode += Math.max(0, Math.min(lines[lineIndex]?.length ?? 0, position.column - 1));
		const offset = block.codeFrom + offsetInCode;
		const line = this.view.state.doc.lineAt(offset);
		return { line: line.number - 1, ch: offset - line.from };
	}

	private getObsidianEditor():
		| {
				setCursor(position: { line: number; ch: number }): void;
				setSelection(anchor: { line: number; ch: number }, head?: { line: number; ch: number }): void;
				scrollIntoView(range: { from: { line: number; ch: number }; to: { line: number; ch: number } }, center?: boolean): void;
				wordAt(position: { line: number; ch: number }): { from: { line: number; ch: number }; to: { line: number; ch: number } } | null;
				focus(): void;
		  }
		| undefined {
		const view = this.plugin.app.workspace.activeLeaf?.view;
		return view && 'editor' in view ? (view.editor as ReturnType<LivePreviewAdapter['getObsidianEditor']>) : undefined;
	}

	private readonly handleViewportModeChange = (): void => {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			return;
		}
		this.updateViewportMode();
	};

	private updateViewportMode(): void {
		const mobileMode = this.isMobile();
		if (mobileMode && this.lastMobileMode !== true) {
			if (this.activeBlockId) {
				this.deactivateBlock(this.activeBlockId);
			}
			for (const block of this.blocks) {
				this.plugin.surfaceRegistry.get(block.id)?.deactivateToReadonly();
			}
		}
		this.lastMobileMode = mobileMode;
	}
	private getSourceViewRoot(): HTMLElement {
		return this.view.dom.closest('.markdown-source-view.mod-cm6') as HTMLElement | null ?? this.view.dom;
	}

	private isMobile(): boolean {
		const app = this.plugin.app as typeof this.plugin.app & { isMobile?: boolean };
		if (typeof app.isMobile === 'boolean') {
			return app.isMobile;
		}
		return (
			document.body.classList.contains('is-mobile') ||
			document.body.classList.contains('is-phone') ||
			document.body.classList.contains('is-tablet') ||
			window.matchMedia?.('(pointer: coarse)').matches ||
			navigator.maxTouchPoints > 0 ||
			(window.visualViewport?.width ?? window.innerWidth) <= 820
		);
	}

	async activateBlock(blockId: string, point?: { clientX: number; clientY: number }): Promise<void> {
		if (this.activeBlockId && this.activeBlockId !== blockId) {
			this.deactivateBlock(this.activeBlockId);
		}
		const block = this.blocks.find(candidate => candidate.id === blockId);
		if (!block) {
			return;
		}
		const surface = this.plugin.surfaceRegistry.getOrCreate(block);
		this.activeBlockId = blockId;
		await surface.activateEditable(this.createEditSync(block), point);
	}

	deactivateBlock(blockId: string): void {
		if (this.activeBlockId === blockId) {
			this.activeBlockId = undefined;
		}
		this.plugin.surfaceRegistry.get(blockId)?.deactivateToReadonly();
	}
}
