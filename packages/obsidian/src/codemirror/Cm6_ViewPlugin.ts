import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type EditorState, Prec, type Range } from '@codemirror/state';
import { type SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { Cm6_Util } from 'packages/obsidian/src/codemirror/Cm6_Util';
import { type ThemedToken } from 'shiki';
import { editorLivePreviewField } from 'obsidian';
import {
	buildEditableCodeBlockDecorations,
	createEditableCodeBlockTouchPan,
	type EditableCodeBlockTouchPan,
	normalizeEditableCodeBlockScrollWidths,
	panEditableCodeBlockScroll,
	parseFenceInfo,
	scrollEditableCodeBlockByDelta,
	shouldUpdateCodeBlockDecorations,
	syncEditableCodeBlockScroll,
	type EditableCodeBlock,
} from 'packages/obsidian/src/codemirror/EditableCodeBlockDecorations';
import { buildCodeBlockEditorDecoration, selectionIsInsideCodeBlockBody } from 'packages/obsidian/src/codemirror/CodeBlockEditorWidget';

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
	editableCodeBlock?: Pick<EditableCodeBlock, 'showLineNumbers' | 'wrap' | 'lineStarts'>;
}

interface RemoveDecoration {
	type: DecorationUpdateType.Remove;
	from: number;
	to: number;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	const views = new Set<{ view: EditorView; updateWidgets(view: EditorView): Promise<void> }>();
	const cm6Plugin = ViewPlugin.fromClass(
		class Cm6ViewPlugin {
			decorations: DecorationSet;
			private renderedCodeBlockTouchPan: {
				source: HTMLElement;
				startX: number;
				startY: number;
				currentX: number;
			} | null = null;
			view: EditorView;
			private readonly scrollBoundLines = new WeakSet<HTMLElement>();
			private editableCodeBlockPointerPan: (EditableCodeBlockTouchPan & { pointerId: number }) | null = null;
			private editableCodeBlockMousePan: EditableCodeBlockTouchPan | null = null;
			private editableCodeBlockTouchPan: (EditableCodeBlockTouchPan & { identifier: number }) | null = null;
			private syncingEditableCodeBlockScroll = false;

			private getEditableCodeBlockScrollLineFromElement(element: Element | null): HTMLElement | null {
				if (!element) {
					return null;
				}

				const line = element.closest<HTMLElement>('.shiki-editing-codeblock-nowrap');
				if (!line) {
					return null;
				}

				return line;
			}

			private findEditableCodeBlockScrollLine(target: EventTarget | Event | null, clientX?: number, clientY?: number): HTMLElement | null {
				if (target instanceof Element) {
					const targetLine = this.getEditableCodeBlockScrollLineFromElement(target);
					if (targetLine) {
						return targetLine;
					}
				}

				if (target instanceof Event) {
					for (const pathTarget of target.composedPath()) {
						if (pathTarget instanceof Element) {
							const pathLine = this.getEditableCodeBlockScrollLineFromElement(pathTarget);
							if (pathLine) {
								return pathLine;
							}
						}
					}
				}

				if (clientX !== undefined && clientY !== undefined) {
					for (const pointElement of document.elementsFromPoint(clientX, clientY)) {
						const pointLine = this.getEditableCodeBlockScrollLineFromElement(pointElement);
						if (pointLine) {
							return pointLine;
						}
					}
				}

				return null;
			}

			private getEditableCodeBlockPointerPan(event: PointerEvent): (EditableCodeBlockTouchPan & { pointerId: number }) | null {
				const target = this.findEditableCodeBlockScrollLine(event, event.clientX, event.clientY);
				if (!target) {
					return null;
				}

				const pan = createEditableCodeBlockTouchPan(this.view.dom, target, event.clientX, event.clientY);
				if (!pan) {
					return null;
				}

				return {
					...pan,
					pointerId: event.pointerId,
				};
			}

			private getEditableCodeBlockMousePan(event: MouseEvent): EditableCodeBlockTouchPan | null {
				if (event.button !== 0) {
					return null;
				}

				const target = this.findEditableCodeBlockScrollLine(event, event.clientX, event.clientY);
				if (!target) {
					return null;
				}

				return createEditableCodeBlockTouchPan(this.view.dom, target, event.clientX, event.clientY);
			}

			private getEditableCodeBlockTouchPan(event: TouchEvent): (EditableCodeBlockTouchPan & { identifier: number }) | null {
				if (event.touches.length !== 1) {
					return null;
				}

				const touch = event.touches[0];
				const target = this.findEditableCodeBlockScrollLine(event, touch.clientX, touch.clientY);
				if (!target) {
					return null;
				}

				const pan = createEditableCodeBlockTouchPan(this.view.dom, target, touch.clientX, touch.clientY);
				if (!pan) {
					return null;
				}

				return {
					...pan,
					identifier: touch.identifier,
				};
			}

			private readonly handleEditableCodeBlockScroll = (event: Event): void => {
				if (this.syncingEditableCodeBlockScroll) {
					return;
				}

				const target = this.findEditableCodeBlockScrollLine(event.target);
				if (!target) {
					return;
				}

				this.syncingEditableCodeBlockScroll = true;
				try {
					syncEditableCodeBlockScroll(this.view.dom, target);
				} finally {
					this.syncingEditableCodeBlockScroll = false;
				}

				requestAnimationFrame(() => {
					this.syncingEditableCodeBlockScroll = true;
					try {
						syncEditableCodeBlockScroll(this.view.dom, target);
					} finally {
						this.syncingEditableCodeBlockScroll = false;
					}
				});
			};

			private readonly handleEditableCodeBlockGlobalPointerDown = (event: PointerEvent): void => {
				if (event.pointerType === 'touch') {
					return;
				}

				this.editableCodeBlockPointerPan = this.getEditableCodeBlockPointerPan(event);
			};

			private readonly handleEditableCodeBlockPointerDown = (event: PointerEvent): void => {
				if (event.pointerType === 'touch') {
					this.editableCodeBlockPointerPan = null;
					return;
				}

				const pan = this.getEditableCodeBlockPointerPan(event);
				if (!pan) {
					this.editableCodeBlockPointerPan = null;
					return;
				}

				this.editableCodeBlockPointerPan = pan;
				if (event.pointerType !== 'mouse') {
					event.stopPropagation();
					event.stopImmediatePropagation();
				}
				try {
					pan.source.setPointerCapture?.(event.pointerId);
				} catch {
					// Some mobile WebViews reject pointer capture for already-cancelled pointers.
				}
			};

			private readonly handleEditableCodeBlockPointerMove = (event: PointerEvent): void => {
				const pan = this.editableCodeBlockPointerPan;
				if (pan?.pointerId !== event.pointerId) {
					return;
				}

				if (!panEditableCodeBlockScroll(this.view.dom, pan, event.clientX, event.clientY)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			};

			private readonly handleEditableCodeBlockMouseDown = (event: MouseEvent): void => {
				this.editableCodeBlockMousePan = this.getEditableCodeBlockMousePan(event);
			};

			private readonly handleEditableCodeBlockMouseMove = (event: MouseEvent): void => {
				const pan = this.editableCodeBlockMousePan;
				if (!pan || (event.buttons & 1) !== 1) {
					return;
				}

				if (!panEditableCodeBlockScroll(this.view.dom, pan, event.clientX, event.clientY)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			};

			private readonly handleEditableCodeBlockMouseEnd = (): void => {
				this.editableCodeBlockMousePan = null;
			};

			private getRenderedCodeBlockTouchPan(event: TouchEvent): {
				source: HTMLElement;
				startX: number;
				startY: number;
				currentX: number;
			} | null {
				const touch = event.touches[0];
				if (!touch) {
					return null;
				}

				const target = event.target instanceof Element ? event.target : null;
				const source = target?.closest<HTMLElement>('div.expressive-code pre');
				if (!source || source.scrollWidth <= source.clientWidth) {
					return null;
				}

				return {
					source,
					startX: touch.clientX,
					startY: touch.clientY,
					currentX: touch.clientX,
				};
			}

			private panRenderedCodeBlockTouch(currentX: number, currentY: number): boolean {
				const pan = this.renderedCodeBlockTouchPan;
				if (!pan) {
					return false;
				}

				const deltaX = pan.currentX - currentX;
				const totalDeltaX = Math.abs(currentX - pan.startX);
				const totalDeltaY = Math.abs(currentY - pan.startY);
				if (totalDeltaX < 4 || totalDeltaX <= totalDeltaY) {
					return false;
				}

				const maxScrollLeft = Math.max(0, pan.source.scrollWidth - pan.source.clientWidth);
				const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, pan.source.scrollLeft + deltaX));
				if (nextScrollLeft === pan.source.scrollLeft) {
					pan.currentX = currentX;
					return false;
				}

				pan.source.scrollLeft = nextScrollLeft;
				pan.currentX = currentX;
				return true;
			}

			private readonly handleEditableCodeBlockTouchStart = (event: TouchEvent): void => {
				this.renderedCodeBlockTouchPan = this.getRenderedCodeBlockTouchPan(event);
				if (this.renderedCodeBlockTouchPan) {
					event.stopPropagation();
					event.stopImmediatePropagation();
					return;
				}

				this.editableCodeBlockTouchPan = this.getEditableCodeBlockTouchPan(event);
				if (!this.editableCodeBlockTouchPan) {
					return;
				}

				event.stopPropagation();
				event.stopImmediatePropagation();
			};

			private readonly handleEditableCodeBlockTouchMove = (event: TouchEvent): void => {
				if (this.renderedCodeBlockTouchPan) {
					const sourceRect = this.renderedCodeBlockTouchPan.source.getBoundingClientRect();
					const touch = [...event.touches].find(touch => touch.clientX >= sourceRect.left && touch.clientX <= sourceRect.right);
					if (!touch) {
						this.renderedCodeBlockTouchPan = null;
						return;
					}

					if (!this.panRenderedCodeBlockTouch(touch.clientX, touch.clientY)) {
						return;
					}

					event.preventDefault();
					event.stopPropagation();
					event.stopImmediatePropagation();
					return;
				}

				const pan = this.editableCodeBlockTouchPan;
				if (!pan) {
					return;
				}

				const touch = [...event.touches].find(touch => touch.identifier === pan.identifier);
				if (!touch) {
					this.editableCodeBlockTouchPan = null;
					this.renderedCodeBlockTouchPan = null;
					return;
				}

				const scrolled = panEditableCodeBlockScroll(this.view.dom, pan, touch.clientX, touch.clientY);
				if (!scrolled) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			};

			private readonly handleEditableCodeBlockTouchEnd = (event: TouchEvent): void => {
				const pan = this.editableCodeBlockTouchPan;
				if (!pan || [...event.touches].some(touch => touch.identifier === pan.identifier)) {
					return;
				}

				syncEditableCodeBlockScroll(this.view.dom, pan.source);
				this.editableCodeBlockTouchPan = null;
				this.renderedCodeBlockTouchPan = null;
			};

			private readonly handleEditableCodeBlockWheel = (event: WheelEvent): void => {
				const deltaX = Math.abs(event.deltaX) >= 1 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
				if (Math.abs(deltaX) < 1 || (!event.shiftKey && Math.abs(deltaX) < Math.abs(event.deltaY))) {
					return;
				}

				const target = this.findEditableCodeBlockScrollLine(event, event.clientX, event.clientY);
				if (!target || !scrollEditableCodeBlockByDelta(this.view.dom, target, deltaX)) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			};

			private readonly handleEditableCodeBlockPointerEnd = (event: PointerEvent): void => {
				const pan = this.editableCodeBlockPointerPan;
				if (pan?.pointerId === event.pointerId) {
					try {
						if (pan.source.hasPointerCapture?.(event.pointerId) === true) {
							pan.source.releasePointerCapture(event.pointerId);
						}
					} catch {
						// Pointer capture may have been implicitly released by the browser.
					}
					this.editableCodeBlockPointerPan = null;
				}
			};

			constructor(view: EditorView) {
				this.view = view;
				this.decorations = Decoration.none;
				window.addEventListener('pointerdown', this.handleEditableCodeBlockGlobalPointerDown, true);
				window.addEventListener('pointermove', this.handleEditableCodeBlockPointerMove, { capture: true, passive: false });
				window.addEventListener('pointerup', this.handleEditableCodeBlockPointerEnd, true);
				window.addEventListener('pointercancel', this.handleEditableCodeBlockPointerEnd, true);
				window.addEventListener('touchstart', this.handleEditableCodeBlockTouchStart, true);
				window.addEventListener('touchmove', this.handleEditableCodeBlockTouchMove, { capture: true, passive: false });
				window.addEventListener('touchend', this.handleEditableCodeBlockTouchEnd, true);
				window.addEventListener('touchcancel', this.handleEditableCodeBlockTouchEnd, true);
				window.addEventListener('wheel', this.handleEditableCodeBlockWheel, { capture: true, passive: false });
				window.addEventListener('scroll', this.handleEditableCodeBlockScroll, true);
				view.dom.addEventListener('scroll', this.handleEditableCodeBlockScroll, true);
				view.dom.addEventListener('pointerdown', this.handleEditableCodeBlockPointerDown);
				view.dom.addEventListener('pointermove', this.handleEditableCodeBlockPointerMove, { capture: true, passive: false });
				view.dom.addEventListener('pointerup', this.handleEditableCodeBlockPointerEnd, true);
				view.dom.addEventListener('pointercancel', this.handleEditableCodeBlockPointerEnd, true);
				view.dom.addEventListener('mousedown', this.handleEditableCodeBlockMouseDown);
				view.dom.addEventListener('mousemove', this.handleEditableCodeBlockMouseMove, { capture: true, passive: false });
				view.dom.addEventListener('mouseup', this.handleEditableCodeBlockMouseEnd, true);
				view.dom.addEventListener('touchstart', this.handleEditableCodeBlockTouchStart, true);
				view.dom.addEventListener('touchmove', this.handleEditableCodeBlockTouchMove, { capture: true, passive: false });
				view.dom.addEventListener('touchend', this.handleEditableCodeBlockTouchEnd, true);
				view.dom.addEventListener('touchcancel', this.handleEditableCodeBlockTouchEnd, true);
				view.dom.addEventListener('wheel', this.handleEditableCodeBlockWheel, { capture: true, passive: false });
				views.add(this);
				void this.updateWidgets(view);

				plugin.updateCm6Plugin = (): Promise<void> => {
					return Promise.all([...views].map(instance => instance.updateWidgets(instance.view))).then(() => undefined);
				};
			}

			/**
			 * Triggered by codemirror when the view updates.
			 * Depending on the update type, the decorations are either updated or recreated.
			 *
			 * @param update
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

				// we handle doc changes and selection changes here
				if (
					shouldUpdateCodeBlockDecorations({
						docChanged: update.docChanged,
						selectionSet: update.selectionSet,
						viewportChanged: update.viewportChanged,
					})
				) {
					this.view = update.view;
					void this.updateWidgets(update.view);
				}
			}

			isLivePreview(state: EditorState): boolean {
				// @ts-ignore some strange private field not being assignable
				return state.field(editorLivePreviewField);
			}

			/**
			 * Updates all the widgets by traversing the syntax tree.
			 *
			 * @param view
			 */
			async updateWidgets(view: EditorView): Promise<void> {
				let lang = '';
				let fenceInfo = parseFenceInfo('');
				let state: SyntaxNode[] = [];
				const decorationUpdates: DecorationUpdate[] = [];
				// Capture the state at the time of the syntax tree traversal so we can
				// detect if the document changed while async decoration building was in flight.
				const capturedState = view.state;

				// const t1 = performance.now();

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
								// we could check if we even have any decorations at this node, but it's not necessary
								this.removeDecoration(node.from, node.to);
							}
							return;
						}

						if (props.has('HyperMD-codeblock') && !props.has('HyperMD-codeblock-begin') && !props.has('HyperMD-codeblock-end')) {
							state.push(node);
							return;
						}

						if (props.has('HyperMD-codeblock-begin')) {
							const content = Cm6_Util.getContent(view.state, node.from, node.to);
							fenceInfo = parseFenceInfo(content);

							lang = fenceInfo.language;
						}

						if (props.has('HyperMD-codeblock-end')) {
							if (state.length > 0 && lang !== '') {
								const start = state[0].from;
								const end = state[state.length - 1].to;

								decorationUpdates.push({
									type: DecorationUpdateType.Insert,
									from: start,
									to: end,
									lang,
									content: Cm6_Util.getContent(view.state, start, end),
									editableCodeBlock: {
										showLineNumbers: plugin.loadedSettings.ecDefaultShowLineNumbers || (fenceInfo?.showLineNumbers ?? false),
										wrap: plugin.loadedSettings.ecDefaultWrap || (fenceInfo?.wrap ?? false),
										lineStarts: state.map(line => line.from),
									},
								});
							}

							if (state.length > 0 && lang === '') {
								const start = state[0].from;
								const end = state[state.length - 1].to;

								decorationUpdates.push({
									type: DecorationUpdateType.Remove,
									from: start,
									to: end,
								});
							}

							lang = '';
							fenceInfo = parseFenceInfo('');
							state = [];
						}
					},
				});

				const activeEditableCodeBlock = this.findActiveEditableCodeBlock(view);
				if (
					activeEditableCodeBlock &&
					!decorationUpdates.some(
						update =>
							update.type === DecorationUpdateType.Insert &&
							update.editableCodeBlock &&
							update.from === activeEditableCodeBlock.from &&
							update.to === activeEditableCodeBlock.to,
					)
				) {
					decorationUpdates.push(activeEditableCodeBlock);
				}

				for (const node of decorationUpdates) {
					try {
						if (node.type === DecorationUpdateType.Remove) {
							this.removeDecoration(node.from, node.to);
						} else if (node.type === DecorationUpdateType.Insert) {
							const decorations = node.editableCodeBlock
								? await this.buildEditableCodeBlockDecorations(view, node.from, node.to, node.lang, node.content, node.editableCodeBlock)
								: await this.buildDecorations(node.hideTo ?? node.from, node.to, node.lang, node.content);
							// If the document changed while we were awaiting, the positions we captured
							// are stale. Selection and viewport changes are safe; they are common while
							// activating editable Live Preview blocks.
							if (this.view.state.doc !== capturedState.doc) {
								return;
							}
							this.removeDecoration(node.from, node.to);
							if (node.hideLang) {
								// add the decoration that hides the language tag
								decorations.unshift(Decoration.replace({}).range(node.from, node.hideTo));
							}
							// add the highlight decorations
							this.addDecoration(node.from, node.to, decorations);
						}
					} catch (e) {
						console.error(e);
					}
				}

				if (decorationUpdates.length > 0 && this.view.state.doc === capturedState.doc) {
					// Use requestAnimationFrame to avoid "Calls to EditorView.update are not allowed while an update is in progress"
					requestAnimationFrame(() => {
						if (this.view.state.doc === capturedState.doc) {
							this.view.dispatch(this.view.state.update({}));
							requestAnimationFrame(() => this.bindEditableCodeBlockScrollLines());
						}
					});
				}

				// console.log('Traversed syntax tree in', performance.now() - t1, 'ms');
			}

			bindEditableCodeBlockScrollLines(): void {
				normalizeEditableCodeBlockScrollWidths(this.view.dom);
				for (const line of this.view.dom.querySelectorAll<HTMLElement>('.shiki-editing-codeblock-line')) {
					if (this.scrollBoundLines.has(line)) {
						continue;
					}

					line.addEventListener('scroll', this.handleEditableCodeBlockScroll);
					line.addEventListener('pointerdown', this.handleEditableCodeBlockPointerDown);
					line.addEventListener('pointermove', this.handleEditableCodeBlockPointerMove);
					line.addEventListener('pointerup', this.handleEditableCodeBlockPointerEnd);
					line.addEventListener('pointercancel', this.handleEditableCodeBlockPointerEnd);
					this.scrollBoundLines.add(line);
				}
			}

			findActiveEditableCodeBlock(view: EditorView): InsertDecoration | null {
				const doc = view.state.doc;
				const cursor = doc.lineAt(view.state.selection.main.head);
				let startLine = cursor.number;
				let startFence: RegExpExecArray | null = null;

				while (startLine > 0) {
					const line = doc.line(startLine);
					const match = /^(\s*)(```|~~~)\s*([^\s`]*)\s*(.*)$/.exec(line.text);
					if (match) {
						startFence = match;
						break;
					}
					startLine--;
				}

				if (!startFence || startLine === cursor.number) {
					return null;
				}

				const fenceMarker = startFence[2];
				let endLine = startLine + 1;
				while (endLine <= doc.lines) {
					const line = doc.line(endLine);
					if (line.text.trimStart().startsWith(fenceMarker)) {
						break;
					}
					endLine++;
				}

				if (endLine > doc.lines || cursor.number >= endLine || endLine <= startLine + 1) {
					return null;
				}

				const openingLine = doc.line(startLine);
				const bodyStart = doc.line(startLine + 1);
				const bodyEnd = doc.line(endLine - 1);
				const fenceInfo = parseFenceInfo(openingLine.text);

				if (fenceInfo.language === '') {
					return null;
				}

				return {
					type: DecorationUpdateType.Insert,
					from: bodyStart.from,
					to: bodyEnd.to,
					lang: fenceInfo.language,
					content: doc.sliceString(bodyStart.from, bodyEnd.to),
					editableCodeBlock: {
						showLineNumbers: plugin.loadedSettings.ecDefaultShowLineNumbers || fenceInfo.showLineNumbers,
						wrap: plugin.loadedSettings.ecDefaultWrap || fenceInfo.wrap,
						lineStarts: Array.from({ length: endLine - startLine - 1 }, (_, index) => doc.line(startLine + 1 + index).from),
					},
				};
			}

			async buildEditableCodeBlockDecorations(
				view: EditorView,
				from: number,
				to: number,
				language: string,
				content: string,
				block: Pick<EditableCodeBlock, 'showLineNumbers' | 'wrap' | 'lineStarts'>,
			): Promise<Range<Decoration>[]> {
				if (language === '') {
					return [];
				}

				const editableCodeBlock: EditableCodeBlock = {
					from,
					to,
					language,
					content,
					showLineNumbers: block.showLineNumbers,
					wrap: block.wrap,
					lineStarts: block.lineStarts,
				};

				if (selectionIsInsideCodeBlockBody(view.state, editableCodeBlock)) {
					return [buildCodeBlockEditorDecoration(plugin, view, editableCodeBlock)];
				}

				const highlight = await plugin.highlighter.getHighlightTokens(content, language.toLowerCase());

				if (!highlight) {
					return [];
				}

				return buildEditableCodeBlockDecorations(editableCodeBlock, highlight);
			}

			/**
			 * Removes all decorations at a given node.
			 *
			 * @param from
			 * @param to
			 */
			removeDecoration(from: number, to: number): void {
				this.decorations = this.decorations.update({
					filterFrom: from,
					filterTo: to,
					filter: (_from3, _to3, _decoration) => {
						return false;
					},
				});
			}

			/**
			 * Adds a widget at a given node if it does not exist yet.
			 *
			 * @param from
			 * @param to
			 * @param newDecorations
			 */
			addDecoration(from: number, to: number, newDecorations: Range<Decoration>[]): void {
				// check if the decoration already exists and only add it if it does not exist
				if (Cm6_Util.existsDecorationBetween(this.decorations, from, to)) {
					return;
				}

				if (newDecorations.length === 0) {
					return;
				}

				this.decorations = this.decorations.update({
					add: newDecorations,
				});
			}

			/**
			 * Builds mark decorations for a given range, laguage and content.
			 *
			 * @param from
			 * @param to
			 * @param language
			 * @param content
			 */
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

			/**
			 * Triggered by codemirror when the view plugin is destroyed.
			 */
			destroy(): void {
				window.removeEventListener('pointerdown', this.handleEditableCodeBlockGlobalPointerDown, true);
				window.removeEventListener('pointermove', this.handleEditableCodeBlockPointerMove, true);
				window.removeEventListener('pointerup', this.handleEditableCodeBlockPointerEnd, true);
				window.removeEventListener('pointercancel', this.handleEditableCodeBlockPointerEnd, true);
				window.removeEventListener('touchstart', this.handleEditableCodeBlockTouchStart, true);
				window.removeEventListener('touchmove', this.handleEditableCodeBlockTouchMove, true);
				window.removeEventListener('touchend', this.handleEditableCodeBlockTouchEnd, true);
				window.removeEventListener('touchcancel', this.handleEditableCodeBlockTouchEnd, true);
				window.removeEventListener('wheel', this.handleEditableCodeBlockWheel, true);
				window.removeEventListener('scroll', this.handleEditableCodeBlockScroll, true);
				this.view.dom.removeEventListener('scroll', this.handleEditableCodeBlockScroll, true);
				this.view.dom.removeEventListener('pointerdown', this.handleEditableCodeBlockPointerDown);
				this.view.dom.removeEventListener('pointermove', this.handleEditableCodeBlockPointerMove, true);
				this.view.dom.removeEventListener('pointerup', this.handleEditableCodeBlockPointerEnd, true);
				this.view.dom.removeEventListener('pointercancel', this.handleEditableCodeBlockPointerEnd, true);
				this.view.dom.removeEventListener('mousedown', this.handleEditableCodeBlockMouseDown);
				this.view.dom.removeEventListener('mousemove', this.handleEditableCodeBlockMouseMove, true);
				this.view.dom.removeEventListener('mouseup', this.handleEditableCodeBlockMouseEnd, true);
				window.removeEventListener('touchstart', this.handleEditableCodeBlockTouchStart, true);
				window.removeEventListener('touchmove', this.handleEditableCodeBlockTouchMove, true);
				window.removeEventListener('touchend', this.handleEditableCodeBlockTouchEnd, true);
				window.removeEventListener('touchcancel', this.handleEditableCodeBlockTouchEnd, true);
				window.removeEventListener('wheel', this.handleEditableCodeBlockWheel, true);
				views.delete(this);
				this.decorations = Decoration.none;
			}
		},
		{
			decorations: v => v.decorations,
		},
	);

	return Prec.highest(cm6Plugin);
}
