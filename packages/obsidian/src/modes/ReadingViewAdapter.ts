import type { MarkdownPostProcessorContext } from 'obsidian';
import { parseCodeBlockMeta } from 'packages/obsidian/src/codeblocks/CodeBlockMeta';
import type { CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';

interface ReadingBlockState {
	block: CodeBlockModel;
	container: HTMLElement;
	ctx: MarkdownPostProcessorContext;
	language: string;
	observer: MutationObserver | undefined;
	releaseTimer: number | undefined;
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
		};
		this.blockStates.set(block.id, state);
		this.enhanceBlock(state);
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
			this.plugin.codeBlockRegistry.delete(blockId);
			return;
		}
		if (state.container !== container) {
			return;
		}
		state.releaseTimer = window.setTimeout(() => {
			if (state.container.isConnected) {
				return;
			}
			state.observer?.disconnect();
			this.blockStates.delete(blockId);
			this.plugin.codeBlockRegistry.delete(blockId);
		}, 250);
	}

	private enhanceBlock(state: ReadingBlockState): void {
		const container = state.container;
		if (!container.isConnected) {
			return;
		}

		// Wait for Prism to finish
		const codeElement = container.querySelector('code');
		if (!codeElement) {
			return;
		}

		// Apply Shiki highlighting
		void this.applyShikiHighlight(state, codeElement);

		// Apply wrap/scroll classes
		container.classList.add('shiki-reading-block');
		if (this.plugin.loadedSettings.wrapLines) {
			container.classList.add('wrap-lines');
		}
	}

	private async applyShikiHighlight(state: ReadingBlockState, codeElement: HTMLElement): Promise<void> {
		const highlight = await this.plugin.highlighter.getHighlightTokens(state.block.code, state.block.language);
		if (!highlight) {
			return;
		}

		const lines = state.block.code.split('\n');

		// Preserve the original code text but replace with Shiki-colored spans
		codeElement.empty();
		for (let i = 0; i < lines.length; i++) {
			const lineTokens = highlight.tokens[i];
			if (!lineTokens) {
				codeElement.appendChild(document.createTextNode(lines[i] ?? ''));
			} else {
				for (const token of lineTokens) {
					const span = codeElement.createSpan({
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
				codeElement.appendChild(document.createTextNode('\n'));
			}
		}

		// Add line numbers if enabled
		if (this.plugin.loadedSettings.showLineNumbers) {
			const pre = codeElement.parentElement;
			if (pre instanceof HTMLElement) {
				// Only add once
				if (!pre.querySelector('.shiki-line-numbers')) {
					pre.style.display = 'flex';
					const lineNumbers = document.createElement('div');
					lineNumbers.className = 'shiki-line-numbers';
					for (let i = 1; i <= lines.length; i++) {
						lineNumbers.createSpan({ text: String(i) });
					}
					pre.insertBefore(lineNumbers, codeElement);
				}
			}
		}
	}

	private scheduleAttachmentCheck(state: ReadingBlockState): void {
		const attach = (): void => {
			if (!state.container.isConnected) {
				return;
			}
			this.enhanceBlock(state);
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
