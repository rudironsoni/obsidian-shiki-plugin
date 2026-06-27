import type { MarkdownPostProcessorContext } from 'obsidian';
import { parseCodeBlockMeta } from 'packages/obsidian/src/codeblocks/CodeBlockMeta';
import type { CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';

type ReadingSurface = ReturnType<ShikiPlugin['surfaceRegistry']['getOrCreate']>;

interface ReadingBlockState {
	block: CodeBlockModel;
	container: HTMLElement;
	ctx: MarkdownPostProcessorContext;
	language: string;
	observer: MutationObserver | undefined;
	releaseTimer: number | undefined;
	surface: ReadingSurface;
}

export class ReadingViewAdapter {
	private readonly plugin: ShikiPlugin;
	private readonly blockIdsByContainer = new WeakMap<HTMLElement, string>();
	private readonly blockStates = new Map<string, ReadingBlockState>();

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
	}

	async renderBlock(container: HTMLElement, source: string, language: string, ctx: MarkdownPostProcessorContext): Promise<string | undefined> {
		const block = this.buildBlockModel(container, source, language, ctx);
		if (!block) {
			return undefined;
		}
		this.plugin.codeBlockRegistry.upsert(block);
		const surface = this.plugin.surfaceRegistry.getOrCreate(block);
		const previousState = this.blockStates.get(block.id);
		if (previousState?.releaseTimer !== undefined) {
			window.clearTimeout(previousState.releaseTimer);
		}
		previousState?.observer?.disconnect();
		const state: ReadingBlockState = {
			block,
			container,
			ctx,
			language: language.toLowerCase(),
			observer: undefined,
			releaseTimer: undefined,
			surface,
		};
		this.blockStates.set(block.id, state);
		this.attachSurface(state, container);
		this.scheduleAttachmentCheck(state);
		this.blockIdsByContainer.set(container, block.id);
		return block.id;
	}

	disposeBlock(container: HTMLElement): void {
		const blockId = this.blockIdsByContainer.get(container);
		if (!blockId) {
			return;
		}
		this.blockIdsByContainer.delete(container);
		const state = this.blockStates.get(blockId);
		if (!state) {
			this.plugin.surfaceRegistry.release(blockId);
			this.plugin.codeBlockRegistry.delete(blockId);
			return;
		}
		if (state.container !== container) {
			return;
		}
		state.releaseTimer = window.setTimeout(() => {
			if (state.container.isConnected || state.container.contains(state.surface.hostEl)) {
				return;
			}
			state.observer?.disconnect();
			this.blockStates.delete(blockId);
			this.plugin.surfaceRegistry.release(blockId);
			this.plugin.codeBlockRegistry.delete(blockId);
		}, 250);
	}

	private scheduleAttachmentCheck(state: ReadingBlockState): void {
		const attach = (): void => {
			if (state.surface.isDisposed()) {
				return;
			}
			const currentContainer = this.findCurrentContainer(state) ?? (state.container.isConnected ? state.container : undefined);
			if (!currentContainer) {
				return;
			}
			this.attachSurface(state, currentContainer);
		};
		const observerRoot = state.container.closest<HTMLElement>('.markdown-preview-view, .markdown-preview-section, .view-content');
		const observer = new MutationObserver(() => {
			window.requestAnimationFrame(attach);
		});
		observer.observe(observerRoot ?? state.container, { childList: true, subtree: true });
		state.observer = observer;
		for (const delayMs of [0, 50, 250, 1000, 2000, 4000]) {
			window.setTimeout(attach, delayMs);
		}
	}

	private attachSurface(state: ReadingBlockState, container: HTMLElement): void {
		if (!container.isConnected || state.surface.isDisposed() || container.contains(state.surface.hostEl)) {
			return;
		}
		state.container = container;
		this.blockIdsByContainer.set(container, state.block.id);
		container.empty();
		state.surface.setNoteScrollerProvider(() => container.closest<HTMLElement>('.markdown-preview-view, .view-content'));
		state.surface.attach(container);
		this.plugin.hydrationQueue.enqueue(state.surface);
	}

	private findCurrentContainer(state: ReadingBlockState): HTMLElement | undefined {
		const root = state.container.closest<HTMLElement>('.markdown-preview-view, .view-content') ?? document.body;
		const candidates = root.querySelectorAll<HTMLElement>('pre[class*="language-"], pre > code[class*="language-"]');
		for (const candidate of candidates) {
			const pre = candidate.matches('pre') ? candidate : candidate.parentElement;
			if (!(pre instanceof HTMLElement)) {
				continue;
			}
			if (this.containerMatchesState(pre, state)) {
				return pre;
			}
		}
		return undefined;
	}

	private containerMatchesState(container: HTMLElement, state: ReadingBlockState): boolean {
		const languageElement = container.matches('[class*="language-"]') ? container : container.querySelector<HTMLElement>('[class*="language-"]');
		const className = [...(languageElement?.classList ?? [])].find(value => value.startsWith('language-'));
		if (className && className.slice('language-'.length).toLowerCase() !== state.language) {
			return false;
		}
		const sectionInfo = state.ctx.getSectionInfo(container);
		if (!sectionInfo) {
			return container.contains(state.surface.hostEl);
		}
		return sectionInfo.lineStart === state.block.sectionStartLine && sectionInfo.lineEnd === state.block.sectionEndLine;
	}

	private buildBlockModel(container: HTMLElement, source: string, language: string, ctx: MarkdownPostProcessorContext): CodeBlockModel | undefined {
		const sectionInfo = ctx.getSectionInfo(container);
		const sectionText = sectionInfo?.text ?? '';
		const lines = sectionText.split('\n');
		const openingLine = sectionInfo ? (lines[sectionInfo.lineStart] ?? '') : '';
		const meta = parseCodeBlockMeta(openingLine);
		return this.plugin.codeBlockRegistry.createModel({
			sourcePath: ctx.sourcePath,
			hostMode: 'reading',
			language: language.toLowerCase(),
			meta: meta?.rawMeta.trim() ?? '',
			code: source,
			sectionStartLine: sectionInfo?.lineStart,
			sectionEndLine: sectionInfo?.lineEnd,
			openingFence: meta?.openingFence,
			openingFenceLine: sectionInfo?.lineStart,
		});
	}
}
