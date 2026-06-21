import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { getActiveTheme } from 'packages/obsidian/src/LazyHighlighter';
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

interface LivePreviewCodeBlock {
	blockId: string;
	code: string;
	codeFrom: number;
	codeTo: number;
	codeStartLine: number;
	codeEndLine: number;
	language: string;
	openingFenceLine: number;
	closingFenceLine: number;
}

interface MonacoBlockHandle {
	blockId: string;
	codeFrom: number;
	codeTo: number;
	container: HTMLDivElement;
	editor: any;
	focusDisposable: { dispose(): void };
	blurDisposable: { dispose(): void };
	changeDisposable: { dispose(): void };
	language: string;
	suppressModelSync: boolean;
}

const OPENING_FENCE_RE = /^\s*([`~]{3,})([^\s`~]*)?.*$/;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	const cm6Plugin = ViewPlugin.fromClass(
		class Cm6ViewPlugin {
			decorations: DecorationSet;
			inlineDecorations: DecorationSet;
			blockDecorations: DecorationSet;
			livePreviewBlocks: LivePreviewCodeBlock[];
			monacoBlocks: Map<string, MonacoBlockHandle>;
			overlayRoot: HTMLDivElement;
			view: EditorView;
			private syncingLivePreview = false;
			private runtimePromise: Promise<any> | undefined;

			constructor(view: EditorView) {
				this.view = view;
				this.decorations = Decoration.none;
				this.inlineDecorations = Decoration.none;
				this.blockDecorations = Decoration.none;
				this.livePreviewBlocks = [];
				this.monacoBlocks = new Map();
				this.overlayRoot = document.createElement('div');
				this.overlayRoot.className = 'shiki-monaco-overlay-root';
				this.view.dom.appendChild(this.overlayRoot);
				this.rebuildLivePreviewBlocks(view);
				void this.updateWidgets(view);
				this.scheduleLivePreviewSync();
			}

			/**
			 * Triggered by codemirror when the view updates.
			 * Depending on the update type, the decorations are either updated or recreated.
			 */
			update(update: ViewUpdate): void {
				try {
					this.inlineDecorations = this.inlineDecorations.map(update.changes);
					this.blockDecorations = this.blockDecorations.map(update.changes);
					this.refreshDecorations();
				} catch (e) {
					// Decorations may have stale positions if the document changed while an async
					// updateWidgets call was in flight. Reset them so the next update can rebuild.
					this.decorations = Decoration.none;
					this.inlineDecorations = Decoration.none;
					this.blockDecorations = Decoration.none;
					console.warn('Resetting decorations due to error:', e);
				}

				if (update.docChanged || update.selectionSet || update.viewportChanged) {
					this.view = update.view;
					this.rebuildLivePreviewBlocks(update.view);
					void this.updateWidgets(update.view);
					this.scheduleLivePreviewSync();
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
						if (props.has('HyperMD-codeblock') || props.has('HyperMD-codeblock-begin') || props.has('HyperMD-codeblock-end')) {
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

				this.inlineDecorations = allDecorations.length > 0 ? Decoration.set(allDecorations, true) : Decoration.none;
				this.refreshDecorations();
				requestAnimationFrame(() => {
					this.view.dispatch(view.state.update({}));
				});
			}

			private refreshDecorations(): void {
				const ranges: Range<Decoration>[] = [];
				this.blockDecorations.between(0, this.view.state.doc.length, (from, to, value) => {
					ranges.push(value.range(from, to));
				});
				this.inlineDecorations.between(0, this.view.state.doc.length, (from, to, value) => {
					ranges.push(value.range(from, to));
				});
				this.decorations = ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
			}

			private rebuildLivePreviewBlocks(view: EditorView): void {
				if (!this.isLivePreview(view.state)) {
					this.livePreviewBlocks = [];
					this.blockDecorations = Decoration.none;
					this.refreshDecorations();
					this.disposeMonacoBlocks();
					return;
				}

				const blocks = this.parseLivePreviewBlocks(view);
				const ranges: Range<Decoration>[] = [];
				for (const block of blocks) {
					for (let lineNumber = block.codeStartLine; lineNumber <= block.codeEndLine; lineNumber++) {
						const line = view.state.doc.line(lineNumber);
						ranges.push(
							Decoration.line({
								attributes: {
									class: 'shiki-editing-codeblock-line',
									'data-shiki-editing-block-id': block.blockId,
								},
							}).range(line.from),
						);
					}

					const openingFence = view.state.doc.line(block.openingFenceLine);
					ranges.push(
						Decoration.line({
							attributes: {
								class: 'shiki-editing-codeblock-fence',
								'data-shiki-editing-block-id': block.blockId,
							},
						}).range(openingFence.from),
					);

					const closingFence = view.state.doc.line(block.closingFenceLine);
					ranges.push(
						Decoration.line({
							attributes: {
								class: 'shiki-editing-codeblock-fence',
								'data-shiki-editing-block-id': block.blockId,
							},
						}).range(closingFence.from),
					);
				}

				this.livePreviewBlocks = blocks;
				this.blockDecorations = ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
				this.refreshDecorations();
			}

			private parseLivePreviewBlocks(view: EditorView): LivePreviewCodeBlock[] {
				const blocks: LivePreviewCodeBlock[] = [];
				const doc = view.state.doc;
				let current:
					| {
						closingFence: string;
						language: string;
						openingFenceLine: number;
					}
					| undefined;

				for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
					const line = doc.line(lineNumber);
					const match = OPENING_FENCE_RE.exec(line.text);

					if (!current) {
						if (!match) {
							continue;
						}

						const language = match[2]?.trim().toLowerCase() ?? '';
						current = {
							closingFence: match[1][0].repeat(match[1].length),
							language,
							openingFenceLine: lineNumber,
						};
						continue;
					}

					if (line.text.trim().startsWith(current.closingFence)) {
						const codeStartLine = current.openingFenceLine + 1;
						const codeEndLine = lineNumber - 1;
						if (codeStartLine <= codeEndLine && current.language !== '') {
							const codeFrom = doc.line(codeStartLine).from;
							const codeTo = doc.line(codeEndLine).to;
							blocks.push({
								blockId: `${doc.line(current.openingFenceLine).from}`,
								code: doc.sliceString(codeFrom, codeTo),
								codeFrom,
								codeTo,
								codeStartLine,
								codeEndLine,
								language: current.language,
								openingFenceLine: current.openingFenceLine,
								closingFenceLine: lineNumber,
							});
						}

						current = undefined;
					}
				}

				return blocks;
			}

			private scheduleLivePreviewSync(): void {
				requestAnimationFrame(() => {
					void this.syncMonacoBlocks();
				});
			}

			private async syncMonacoBlocks(): Promise<void> {
				if (!this.isLivePreview(this.view.state)) {
					this.disposeMonacoBlocks();
					return;
				}

				const runtime = await this.loadRuntime();
				if (!runtime) {
					return;
				}

				const visibleBlockIds = new Set<string>();
				for (const block of this.livePreviewBlocks) {
					if (block.codeTo < this.view.viewport.from || block.codeFrom > this.view.viewport.to) {
						continue;
					}

					const lineElements = [...this.view.contentDOM.querySelectorAll(`.shiki-editing-codeblock-line[data-shiki-editing-block-id="${block.blockId}"]`)] as HTMLElement[];
					if (lineElements.length === 0) {
						continue;
					}

					visibleBlockIds.add(block.blockId);
					await runtime.registerLanguage(block.language).catch(() => undefined);
					this.syncMonacoBlock(runtime.monaco, block, lineElements);
				}

				for (const [blockId, handle] of this.monacoBlocks) {
					if (!visibleBlockIds.has(blockId)) {
						this.disposeMonacoBlock(handle);
						this.monacoBlocks.delete(blockId);
					}
				}
			}

			private async loadRuntime(): Promise<any | undefined> {
				this.runtimePromise ??= plugin.highlighter.load().catch(error => {
					console.error('[Shiki] Failed to load Monaco runtime for live preview.', error);
					this.runtimePromise = undefined;
					return undefined;
				});
				return this.runtimePromise;
			}

			private syncMonacoBlock(monaco: any, block: LivePreviewCodeBlock, lineElements: HTMLElement[]): void {
				const firstLine = lineElements[0];
				const lastLine = lineElements[lineElements.length - 1];
				const firstRect = firstLine.getBoundingClientRect();
				const lastRect = lastLine.getBoundingClientRect();
				const rootRect = this.view.dom.getBoundingClientRect();
				const blockHeight = Math.max(lastRect.bottom - firstRect.top, firstLine.offsetHeight);
				const computedStyle = getComputedStyle(firstLine);
				const fontSize = Number.parseFloat(computedStyle.fontSize) || this.view.defaultLineHeight;
				const lineHeight = Number.parseFloat(computedStyle.lineHeight) || this.view.defaultLineHeight;
				const theme = getActiveTheme(plugin);

				let handle = this.monacoBlocks.get(block.blockId);
				if (!handle) {
					const container = document.createElement('div');
					container.className = 'shiki-monaco-codeblock';
					container.style.position = 'absolute';
					container.style.inset = 'auto';
					container.style.zIndex = '2';
					this.overlayRoot.appendChild(container);

					const editor = monaco.editor.create(container, {
						value: block.code,
						language: block.language,
						theme,
						readOnly: false,
						domReadOnly: false,
						fontSize,
						fontFamily: computedStyle.fontFamily,
						lineHeight,
						lineNumbers: 'off',
						wordWrap: 'off',
						renderLineHighlight: 'none',
						minimap: { enabled: false },
						scrollbar: {
							horizontal: 'auto',
							vertical: 'hidden',
							handleMouseWheel: true,
							alwaysConsumeMouseWheel: false,
						},
						scrollBeyondLastLine: false,
						overviewRulerLanes: 0,
						hideCursorInOverviewRuler: true,
						contextmenu: true,
						glyphMargin: false,
						lineDecorationsWidth: 0,
						automaticLayout: false,
						roundedSelection: false,
						selectOnLineNumbers: false,
						selectionHighlight: false,
						occurrencesHighlight: 'off',
						links: false,
						colorDecorators: false,
						lightbulb: { enabled: 'off' as any },
						padding: { top: 0, bottom: 0 },
					});
					(container as any)._monacoEditor = editor;
					(globalThis as any).__shikiLastMonacoEditor = editor;

					const focusDisposable = editor.onDidFocusEditorWidget(() => {
						container.classList.add('shiki-monaco-active');
						(globalThis as any).__shikiLastMonacoEditor = editor;
					});
					const blurDisposable = editor.onDidBlurEditorWidget(() => {
						container.classList.remove('shiki-monaco-active');
					});
					const changeDisposable = editor.onDidChangeModelContent(() => {
						if (handle?.suppressModelSync || this.syncingLivePreview) {
							return;
						}
						const current = this.livePreviewBlocks.find(candidate => candidate.blockId === block.blockId);
						if (!current) {
							return;
						}
						const value = editor.getValue();
						if (value === current.code) {
							return;
						}
						this.syncingLivePreview = true;
						try {
							this.view.dispatch({
								changes: {
									from: current.codeFrom,
									to: current.codeTo,
									insert: value,
								},
							});
						} finally {
							this.syncingLivePreview = false;
						}
					});

					handle = {
						blockId: block.blockId,
						codeFrom: block.codeFrom,
						codeTo: block.codeTo,
						container,
						editor,
						focusDisposable,
						blurDisposable,
						changeDisposable,
						language: block.language,
						suppressModelSync: false,
					};
					this.monacoBlocks.set(block.blockId, handle);
				}

				if (handle.container.parentElement !== this.overlayRoot) {
					this.overlayRoot.appendChild(handle.container);
				}

				handle.codeFrom = block.codeFrom;
				handle.codeTo = block.codeTo;
				handle.container.style.left = `${firstRect.left - rootRect.left}px`;
				handle.container.style.top = `${firstRect.top - rootRect.top}px`;
				handle.container.style.height = `${blockHeight}px`;
				handle.container.style.width = `${firstRect.width}px`;
				handle.container.classList.add('shiki-monaco-active');
				(globalThis as any).__shikiLastMonacoEditor = handle.editor;

				if (handle.language !== block.language) {
					monaco.editor.setModelLanguage(handle.editor.getModel(), block.language);
					handle.language = block.language;
				}

				if (handle.editor.getValue() !== block.code && !this.syncingLivePreview) {
					handle.suppressModelSync = true;
					try {
						handle.editor.setValue(block.code);
					} finally {
						handle.suppressModelSync = false;
					}
				}

				handle.editor.updateOptions({
					fontSize,
					fontFamily: computedStyle.fontFamily,
					lineHeight,
				});
				monaco.editor.setTheme(theme);
				handle.editor.layout({ width: Math.max(firstRect.width, 1), height: Math.max(blockHeight, 1) });
			}

			private disposeMonacoBlock(handle: MonacoBlockHandle): void {
				handle.changeDisposable.dispose();
				handle.focusDisposable.dispose();
				handle.blurDisposable.dispose();
				handle.editor.dispose();
				handle.container.remove();
			}

			private disposeMonacoBlocks(): void {
				for (const handle of this.monacoBlocks.values()) {
					this.disposeMonacoBlock(handle);
				}
				this.monacoBlocks.clear();
			}

			removeDecoration(from: number, to: number): void {
				this.inlineDecorations = this.inlineDecorations.update({
					filterFrom: from,
					filterTo: to,
					filter: () => false,
				});
				this.refreshDecorations();
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
				this.inlineDecorations = Decoration.none;
				this.blockDecorations = Decoration.none;
				this.disposeMonacoBlocks();
				this.overlayRoot.remove();
			}
		},
		{
			decorations: v => v.decorations,
		},
	);

	return Prec.highest(cm6Plugin);
}
