import { EditorState, Transaction, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from '@codemirror/view';
import type { EditableCodeBlock } from 'packages/obsidian/src/codemirror/EditableCodeBlockDecorations';

interface CodeBlockEditorWidgetController {
	widget: CodeBlockEditorWidget;
	editor: EditorView;
	updatingFromParent: boolean;
}

const controllers = new WeakMap<HTMLElement, CodeBlockEditorWidgetController>();

export function selectionIsInsideCodeBlockBody(state: EditorState, block: EditableCodeBlock): boolean {
	const selection = state.selection.main;
	return selection.from >= block.from && selection.to <= block.to;
}

export function buildCodeBlockEditorDecoration(parentView: EditorView, block: EditableCodeBlock): Range<Decoration> {
	return Decoration.replace({
		block: true,
		widget: new CodeBlockEditorWidget(parentView, block),
	}).range(block.from, block.to);
}

class CodeBlockEditorWidget extends WidgetType {
	constructor(
		private readonly parentView: EditorView,
		readonly block: EditableCodeBlock,
	) {
		super();
	}

	eq(other: CodeBlockEditorWidget): boolean {
		return (
			this.block.from === other.block.from &&
			this.block.to === other.block.to &&
			this.block.language === other.block.language &&
			this.block.showLineNumbers === other.block.showLineNumbers &&
			this.block.wrap === other.block.wrap
		);
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'shiki-code-editor-island';
		container.dataset.language = this.block.language;

		const extensions: Extension[] = [
			EditorView.domEventHandlers({
				keydown: (event, childView) => this.handleBoundaryKeydown(event, childView),
			}),
			EditorView.updateListener.of(update => {
				if (!update.docChanged) return;

				const controller = controllers.get(container);
				if (!controller || controller.updatingFromParent) return;

				const widget = controller.widget;
				widget.parentView.dispatch({
					changes: {
						from: widget.block.from,
						to: widget.block.to,
						insert: update.state.doc.toString(),
					},
					annotations: Transaction.userEvent.of('input'),
				});
			}),
			keymap.of([
				{
					key: 'Escape',
					run: (): boolean => {
						this.parentView.focus();
						this.parentView.dispatch({
							selection: { anchor: this.block.to },
							scrollIntoView: true,
						});
						return true;
					},
				},
			]),
			EditorView.theme({
				'&': {
					backgroundColor: 'var(--shiki-code-background)',
					color: 'var(--shiki-code-normal)',
					fontFamily: 'var(--font-monospace)',
					fontSize: 'var(--code-size)',
				},
				'.cm-scroller': {
					overflow: 'auto',
				},
				'.cm-content': {
					padding: '0.65em 0.85em',
				},
				'.cm-line': {
					padding: '0',
				},
			}),
		];

		if (this.block.wrap) {
			extensions.push(EditorView.lineWrapping);
		}

		if (this.block.showLineNumbers) {
			extensions.push(lineNumbers());
		}

		const editor = new EditorView({
			state: EditorState.create({
				doc: this.block.content,
				extensions,
			}),
			parent: container,
		});

		controllers.set(container, {
			widget: this,
			editor,
			updatingFromParent: false,
		});

		if (this.parentView.hasFocus && selectionIsInsideCodeBlockBody(this.parentView.state, this.block)) {
			window.requestAnimationFrame(() => {
				const controller = controllers.get(container);
				if (!controller) return;

				controller.widget.focusChildFromParentSelection(controller.editor);
			});
		}

		return container;
	}

	updateDOM(dom: HTMLElement): boolean {
		const controller = controllers.get(dom);
		if (!controller) return false;

		controller.widget = this;
		const currentContent = controller.editor.state.doc.toString();
		if (currentContent !== this.block.content) {
			controller.updatingFromParent = true;
			controller.editor.dispatch({
				changes: {
					from: 0,
					to: controller.editor.state.doc.length,
					insert: this.block.content,
				},
			});
			controller.updatingFromParent = false;
		}

		return true;
	}

	ignoreEvent(): boolean {
		return true;
	}

	destroy(dom: HTMLElement): void {
		controllers.get(dom)?.editor.destroy();
		controllers.delete(dom);
	}

	private handleBoundaryKeydown(event: KeyboardEvent, childView: EditorView): boolean {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
			return false;
		}

		const selection = childView.state.selection.main;
		if (!selection.empty) {
			return false;
		}

		const line = childView.state.doc.lineAt(selection.head);
		if (event.key === 'ArrowUp' && line.number === 1) {
			this.parentView.focus();
			this.parentView.dispatch({
				selection: { anchor: this.block.from },
				scrollIntoView: true,
			});
			return true;
		}

		if (event.key === 'ArrowDown' && line.number === childView.state.doc.lines) {
			this.parentView.focus();
			this.parentView.dispatch({
				selection: { anchor: this.block.to },
				scrollIntoView: true,
			});
			return true;
		}

		return false;
	}

	private focusChildFromParentSelection(childView: EditorView): void {
		const parentSelection = this.parentView.state.selection.main;
		const offset = Math.max(0, Math.min(childView.state.doc.length, parentSelection.head - this.block.from));
		childView.dispatch({
			selection: { anchor: offset },
			scrollIntoView: true,
		});
		childView.focus();
	}
}
