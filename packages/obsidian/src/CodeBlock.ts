import { type MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { parseCodeBlockMeta } from 'packages/obsidian/src/codeblocks/CodeBlockMeta';

export class CodeBlock extends MarkdownRenderChild {
	plugin: ShikiPlugin;
	source: string;
	language: string;
	ctx: MarkdownPostProcessorContext;
	cachedMetaString: string;
	private blockId: string | undefined;

	constructor(plugin: ShikiPlugin, containerEl: HTMLElement, source: string, language: string, ctx: MarkdownPostProcessorContext) {
		super(containerEl);

		this.plugin = plugin;
		this.source = source;
		this.language = language;
		this.ctx = ctx;
		this.cachedMetaString = '';
		this.blockId = undefined;
	}

	private getMetaString(): string {
		const sectionInfo = this.ctx.getSectionInfo(this.containerEl);

		if (sectionInfo === null) {
			return '';
		}

		const lines = sectionInfo.text.split('\n');
		const startLine = lines[sectionInfo.lineStart];
		if (!startLine) {
			return '';
		}

		const meta = parseCodeBlockMeta(startLine);
		if (!meta) {
			return '';
		}

		return meta.rawMeta.trim();
	}

	private async render(): Promise<void> {
		try {
			this.blockId = await this.plugin.readingViewAdapter.renderBlock(this.containerEl, this.source, this.language, this.ctx);
		} catch (error) {
			console.error(`[Shiki] Failed to render ${this.language} code block:`, error);
			this.containerEl.empty();
			this.containerEl.createEl('pre', { text: this.source });
		}
	}

	public async rerenderOnNoteChange(): Promise<void> {
		// compare the new meta string to the cached one
		// only rerender if they are different, to avoid unnecessary work
		// since the meta string is likely to be the same most of the time
		// and if the code block content changes obsidian will rerender for us
		const newMetaString = this.getMetaString();
		if (newMetaString !== this.cachedMetaString) {
			this.cachedMetaString = newMetaString;
			await this.render();
		}
	}

	public async forceRerender(): Promise<void> {
		await this.render();
	}

	public onload(): void {
		super.onload();

		this.plugin.addActiveCodeBlock(this);

		this.cachedMetaString = this.getMetaString();
		void this.render();
	}

	public onunload(): void {
		super.onunload();

		this.plugin.removeActiveCodeBlock(this);
		this.plugin.readingViewAdapter.disposeBlock(this.containerEl);

		this.containerEl.empty();
		this.containerEl.innerText = 'unloaded shiki code block';
	}
}
