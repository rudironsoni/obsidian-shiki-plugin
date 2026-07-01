import { Prec, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { Cm6_Util } from 'packages/obsidian/src/codemirror/Cm6_Util';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/InlineCodeRegex';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { syntaxTree } from '@codemirror/language';
import { LivePreviewAdapter } from 'packages/obsidian/src/modes/LivePreviewAdapter';
import { createLivePreviewStructureExtension } from 'packages/obsidian/src/modes/LivePreviewStructureExtension';
import { SourceModeAdapter } from 'packages/obsidian/src/modes/SourceModeAdapter';
import { type ThemedToken } from 'shiki';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createCm6Plugin(plugin: ShikiPlugin) {
	const activeViewPlugins = new Set<{
		retokenizeSourceMode(): void;
		refreshShikiContent(): void;
	}>();
	const cm6Plugin = ViewPlugin.fromClass(
		class Cm6ViewPlugin {
			decorations = Decoration.none;
			inlineDecorations = Decoration.none;
			private view: EditorView;
			private readonly livePreviewAdapter: LivePreviewAdapter;
			private readonly sourceModeAdapter: SourceModeAdapter;
			private decorationRefreshTimer: number | undefined;
			private destroyed = false;
			private lastIsLivePreview: boolean;

			constructor(view: EditorView) {
				this.view = view;
				this.livePreviewAdapter = new LivePreviewAdapter(plugin, view, this.scheduleDecorationRefresh);
				this.sourceModeAdapter = new SourceModeAdapter(plugin, view, this.scheduleDecorationRefresh);
				this.lastIsLivePreview = this.isLivePreview(view.state);
				activeViewPlugins.add(this);
				void this.updateInlineDecorations();
				if (this.lastIsLivePreview) {
					void this.livePreviewAdapter.forceRefresh();
				} else {
					void this.sourceModeAdapter.retokenize();
				}
				this.refreshDecorations();
			}

			update(update: ViewUpdate): void {
				this.view = update.view;
				const isLivePreview = this.isLivePreview(update.view.state);
				const modeChanged = isLivePreview !== this.lastIsLivePreview;
				this.lastIsLivePreview = isLivePreview;
				if (modeChanged && isLivePreview) {
					this.livePreviewAdapter.refreshForModeChange();
				}
				if (update.docChanged || update.viewportChanged || update.selectionSet) {
					void this.updateInlineDecorations();
				}
				this.livePreviewAdapter.update(update, isLivePreview);
				this.sourceModeAdapter.update(update, isLivePreview);
				if (modeChanged) {
					if (isLivePreview) {
						void this.livePreviewAdapter.forceRefresh();
					} else {
						void this.sourceModeAdapter.retokenize();
					}
				}
				this.refreshDecorations();
				if (isLivePreview) {
					this.livePreviewAdapter.syncGutterVisibility();
				}
			}

			retokenizeSourceMode(): void {
				if (this.lastIsLivePreview) {
					return;
				}

				void this.sourceModeAdapter.retokenize();

				this.scheduleDecorationRefresh();
			}

			refreshShikiContent(): void {
				if (this.destroyed) {
					return;
				}
				if (this.lastIsLivePreview) {
					void this.livePreviewAdapter.forceRefresh();
				} else {
					void this.sourceModeAdapter.retokenize();
				}
				this.scheduleDecorationRefresh();
			}

			destroy(): void {
				activeViewPlugins.delete(this);
				this.destroyed = true;
				if (this.decorationRefreshTimer !== undefined) {
					window.clearTimeout(this.decorationRefreshTimer);
				}
				this.livePreviewAdapter.destroy();
				this.sourceModeAdapter.destroy();
			}

			private isLivePreview(state: EditorView['state']): boolean {
				return state.field(editorLivePreviewField) || this.view.dom.closest('.markdown-source-view.mod-cm6.is-live-preview') !== null;
			}

			private refreshDecorations(): void {
				const ranges: Range<Decoration>[] = [];
				for (const set of [this.inlineDecorations, this.livePreviewAdapter.decorations, this.sourceModeAdapter.decorations]) {
					set.between(0, this.view.state.doc.length, (from, to, value) => {
						ranges.push(value.range(from, to));
					});
				}
				this.decorations = ranges.length ? Decoration.set(ranges, true) : Decoration.none;
				this.livePreviewAdapter.refreshDomMounts?.();
			}

			private readonly scheduleDecorationRefresh = (): void => {
				if (this.destroyed || this.decorationRefreshTimer !== undefined) {
					return;
				}
				this.decorationRefreshTimer = window.setTimeout(() => {
					this.decorationRefreshTimer = undefined;
					if (this.destroyed) {
						return;
					}
					this.refreshDecorations();
					try {
						this.view.dispatch(this.view.state.update({}));
						if (this.lastIsLivePreview) {
							window.setTimeout(() => {
								this.livePreviewAdapter.syncGutterVisibility();
							}, 200);
						}
					} catch (error) {
						if (String(error).includes('Calls to EditorView.update are not allowed while an update is in progress')) {
							this.scheduleDecorationRefresh();
							return;
						}
						throw error;
					}
				}, 16);
			};

			private async updateInlineDecorations(): Promise<void> {
				const inlineRequests: { from: number; to: number; language: string; content: string }[] = [];
				const captured = this.view.state.doc;
				syntaxTree(this.view.state).iterate({
					enter: nodeRef => {
						const props = new Set<string>(nodeRef.node.type.name?.split('_'));
						if (!props.has('inline-code') || props.has('formatting')) {
							return;
						}
						const content = Cm6_Util.getContent(this.view.state, nodeRef.node.from, nodeRef.node.to);
						const match = content.startsWith('{') ? content.match(SHIKI_INLINE_REGEX) : null;
						if (!match || !plugin.settings.inlineHighlighting) {
							return;
						}
						inlineRequests.push({ from: nodeRef.node.from, to: nodeRef.node.to, language: match[1], content: match[2] });
					},
				});

				const built: Range<Decoration>[] = [];
				for (const node of inlineRequests) {
					const decorations = await this.buildInlineTokenDecorations(node.from, node.to, node.language, node.content);
					if (captured !== this.view.state.doc) {
						return;
					}
					built.push(...decorations);
				}
				this.inlineDecorations = built.length ? Decoration.set(built, true) : Decoration.none;
				this.scheduleDecorationRefresh();
			}

			private async buildInlineTokenDecorations(from: number, to: number, language: string, content: string): Promise<Range<Decoration>[]> {
				const highlight = await plugin.highlighter.getHighlightTokens(content, language.toLowerCase());
				if (!highlight) {
					return [];
				}
				const tokens = highlight.tokens.flat(1);
				const decorations: Range<Decoration>[] = [];
				for (let i = 0; i < tokens.length; i++) {
					const token = tokens[i];
					const next: ThemedToken | undefined = tokens[i + 1];
					const tokenStyle = plugin.highlighter.getTokenStyle(token);
					decorations.push(
						Decoration.mark({ attributes: { style: tokenStyle.style, class: tokenStyle.classes.join(' ') } }).range(
							from + token.offset,
							next ? from + next.offset : to,
						),
					);
				}
				return decorations;
			}
		},
		{ decorations: value => value.decorations },
	);

	plugin.updateCm6Plugin = async (): Promise<void> => {
		plugin.sourceModeTokenizationCache.clear();
		for (const viewPlugin of activeViewPlugins) {
			viewPlugin.refreshShikiContent();
		}
		plugin.app.workspace.updateOptions();
	};

	return Prec.highest([createLivePreviewStructureExtension(plugin), cm6Plugin]);
}
