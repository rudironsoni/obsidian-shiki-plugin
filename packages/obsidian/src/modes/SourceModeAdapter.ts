import { Decoration, type DecorationSet, EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { CodeBlockParser } from 'packages/obsidian/src/codeblocks/CodeBlockParser';
import type { CodeBlockLineInfo, CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';

export class SourceModeAdapter {
	decorations: DecorationSet = Decoration.none;
	private readonly plugin: ShikiPlugin;
	private readonly requestDecorationRefresh: () => void;
	private readonly parser = new CodeBlockParser();
	private readonly view: EditorView;
	private tokenizationRequest = 0;

	constructor(plugin: ShikiPlugin, view: EditorView, requestDecorationRefresh: () => void) {
		this.plugin = plugin;
		this.requestDecorationRefresh = requestDecorationRefresh;
		this.view = view;
	}

	update(update: ViewUpdate, isLivePreview: boolean): void {
		this.decorations = this.decorations.map(update.changes);
		if (isLivePreview) {
			this.decorations = Decoration.none;
			return;
		}
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
			void this.retokenize();
		}
	}

	async retokenize(): Promise<void> {
		const requestId = ++this.tokenizationRequest;
		const lines = this.collectLines();
		const parsed = this.parser.parseLivePreviewBlocks(lines);
		const visibleBlocks = parsed
			.map(block => this.toSourceBlock(block))
			.filter(block => block.codeFrom !== undefined && block.codeTo !== undefined)
			.filter(block => (block.codeTo as number) >= this.view.viewport.from && (block.codeFrom as number) <= this.view.viewport.to)
			.filter(block => block.language && !this.plugin.loadedSettings.disabledLanguages.includes(block.language));

		const builder = new RangeSetBuilder<Decoration>();
		const theme = getActiveTheme(this.plugin);
		const settingsSignature = JSON.stringify({ disabledLanguages: this.plugin.loadedSettings.disabledLanguages, theme });

		for (const block of visibleBlocks) {
			const cached = this.plugin.sourceModeTokenizationCache.get({
				sourcePath: block.sourcePath,
				language: block.language,
				theme,
				contentHash: block.contentHash,
				settingsSignature,
			});
			const highlight = cached ?? (await this.plugin.highlighter.getHighlightTokens(block.code, block.language));
			if (!cached) {
				this.plugin.sourceModeTokenizationCache.set({
					sourcePath: block.sourcePath,
					language: block.language,
					theme,
					contentHash: block.contentHash,
					settingsSignature,
				}, highlight);
			}
			if (requestId !== this.tokenizationRequest || !highlight || block.codeFrom === undefined || block.codeTo === undefined) {
				continue;
			}
			const tokens = highlight.tokens.flat(1);
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				const next = tokens[i + 1];
				builder.add(
					block.codeFrom + token.offset,
					next ? block.codeFrom + next.offset : block.codeTo,
					Decoration.mark({
						attributes: {
							style: this.plugin.highlighter.getTokenStyle(token).style,
							class: this.plugin.highlighter.getTokenStyle(token).classes.join(' '),
						},
					}),
				);
			}
		}

		if (requestId !== this.tokenizationRequest) {
			return;
		}
		this.decorations = builder.finish();
		this.requestDecorationRefresh();
	}

	destroy(): void {
		this.tokenizationRequest++;
		this.decorations = Decoration.none;
	}

	private collectLines(): CodeBlockLineInfo[] {
		const lines: CodeBlockLineInfo[] = [];
		for (let lineNumber = 1; lineNumber <= this.view.state.doc.lines; lineNumber++) {
			const line = this.view.state.doc.line(lineNumber);
			lines.push({ lineNumber, text: line.text, from: line.from, to: line.to });
		}
		return lines;
	}

	private toSourceBlock(parsed: ReturnType<CodeBlockParser['parseLivePreviewBlocks']>[number]): CodeBlockModel {
		return this.plugin.codeBlockRegistry.createModel({
			sourcePath: this.plugin.app.workspace.getActiveFile()?.path ?? '',
			hostMode: 'source',
			language: parsed.language,
			meta: parsed.meta.raw.trim(),
			code: this.view.state.doc.sliceString(parsed.range.charFrom, parsed.range.charTo),
			fenceFrom: this.view.state.doc.line(parsed.openingFenceLine).from,
			fenceTo: this.view.state.doc.line(parsed.closingFenceLine).to,
			codeFrom: parsed.range.charFrom,
			codeTo: parsed.range.charTo,
			sectionStartLine: parsed.openingFenceLine,
			sectionEndLine: parsed.closingFenceLine,
			openingFence: parsed.meta.openingFence,
			openingFenceLine: parsed.openingFenceLine,
			closingFenceLine: parsed.closingFenceLine,
		});
	}
}
