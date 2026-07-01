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

		const pre = container.querySelector('pre') ?? (container.tagName === 'PRE' ? container : null);
		const codeElement = pre?.querySelector('code');
		if (!pre || !codeElement) {
			return;
		}

		const wrapper = container.tagName === 'PRE' ? (container.parentElement ?? container) : container;
		const existingBody = wrapper.querySelector<HTMLElement>(':scope > .shiki-block-body');

		if (existingBody) {
			void this.applyShikiHighlight(state, codeElement);
			return;
		}

		wrapper.classList.add('shiki-reading-block');
		wrapper.classList.remove('wrap-lines');
		if (this.plugin.loadedSettings.wrapLines) {
			wrapper.classList.add('wrap-lines');
		}
		for (const stale of wrapper.querySelectorAll(':scope > .shiki-block-header, :scope > .shiki-block-body, :scope > .shiki-code-scroll')) {
			stale.remove();
		}

		const header = document.createElement('div');
		header.className = 'shiki-block-header';
		const left = header.createDiv({ cls: 'shiki-header-left' });
		left.createSpan({ cls: 'shiki-lang-name', text: state.language });
		const right = header.createDiv({ cls: 'shiki-header-right' });
		const copyBtn = right.createEl('button', { cls: 'shiki-copy-button', text: 'Copy' });
		copyBtn.onclick = (): void => {
			navigator.clipboard.writeText(state.block.code).catch(() => {});
		};

		const body = document.createElement('div');
		body.className = 'shiki-block-body';
		const scroll = body.createDiv({ cls: 'shiki-code-scroll' });
		pre.remove();
		if (container !== wrapper && container !== pre && container.childElementCount === 0 && container.textContent?.trim() === '') {
			container.remove();
		}
		scroll.appendChild(pre);
		wrapper.appendChild(header);
		wrapper.appendChild(body);

		if (!this.plugin.loadedSettings.wrapLines) {
			pre.style.whiteSpace = 'pre';
			codeElement.style.whiteSpace = 'pre';
		}

		void this.applyShikiHighlight(state, codeElement);
	}

	private async applyShikiHighlight(state: ReadingBlockState, codeElement: HTMLElement): Promise<void> {
		const highlight = await this.plugin.highlighter.getHighlightTokens(state.block.code, state.block.language);
		if (!highlight) {
			return;
		}
		const themeBackground = this.plugin.highlighter.getThemeBackground(highlight);
		if (themeBackground) {
			codeElement.closest<HTMLElement>('.shiki-reading-block')?.style.setProperty('--shiki-code-background', themeBackground);
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
					const tokenStyle = this.plugin.highlighter.getTokenStyle(token);
					codeElement.createSpan({ text: token.content, cls: tokenStyle.classes.join(' '), attr: { style: tokenStyle.style } });
				}
			}
			if (i < lines.length - 1) {
				codeElement.appendChild(document.createTextNode('\n'));
			}
		}

		// Add line numbers if enabled
		const blockRoot = codeElement.closest<HTMLElement>('.shiki-reading-block');
		if (blockRoot) {
			for (const lineNumbers of [...blockRoot.querySelectorAll('.shiki-line-numbers')]) {
				lineNumbers.remove();
			}
		}
		const bodyEl = codeElement.closest<HTMLElement>('.shiki-block-body');
		if (bodyEl) {
			if (!this.plugin.loadedSettings.showLineNumbers) {
				bodyEl.style.display = '';
			}
		}
		if (this.plugin.loadedSettings.showLineNumbers) {
			if (bodyEl && !bodyEl.querySelector('.shiki-line-numbers')) {
				bodyEl.style.display = 'flex';
				const lineNumbers = document.createElement('div');
				lineNumbers.className = 'shiki-line-numbers';
				for (let i = 1; i <= lines.length; i++) {
					lineNumbers.createSpan({ text: String(i) });
				}
				bodyEl.insertBefore(lineNumbers, bodyEl.firstChild);
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
		// Single delayed check; the post-processor already calls us at the right time,
		// but give the DOM a moment to settle before enhancing.
		window.setTimeout(attach, 50);
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
