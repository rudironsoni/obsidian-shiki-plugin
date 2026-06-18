import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type EditorState, Prec, type Range, StateField } from '@codemirror/state';
import { type SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { Cm6_Util } from 'packages/obsidian/src/codemirror/Cm6_Util';
import { type ThemedToken } from 'shiki';
import { editorLivePreviewField } from 'obsidian';
import {
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
import { buildCodeBlockEditorDecoration } from 'packages/obsidian/src/codemirror/CodeBlockEditorWidget';

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

function buildMonacoDecorations(state: EditorState, plugin: ShikiPlugin): DecorationSet {
	const doc = state.doc;
	const decorations: Range<Decoration>[] = [];

	for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
		const openingLine = doc.line(lineNumber);
		const openingMatch = /^(\s*)(```|~~~)/.exec(openingLine.text);
		if (!openingMatch) continue;
		const fenceInfo = parseFenceInfo(openingLine.text);
		if (!fenceInfo.language) continue;
		const fence = openingMatch[2];
		for (let closingLineNumber = lineNumber + 1; closingLineNumber <= doc.lines; closingLineNumber++) {
			const closingLine = doc.line(closingLineNumber);
			if (!closingLine.text.trimStart().startsWith(fence)) continue;
			const bodyFrom = doc.line(lineNumber + 1).from;
			const bodyTo = Math.max(bodyFrom, closingLine.from - 1);
			const lineStarts: number[] = [];
			for (let bln = lineNumber + 1; bln < closingLineNumber; bln++) {
				lineStarts.push(doc.line(bln).from);
			}
			const block: EditableCodeBlock = {
				from: bodyFrom,
				to: bodyTo,
				language: fenceInfo.language,
				content: doc.sliceString(bodyFrom, bodyTo),
				showLineNumbers: plugin.loadedSettings.ecDefaultShowLineNumbers || fenceInfo.showLineNumbers,
				wrap: plugin.loadedSettings.ecDefaultWrap || fenceInfo.wrap,
				lineStarts,
			};
			decorations.push(
				Decoration.mark({ attributes: { class: 'shiki-hidden-codeblock-fence-text' } }).range(openingLine.from, bodyFrom),
			);
			decorations.push(buildCodeBlockEditorDecoration(plugin, block));
			decorations.push(
				Decoration.mark({ attributes: { class: 'shiki-hidden-codeblock-fence-text' } }).range(
					Math.min(bodyTo + 1, closingLine.to),
					closingLine.to,
				),
			);
			lineNumber = closingLineNumber;
			break;
		}
	}
	return Decoration.set(decorations, true);
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	const monacoCodeBlocksField = StateField.define<DecorationSet>({
		create: (state) => buildMonacoDecorations(state, plugin),
		update(value, transaction) {
			if (!transaction.docChanged && value !== Decoration.none) return value;
			return buildMonacoDecorations(transaction.state, plugin);
		},
		provide: (field) => EditorView.decorations.from(field),
	});

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

				void this.updateWidgets(view);
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

						// Skip HyperMD-codeblock nodes — the state field handles Monaco widgets for these.
						// We only handle inline code highlighting in this ViewPlugin.
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
				this.view.dom.removeEventListener('touchstart', this.handleEditableCodeBlockTouchStart, true);
				this.view.dom.removeEventListener('touchmove', this.handleEditableCodeBlockTouchMove, true);
				this.view.dom.removeEventListener('touchend', this.handleEditableCodeBlockTouchEnd, true);
				this.view.dom.removeEventListener('touchcancel', this.handleEditableCodeBlockTouchEnd, true);
				this.view.dom.removeEventListener('wheel', this.handleEditableCodeBlockWheel, true);
				this.decorations = Decoration.none;
			}
		},
		{
			decorations: v => v.decorations,
		},
	);

	return [Prec.highest(monacoCodeBlocksField), Prec.highest(cm6Plugin)];
}
