import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { Prec, type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Cm6_Util } from 'packages/obsidian/src/codemirror/Cm6_Util';
import { type ThemedToken } from 'shiki';
import { editorLivePreviewField } from 'obsidian';

enum DecorationUpdateType {
	Insert,
	Remove,
}

type DecorationUpdate = InsertDecoration | RemoveDecoration;

interface InsertDecoration {
	type: DecorationUpdateType.Insert;
	from: number;
	to: number;
	lang: string;
	content: string;
	hideLang?: boolean;
	hideTo?: number;
}

interface RemoveDecoration {
	type: DecorationUpdateType.Remove;
	from: number;
	to: number;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	const cm6Plugin = ViewPlugin.fromClass(
		class Cm6ViewPlugin {
			decorations: DecorationSet;
			view: EditorView;

			constructor(view: EditorView) {
				this.view = view;
				this.decorations = Decoration.none;
				void this.updateWidgets(view);
			}

			/**
			 * Triggered by codemirror when the view updates.
			 * Depending on the update type, the decorations are either updated or recreated.
			 */
			update(update: ViewUpdate): void {
				try {
					this.decorations = this.decorations.map(update.changes);
				} catch (e) {
					// Decorations may have stale positions if the document changed while an async
					// updateWidgets call was in flight. Reset them so the next update can rebuild.
					this.decorations = Decoration.none;
					console.warn('Resetting decorations due to error:', e);
				}

				if (update.docChanged || update.selectionSet || update.viewportChanged) {
					this.view = update.view;
					void this.updateWidgets(update.view);
				}
			}

			isLivePreview(state: EditorView['state']): boolean {
				// @ts-ignore some strange private field not being assignable
				return state.field(editorLivePreviewField);
			}

			/**
			 * Updates inline code decorations by traversing the syntax tree.
			 * Code blocks in live preview are handled by reading-mode processors (Monaco).
			 */
			async updateWidgets(view: EditorView): Promise<void> {
				const decorationUpdates: DecorationUpdate[] = [];
				const capturedState = view.state;

				syntaxTree(view.state).iterate({
					enter: nodeRef => {
						const node = nodeRef.node;
						const props: Set<string> = new Set<string>(node.type.name?.split('_'));

						if (props.has('formatting')) {
							return;
						}

						if (props.has('inline-code')) {
							const content = Cm6_Util.getContent(view.state, node.from, node.to);

							if (content.startsWith('{') && plugin.settings.inlineHighlighting) {
								const match = content.match(SHIKI_INLINE_REGEX); // format: `{lang} code`
								if (match) {
									const hasSelectionOverlap = Cm6_Util.checkSelectionAndRangeOverlap(view.state.selection, node.from - 1, node.to + 1);

									decorationUpdates.push({
										type: DecorationUpdateType.Insert,
										from: node.from,
										to: node.to,
										lang: match[1],
										content: match[2],
										hideLang: this.isLivePreview(view.state) && !hasSelectionOverlap,
										hideTo: node.from + match[1].length + 3, // hide `{lang} `
									});
								}
							} else {
								// we don't want to highlight normal inline code blocks, thus we remove any of our decorations
								this.removeDecoration(node.from, node.to);
							}
							return;
						}

						// Skip HyperMD-codeblock nodes — reading mode processors handle these.
						if (
							props.has('HyperMD-codeblock') ||
							props.has('HyperMD-codeblock-begin') ||
							props.has('HyperMD-codeblock-end')
						) {
							return;
						}
					},
				});

				const allDecorations: Range<Decoration>[] = [];
				for (const node of decorationUpdates) {
					try {
						if (node.type === DecorationUpdateType.Remove) {
							continue;
						}
						const decorations = await this.buildDecorations(node.from, node.to, node.lang, node.content);
						if (this.view.state.doc !== capturedState.doc) {
							return;
						}
						if (node.hideLang) {
							decorations.unshift(Decoration.replace({}).range(node.from, node.hideTo));
						}
						allDecorations.push(...decorations);
					} catch (e) {
						console.error(e);
					}
				}

				if (allDecorations.length > 0) {
					this.decorations = Decoration.set(allDecorations, true);
					requestAnimationFrame(() => {
						this.view.dispatch(view.state.update({}));
					});
				}
			}

			removeDecoration(from: number, to: number): void {
				this.decorations = this.decorations.update({
					filterFrom: from,
					filterTo: to,
					filter: () => false,
				});
			}

			async buildDecorations(from: number, to: number, language: string, content: string): Promise<Range<Decoration>[]> {
				if (language === '') {
					return [];
				}

				const highlight = await plugin.highlighter.getHighlightTokens(content, language.toLowerCase());

				if (!highlight) {
					return [];
				}

				const tokens = highlight.tokens.flat(1);
				const decorations: Range<Decoration>[] = [];

				for (let i = 0; i < tokens.length; i++) {
					const token = tokens[i];
					const nextToken: ThemedToken | undefined = tokens[i + 1];

					const tokenStyle = plugin.highlighter.getTokenStyle(token);

					decorations.push(
						Decoration.mark({
							attributes: {
								style: tokenStyle.style,
								class: tokenStyle.classes.join(' '),
							},
						}).range(from + token.offset, nextToken ? from + nextToken.offset : to),
					);
				}

				return decorations;
			}

			destroy(): void {
				this.decorations = Decoration.none;
			}
		},
		{
			decorations: v => v.decorations,
		},
	);

	return Prec.highest(cm6Plugin);
}
