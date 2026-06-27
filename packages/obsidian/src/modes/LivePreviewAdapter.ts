import { Decoration, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { MonacoEditSync } from 'packages/obsidian/src/monaco/MonacoInputController';

const LIVE_PREVIEW_ADAPTER_OWNER = '__shikiLivePreviewAdapterOwner';

type LivePreviewOwnerElement = HTMLElement & { [LIVE_PREVIEW_ADAPTER_OWNER]?: LivePreviewAdapter };

class LivePreviewMonacoWidget extends WidgetType {
	constructor(private readonly blockId: string) {
		super();
	}

	eq(other: LivePreviewMonacoWidget): boolean {
		return other.blockId === this.blockId;
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'shiki-monaco-live-widget';
		container.dataset.shikiBlockId = this.blockId;
		return container;
	}

	ignoreEvent(): boolean {
		return false;
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
	private retrySyncTimer: number | undefined;
	private visibilityRefreshTimer: number | undefined;
	private activeBlockId: string | undefined;
	private activeBlockAnchor: string | undefined;
	private mobileEditableActivatedAt = 0;
	private lastMobileMode: boolean | undefined;
	private lastViewportKey = '';
	private mobileClassObserver: MutationObserver | undefined;
	private ownerRoot: LivePreviewOwnerElement | undefined;
	private destroyed = false;
	private missingLineRetryCount = 0;
	private livePreviewActive = false;
	private lastRootLivePreviewClass = false;
	private readonly hiddenBlockIds = new Set<string>();
	private readonly hydratingBlockIds = new Set<string>();
	private readonly readinessRetryCounts = new Map<string, number>();
	private readonly pendingWidgetRefreshBlockIds = new Set<string>();
	private domMountRefreshPending = false;

	constructor(plugin: ShikiPlugin, view: EditorView, requestDecorationRefresh: () => void) {
		window.addEventListener('resize', this.handleViewportModeChange);
		this.mobileClassObserver = new MutationObserver(this.handleViewportModeChange);
		this.mobileClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		this.plugin = plugin;
		this.view = view;
		const sourceViewRoot = (this.view.dom.closest('.markdown-source-view.mod-cm6') ?? this.view.dom) as LivePreviewOwnerElement;
		this.lastRootLivePreviewClass = sourceViewRoot.classList.contains('is-live-preview');
		this.modeClassObserver = new MutationObserver(this.handleModeClassChange);
		this.modeClassObserver.observe(sourceViewRoot, { attributes: true, attributeFilter: ['class'] });
		this.requestDecorationRefresh = requestDecorationRefresh;
		if (this.plugin.isCurrentInstance()) {
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER]?.destroy();
			sourceViewRoot[LIVE_PREVIEW_ADAPTER_OWNER] = this;
			this.ownerRoot = sourceViewRoot;
			this.getCleanupRoot()
				.querySelectorAll('.shiki-monaco-overlay-root')
				.forEach(root => root.remove());
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

		if (!this.isActuallyLivePreview(isLivePreview)) {
			this.clearLivePreviewState();
			return;
		}

		this.livePreviewActive = true;
		this.updateViewportMode();

		const viewportKey = this.getViewportKey();
		const viewportActuallyChanged = update.viewportChanged && viewportKey !== this.lastViewportKey;
		if (!update.docChanged && !viewportActuallyChanged) {
			return;
		}

		this.lastViewportKey = viewportKey;
		this.rebuildBlocks();
		this.scheduleSync();
	}

	private isActuallyLivePreview(isLivePreview: boolean): boolean {
		if (isLivePreview) return true;
		return this.getSourceViewRoot()?.classList.contains('is-live-preview') ?? false;
	}
	private getViewportKey(): string {
		return this.view.visibleRanges.map(range => range.from + ':' + range.to).join('|');
	}

	async forceRefresh(): Promise<void> {
		if (this.destroyed || !this.plugin.isCurrentInstance()) {
			return;
		}
		this.livePreviewActive = true;
		this.rebuildBlocks();
		this.domMountRefreshPending = true;
		this.requestDecorationRefresh();
		this.scheduleSync(50);
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
		this.scheduleSync(0);
	}

	refreshDomMounts(): void {
		if (!this.domMountRefreshPending && !this.hasPendingDomMountWork()) {
			return;
		}
		this.domMountRefreshPending = false;
		this.scheduleSync(50);
	}

	destroy(): void {
		this.destroyed = true;
		this.modeClassObserver.disconnect();
		this.mobileClassObserver?.disconnect();
		if (this.retrySyncTimer !== undefined) {
			window.clearTimeout(this.retrySyncTimer);
		}
		if (this.visibilityRefreshTimer !== undefined) {
			window.clearTimeout(this.visibilityRefreshTimer);
		}
		this.view.scrollDOM.removeEventListener('scroll', this.handleScroll);
		window.removeEventListener('resize', this.handleViewportModeChange);
		this.detachAll();
		if (this.ownerRoot?.[LIVE_PREVIEW_ADAPTER_OWNER] === this) {
			delete this.ownerRoot[LIVE_PREVIEW_ADAPTER_OWNER];
		}
	}

	private readonly handleScroll = (): void => {
		this.scheduleSync();
	};

	private readonly handleModeClassChange = (): void => {
		const isLivePreview = this.getSourceViewRoot().classList.contains('is-live-preview');
		if (isLivePreview === this.lastRootLivePreviewClass) {
			return;
		}
		this.refreshForModeChange();
	};

	private hasPendingDomMountWork(): boolean {
		if (!this.livePreviewActive || this.pendingWidgetRefreshBlockIds.size > 0) {
			return this.pendingWidgetRefreshBlockIds.size > 0;
		}
		return this.blocks.some(block => {
			const widget = this.view.contentDOM.querySelector(`.shiki-monaco-live-widget[data-shiki-block-id="${block.id}"]`);
			if (!widget) {
				return false;
			}
			return this.view.contentDOM.querySelector(`[data-shiki-editing-block-id="${block.id}"]:not(.shiki-editing-codeblock-line-hidden)`) !== null;
		});
	}

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
								(lineNumber === block.openingFenceLine || lineNumber === block.closingFenceLine
									? 'shiki-editing-codeblock-fence'
									: 'shiki-editing-codeblock-line') + (this.hiddenBlockIds.has(block.id) ? ' shiki-editing-codeblock-line-hidden' : ''),
							'data-shiki-editing-block-id': block.id,
						},
					}),
				);
				if (lineNumber === block.openingFenceLine) {
					builder.add(
						line.to,
						line.to,
						Decoration.widget({
							widget: new LivePreviewMonacoWidget(block.id),
							side: 1,
						}),
					);
				}
			}
			this.plugin.codeBlockRegistry.upsert(block);
		}
		this.decorations = builder.finish();
		this.reconcileActiveBlockIdentity();
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
		if (!this.livePreviewActive && !this.getSourceViewRoot().classList.contains('is-live-preview')) {
			this.clearLivePreviewState();
			return;
		}
		const visibleIds = new Set<string>();
		const missingVisibleLines = false;
		for (const block of this.blocks) {
			if (block.codeTo === undefined || block.codeFrom === undefined) {
				continue;
			}
			const widget = this.view.contentDOM.querySelector<HTMLElement>(`.shiki-monaco-live-widget[data-shiki-block-id="${block.id}"]`);
			if (!widget && (block.codeTo < this.view.viewport.from || block.codeFrom > this.view.viewport.to)) {
				continue;
			}
			const lineElements = [
				...this.view.contentDOM.querySelectorAll(`.shiki-editing-codeblock-line[data-shiki-editing-block-id="${block.id}"]`),
			] as HTMLElement[];
			if (!widget) {
				visibleIds.add(block.id);
				this.setBlockHidden(block.id, false);
				this.requestWidgetRefresh(block.id);
				continue;
			}
			this.pendingWidgetRefreshBlockIds.delete(block.id);
			this.missingLineRetryCount = 0;
			const surface = this.plugin.surfaceRegistry.getOrCreate(block);
			surface.setNoteScrollerProvider(() => this.getNoteScroller());
			if (this.destroyed || !this.plugin.isCurrentInstance()) {
				return;
			}
			visibleIds.add(block.id);
			const first = lineElements[0] ?? widget;
			const last = lineElements[lineElements.length - 1] ?? widget;
			const firstRect = first.getBoundingClientRect();
			const lastRect = last.getBoundingClientRect();
			this.prepareSurfaceHost(block, surface.hostEl);
			this.dedupeSurfaceHost(surface.hostEl, block.id);
			surface.attach(widget);
			this.setBlockHidden(block.id, true);
			this.removeDuplicateSurfaceHosts(block, surface.hostEl);
			this.removeDuplicateBlockSurfaces(block.id, surface.hostEl);
			const mobileMode = this.isMobile();
			if (mobileMode && this.activeBlockId !== block.id) {
				if (surface.hostEl.classList.contains('shiki-monaco-active') || surface.hostEl.classList.contains('shiki-monaco-editable')) {
					this.activeBlockId = block.id;
					this.activeBlockAnchor = this.getLiveBlockAnchor(block);
				} else {
					surface.deactivateToReadonly();
				}
			}
			surface.setNativeMobileInteraction(mobileMode ? this.createNativeMobileInteraction(block) : undefined);
			surface.hostEl.classList.add('shiki-monaco-codeblock');
			surface.hostEl.dataset.shikiBlockId = block.id;
			surface.hostEl.onclick = (event): void => {
				void this.activateBlock(block.id, { clientX: event.clientX, clientY: event.clientY });
			};
			surface.hostEl.ontouchend = (event): void => {
				const touch = event.changedTouches[0];
				void this.activateBlock(block.id, { clientX: touch?.clientX ?? 0, clientY: touch?.clientY ?? 0 });
			};
		surface.setActivationHandler(point => void this.activateBlock(block.id, point));
		const fallbackHostWidth = Math.max(this.view.contentDOM.clientWidth || 0, 1);
		const widgetWidth = first.getBoundingClientRect().width;
		const lineWidth = Math.max(...lineElements.map(line => line.getBoundingClientRect().width), 0);
		const measuredHostWidth = Math.max(firstRect.width, lastRect.width, widgetWidth, lineWidth, fallbackHostWidth);
		surface.hostEl.style.width = `${measuredHostWidth}px`;
		surface.hostEl.style.maxWidth = `${measuredHostWidth}px`;
		surface.hostEl.style.minWidth = `${fallbackHostWidth}px`;
		surface.hostEl.style.position = 'relative';
		surface.hostEl.style.left = '';
		surface.hostEl.style.top = '';
			const isReady = surface.isVisiblyReady() && this.surfaceMatchesCodeLines(surface.hostEl, lineElements);
			if (!isReady) {
				const estimatedHeight = Math.max(120, Math.min(420, block.code.split('\n').length * 20 + 24));
				const rawHeight = Math.max(lastRect.bottom - firstRect.top, first.offsetHeight, estimatedHeight);
				if (rawHeight > 0) {
					surface.hostEl.style.height = `${rawHeight}px`;
				}
			}
			if (isReady) {
				this.readinessRetryCounts.delete(block.id);
				this.setBlockHidden(block.id, true);
			} else {
				this.hydrateSurface(block, surface, lineElements);
			}
		}

		for (const block of this.blocks) {
			if (!visibleIds.has(block.id)) {
				const surface = this.plugin.surfaceRegistry.get(block.id);
				surface?.hostEl.remove();
				this.setBlockHidden(block.id, false);
			}
		}

		this.removeStaleSurfaceChildren(visibleIds);
		this.removeStaleOverlayRoots();
		if (missingVisibleLines && this.missingLineRetryCount < 20) {
			this.missingLineRetryCount++;
			this.requestDecorationRefresh();
			this.scheduleSync(50);
		}
	}

	private detachAll(): void {
		for (const block of this.blocks) {
			this.hiddenBlockIds.delete(block.id);
			this.hydratingBlockIds.delete(block.id);
			this.readinessRetryCounts.delete(block.id);
			this.pendingWidgetRefreshBlockIds.delete(block.id);
			this.plugin.surfaceRegistry.release(block.id);
			this.plugin.codeBlockRegistry.delete(block.id);
		}
		this.blocks = [];
	}

	private clearLivePreviewState(): void {
		this.livePreviewActive = false;
		this.decorations = Decoration.none;
		this.lastViewportKey = '';
		this.detachAll();
		this.hiddenBlockIds.clear();
		this.hydratingBlockIds.clear();
		this.readinessRetryCounts.clear();
		this.pendingWidgetRefreshBlockIds.clear();
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
		const changed = hidden ? !this.hiddenBlockIds.has(blockId) : this.hiddenBlockIds.has(blockId);
		if (hidden) {
			this.hiddenBlockIds.add(blockId);
		} else {
			this.hiddenBlockIds.delete(blockId);
		}
		for (const line of this.view.contentDOM.querySelectorAll<HTMLElement>(
			`[data-shiki-editing-block-id="${blockId}"].shiki-editing-codeblock-line, [data-shiki-editing-block-id="${blockId}"].shiki-editing-codeblock-fence`,
		)) {
			line.classList.toggle('shiki-editing-codeblock-line-hidden', hidden);
		}
		if (changed) {
			this.scheduleVisibilityRefresh();
		}
	}

	private hydrateSurface(block: CodeBlockModel, surface: ReturnType<ShikiPlugin['surfaceRegistry']['getOrCreate']>, lineElements: HTMLElement[]): void {
		if (this.hydratingBlockIds.has(block.id)) {
			return;
		}
		this.hydratingBlockIds.add(block.id);
		void surface
			.hydrateReadonly()
			.then(() => {
				window.requestAnimationFrame(() => {
					window.requestAnimationFrame(() => {
						this.hydratingBlockIds.delete(block.id);
						if (!this.blocks.some(candidate => candidate.id === block.id)) {
							this.readinessRetryCounts.delete(block.id);
							return;
						}
						if (surface.isVisiblyReady() && this.surfaceMatchesCodeLines(surface.hostEl, lineElements)) {
							this.readinessRetryCounts.delete(block.id);
							this.setBlockHidden(block.id, true);
							return;
						}
						this.setBlockHidden(block.id, false);
						const retryCount = this.readinessRetryCounts.get(block.id) ?? 0;
						if (retryCount < 8) {
							this.readinessRetryCounts.set(block.id, retryCount + 1);
							this.scheduleSync(75);
						}
					});
				});
			})
			.catch(() => {
				this.hydratingBlockIds.delete(block.id);
				this.readinessRetryCounts.delete(block.id);
				if (this.blocks.some(candidate => candidate.id === block.id)) {
					this.setBlockHidden(block.id, false);
				}
			});
	}

	private requestWidgetRefresh(blockId: string): void {
		if (this.pendingWidgetRefreshBlockIds.has(blockId)) {
			return;
		}
		this.pendingWidgetRefreshBlockIds.add(blockId);
		this.domMountRefreshPending = true;
		this.requestDecorationRefresh();
		this.scheduleSync(50);
		window.setTimeout(() => {
			this.pendingWidgetRefreshBlockIds.delete(blockId);
			if (!this.destroyed && this.blocks.some(block => block.id === blockId)) {
				this.scheduleSync(0);
			}
		}, 250);
	}
	private surfaceMatchesCodeLines(surfaceHost: HTMLElement, lineElements: HTMLElement[]): boolean {
		const surfaceRect = surfaceHost.getBoundingClientRect();
		if (surfaceRect.width < 1 || surfaceRect.height < 1) {
			return false;
		}
		if (surfaceHost.parentElement?.classList.contains('shiki-monaco-live-widget')) {
			return true;
		}
		if (lineElements.length === 0) {
			return false;
		}
		const firstRect = lineElements[0].getBoundingClientRect();
		const lastRect = lineElements[lineElements.length - 1].getBoundingClientRect();
		const topAligned = Math.abs(surfaceRect.top - firstRect.top) <= 4;
		const leftAligned = Math.abs(surfaceRect.left - firstRect.left) <= 4;
		const coversHeight = surfaceRect.bottom + 4 >= lastRect.bottom;
		const coversWidth = surfaceRect.right + 4 >= Math.min(lastRect.right, firstRect.right);
		return topAligned && leftAligned && coversHeight && coversWidth;
	}

	private dedupeSurfaceHost(hostEl: HTMLElement, blockId: string): void {
		hostEl.dataset.shikiBlockId = blockId;
		for (const duplicate of Array.from(this.getCleanupRoot().querySelectorAll<HTMLElement>('.shiki-monaco-block, .shiki-monaco-codeblock'))) {
			if (duplicate === hostEl || duplicate.dataset.shikiBlockId !== blockId) continue;
			duplicate.remove();
		}
	}
	private prepareSurfaceHost(block: CodeBlockModel, host: HTMLElement): void {
		host.setAttribute('data-shiki-live-anchor', this.getLiveBlockAnchor(block));
	}
	private reconcileActiveBlockIdentity(): void {
		if (!this.activeBlockId || !this.activeBlockAnchor) {
			return;
		}
		const activeSurface = this.plugin.surfaceRegistry.get(this.activeBlockId);
		if (!activeSurface) {
			return;
		}
		const nextBlock = this.blocks.find(block => block.id !== this.activeBlockId && this.getLiveBlockAnchor(block) === this.activeBlockAnchor);
		if (!nextBlock) {
			return;
		}
		const adopted = this.plugin.surfaceRegistry.adoptSurface(this.activeBlockId, nextBlock);
		if (!adopted) {
			return;
		}
		this.activeBlockId = nextBlock.id;
		this.activeBlockAnchor = this.getLiveBlockAnchor(nextBlock);
	}

	private getLiveBlockAnchor(block: CodeBlockModel): string {
		return `${block.sourcePath}::${block.hostMode}::${block.openingFenceLine}::${block.language}`;
	}

	private getActiveBlock(): CodeBlockModel | undefined {
		if (this.activeBlockId !== undefined) {
			const byId = this.blocks.find(block => block.id === this.activeBlockId);
			if (byId !== undefined) {
				return byId;
			}
		}
		if (this.activeBlockAnchor !== undefined) {
			return this.blocks.find(block => this.getLiveBlockAnchor(block) === this.activeBlockAnchor);
		}
		return undefined;
	}

	private removeStaleOverlayRoots(): void {
		for (const root of Array.from(this.getCleanupRoot().querySelectorAll<HTMLElement>('.shiki-monaco-overlay-root'))) {
			root.remove();
		}
		for (const root of Array.from(document.querySelectorAll<HTMLElement>('.shiki-monaco-overlay-root'))) {
			if (root.querySelector('.shiki-monaco-block, .shiki-monaco-codeblock') === null) {
				root.remove();
			}
		}
	}

	private removeDuplicateSurfaceHosts(block: CodeBlockModel, ownedHost: HTMLElement): void {
		const ownedAnchor = this.getLiveBlockAnchor(block);
		const currentIds = new Set(this.blocks.map(candidate => candidate.id));
		const liveSurfaceSelector =
			'.markdown-source-view.mod-cm6.is-live-preview .shiki-monaco-block, .markdown-source-view.mod-cm6.is-live-preview .shiki-monaco-codeblock';
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

	private removeStaleSurfaceChildren(visibleIds: Set<string>): void {
		for (const element of Array.from(this.getCleanupRoot().querySelectorAll<HTMLElement>('.shiki-monaco-block, .shiki-monaco-codeblock'))) {
			const id = element.getAttribute('data-shiki-block-id');
			if (element.closest('.shiki-monaco-live-widget') === null || (id !== null && !visibleIds.has(id))) {
				element.remove();
				if (id !== null) {
					this.plugin.surfaceRegistry.release(id);
				}
			}
		}
	}

	private scheduleVisibilityRefresh(): void {
		if (this.visibilityRefreshTimer !== undefined) {
			return;
		}
		this.visibilityRefreshTimer = window.setTimeout(() => {
			this.visibilityRefreshTimer = undefined;
			if (this.livePreviewActive && this.getSourceViewRoot().classList.contains('is-live-preview')) {
				this.rebuildBlocks();
			}
			this.requestDecorationRefresh();
		}, 0);
	}

	createEditSync(block: CodeBlockModel): MonacoEditSync {
		const resolveCurrent = (): CodeBlockModel | undefined => {
			const anchor = this.getLiveBlockAnchor(block);
			return (
				this.blocks.find(candidate => candidate.id === block.id) ??
				this.blocks.find(candidate => this.getLiveBlockAnchor(candidate) === anchor) ??
				this.blocks.find(
					candidate =>
						candidate.sourcePath === block.sourcePath &&
						candidate.hostMode === block.hostMode &&
						candidate.openingFenceLine === block.openingFenceLine &&
						candidate.language === block.language,
				)
			);
		};
		return {
			getCurrentRange: (): { from: number; to: number } | undefined => {
				const current = resolveCurrent();
				return current?.codeFrom !== undefined && current.codeTo !== undefined ? { from: current.codeFrom, to: current.codeTo } : undefined;
			},
			commit: (value: string): void => {
				const current = resolveCurrent();
				if (current?.codeFrom === undefined || current.codeTo === undefined) {
					return;
				}
				if (this.view.state.doc.sliceString(current.codeFrom, current.codeTo) === value) {
					return;
				}
				this.view.dispatch({ changes: { from: current.codeFrom, to: current.codeTo, insert: value } });
				this.requestActiveMarkdownSave();
				this.rebuildBlocks();
				this.scheduleSync(0);
			},
		};
	}

	private requestActiveMarkdownSave(): void {
		const view = this.plugin.app.workspace.activeLeaf?.view as { requestSave?: () => void; save?: () => Promise<void> | void } | undefined;
		view?.requestSave?.();
		void view?.save?.();
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
			for (const block of this.blocks) {
				const surface = this.plugin.surfaceRegistry.get(block.id);
				if (
					block.id === this.activeBlockId ||
					surface?.hostEl.classList.contains('shiki-monaco-active') ||
					surface?.hostEl.classList.contains('shiki-monaco-editable')
				) {
					continue;
				}
				surface?.deactivateToReadonly();
			}
		}
		this.lastMobileMode = mobileMode;
	}
	private getSourceViewRoot(): HTMLElement {
		return this.view.dom.closest<HTMLElement>('.markdown-source-view.mod-cm6') ?? this.view.dom;
	}

	private getNoteScroller(): HTMLElement | null {
		if (this.view.scrollDOM.scrollHeight > this.view.scrollDOM.clientHeight + 1) {
			return this.view.scrollDOM;
		}
		let current: HTMLElement | null = this.view.dom;
		while (current && current !== document.body) {
			if (current.scrollHeight > current.clientHeight + 1 && !current.classList.contains('monaco-scrollable-element')) {
				return current;
			}
			current = current.parentElement;
		}
		const viewContent = this.view.dom.closest<HTMLElement>('.view-content');
		if (viewContent) {
			return viewContent;
		}
		return this.view.scrollDOM;
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
		const block = this.blocks.find(candidate => candidate.id === blockId);
		if (!block) {
			return;
		}
		const activeBlock = this.getActiveBlock();
		if (activeBlock !== undefined && this.getLiveBlockAnchor(activeBlock) !== this.getLiveBlockAnchor(block)) {
			this.deactivateBlock(activeBlock.id);
		}
		const surface = this.plugin.surfaceRegistry.get(block.id);
		if (surface === undefined) {
			return;
		}
		this.activeBlockId = block.id;
		this.activeBlockAnchor = this.getLiveBlockAnchor(block);
		this.mobileEditableActivatedAt = this.isMobile() ? Date.now() : 0;
		await surface.activateEditable(this.createEditSync(block), point);
	}
	deactivateBlock(blockId: string): void {
		const mobileDeactivationGraceActive = this.isMobile() && this.activeBlockId === blockId && Date.now() - this.mobileEditableActivatedAt < 8000;
		if (mobileDeactivationGraceActive) {
			return;
		}

		if (this.activeBlockId === blockId) {
			this.activeBlockId = undefined;
			this.activeBlockAnchor = undefined;
		}
		this.plugin.surfaceRegistry.get(blockId)?.deactivateToReadonly();
	}
}
