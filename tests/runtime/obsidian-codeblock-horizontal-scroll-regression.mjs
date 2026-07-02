#!/usr/bin/env node

const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT ?? 9230);
const NOTE_PATH = 'narrow-scroll-regression.md';

function assert(condition, message, details = undefined) {
	if (!condition) {
		const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
		throw new Error(`${message}${suffix}`);
	}
}

function isOpaqueColor(value) {
	return typeof value === 'string' && !/^rgba\([^)]*,\s*(?:0|0?\.\d+)\s*\)$/i.test(value);
}

async function delay(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToExistingObsidian() {
	const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(response => response.json());
	const page = targets.find(target => target.type === 'page' && /app:\/\/obsidian\.md\/index\.html/i.test(target.url ?? ''));
	assert(page?.webSocketDebuggerUrl, `No Obsidian page target is listening on CDP port ${PORT}`);

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();
	ws.onmessage = event => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	return {
		send(method, params = {}) {
			const messageId = ++id;
			ws.send(JSON.stringify({ id: messageId, method, params }));
			return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
		},
		close() {
			ws.close();
		},
	};
}

async function evaluate(client, expression, label = 'evaluation') {
	const result = await Promise.race([
		client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 20000)),
	]);
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails));
	}
	return result.result.value;
}

async function waitFor(client, expression, label, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await evaluate(client, expression, label);
		if (lastValue) return lastValue;
		await delay(150);
	}
	throw new Error(`${label} timed out\nLast value:\n${JSON.stringify(lastValue, null, 2)}`);
}

async function requestMode(client, mode, source = false) {
	await evaluate(
		client,
		`(() => {
			const leaf = ${JSON.stringify(mode)} === 'preview' ? window.app.workspace.getLeaf('tab') : (window.app.workspace.activeLeaf ?? window.app.workspace.getLeaf(false));
			const file = window.app.workspace.getActiveFile() ?? window.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			if (${JSON.stringify(mode)} === 'preview') {
				setTimeout(() => void Promise.resolve(leaf.openFile(file, { active: true, state: { mode: 'preview' } })).catch(() => undefined), 0);
			}
			void Promise.resolve(leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: ${JSON.stringify(mode)}, source: ${JSON.stringify(source)} }, active: true }, { history: false })).catch(() => undefined);
			window.app.workspace.setActiveLeaf?.(leaf, { focus: true });
			return true;
		})()`,
		`request ${mode}`,
	);
	const selector = mode === 'preview'
		? '.markdown-preview-view'
		: source
			? '.markdown-source-view.mod-cm6:not(.is-live-preview)'
			: '.markdown-source-view.mod-cm6.is-live-preview';
	await waitFor(
		client,
		`window.app.workspace.getActiveFile()?.path === ${JSON.stringify(NOTE_PATH)} && Boolean(window.app.workspace.activeLeaf?.view?.containerEl?.querySelector(${JSON.stringify(selector)}))`,
		`wait for ${mode}`,
	);
	await delay(500);
}

async function ensureObsidianVisible(client) {
	await evaluate(
		client,
		`(() => {
			const win = globalThis.electronWindow;
			win?.show?.();
			win?.restore?.();
			win?.setBounds?.({ x: 100, y: 100, width: 1200, height: 900 });
			win?.focus?.();
			return true;
		})()`,
		'ensure Obsidian visible',
	);
	await waitFor(client, `document.visibilityState === 'visible'`, 'wait for visible Obsidian window', 10000);
}

async function setupFixture(client) {
	const longA = `const insanelyLongValueName = "${'0123456789abcdefghijklmnopqrstuvwxyz'.repeat(10)}";`;
	const longB = `const secondLongValueName = "${'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210'.repeat(8)}";`;
	const content = ['# Narrow scroll regression', '', '```ts', longA, longB, '```', '', 'after'].join('\n');
	await evaluate(
		client,
		`(async () => {
			let file = window.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			if (!file) file = await window.app.vault.create(${JSON.stringify(NOTE_PATH)}, ${JSON.stringify(content)});
			else await window.app.vault.modify(file, ${JSON.stringify(content)});
			void Promise.resolve(window.app.workspace.getLeaf(false).openFile(file)).catch(() => undefined);
			window.app.workspace.leftSplit?.collapse?.();
			window.app.workspace.rightSplit?.collapse?.();
			let style = document.getElementById('shiki-narrow-scroll-regression-style');
			if (!style) {
				style = document.createElement('style');
				style.id = 'shiki-narrow-scroll-regression-style';
				document.head.appendChild(style);
			}
			style.textContent = '.workspace-leaf.mod-active .view-content { max-width: 390px !important; width: 390px !important; } .workspace-leaf.mod-active .markdown-source-view, .workspace-leaf.mod-active .markdown-reading-view { max-width: 390px !important; }';
			const plugin = window.app.plugins.plugins['advanced-code-block'];
			if (plugin) {
				plugin.settings.wrapLines = false;
				plugin.settings.showLineNumbers = true;
				plugin.loadedSettings = structuredClone(plugin.settings);
				await plugin.saveData(plugin.settings);
			}
			plugin?.registerInlineCodeProcessor?.();
			plugin?.registerCodeBlockProcessors?.();
			plugin?.registerCm6Plugin?.();
			return true;
		})()`,
		'setup fixture',
	);
	await delay(1000);
}

async function verifyLivePreviewViewing(client) {
	await requestMode(client, 'source', false);
	const state = await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.cm-scroller');
			if (scroller) scroller.scrollLeft = 0;
			const block = root.querySelector('.shiki-live-preview-block');
			const body = block?.querySelector('.shiki-block-body');
			const codeScroll = block?.querySelector('.shiki-code-scroll');
			const code = block?.querySelector('code');
			const tokenColor = token => {
				const span = [...(block?.querySelectorAll('.shiki-code-line [style*="color:"]') ?? [])].find(el => el.textContent === token);
				return span ? getComputedStyle(span).color : null;
			};
			const lineNumbers = block?.querySelector('.shiki-line-numbers');
			const noteLineNumbers = block?.querySelector('.shiki-note-line-numbers');
			const visibleGutters = [...root.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(el => getComputedStyle(el).visibility !== 'hidden');
			const lineNumberStyle = lineNumbers ? getComputedStyle(lineNumbers) : null;
			const noteLineNumberStyle = noteLineNumbers ? getComputedStyle(noteLineNumbers) : null;
			if (body) body.scrollLeft = 0;
			await new Promise(resolve => setTimeout(resolve, 50));
			const beforeLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const beforeCodeLeft = code?.getBoundingClientRect().left ?? null;
			if (body) body.scrollLeft = 260;
			await new Promise(resolve => setTimeout(resolve, 50));
			const afterLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const afterCodeLeft = code?.getBoundingClientRect().left ?? null;
			return {
				hasBlock: !!block,
				hasBody: !!body,
				hasCodeScroll: !!codeScroll,
				visibleCodeLineCount: root.querySelectorAll('.cm-line.shiki-live-preview-code-line').length,
				visibleGutterCount: visibleGutters.length,
				bodyClient: body?.clientWidth ?? 0,
				bodyScrollWidth: body?.scrollWidth ?? 0,
				bodyScrollLeft: body?.scrollLeft ?? 0,
				codeScrollLeft: codeScroll?.scrollLeft ?? 0,
				lineNumberCount: lineNumbers?.querySelectorAll('span').length ?? 0,
				lineNumberValues: [...(lineNumbers?.querySelectorAll('span') ?? [])].map(el => el.textContent),
				noteLineNumberCount: noteLineNumbers?.querySelectorAll('span').length ?? 0,
				noteLineNumberValues: [...(noteLineNumbers?.querySelectorAll('span') ?? [])].map(el => el.textContent),
				noteLineNumberDisplay: noteLineNumberStyle?.display ?? null,
				lineNumberBackground: lineNumberStyle?.backgroundColor ?? null,
				lineMoved: beforeLineLeft !== null && afterLineLeft !== null ? beforeLineLeft - afterLineLeft : 0,
				codeMoved: beforeCodeLeft !== null && afterCodeLeft !== null ? beforeCodeLeft - afterCodeLeft : 0,
				anyLineOwnScroll: [...root.querySelectorAll('.cm-line')].some(el => el.scrollLeft > 0),
				noteScrollLeft: scroller?.scrollLeft ?? 0,
				constColor: tokenColor('const'),
				identifierColor: tokenColor('insanelyLongValueName'),
			};
		})()`,
		'live preview viewing',
	);
	assert(state.hasBlock, 'Live Preview viewing did not render a Shiki block', state);
	assert(state.hasBody, 'Live Preview viewing did not render a Shiki block body', state);
	assert(state.hasCodeScroll, 'Live Preview viewing did not render a Shiki code scroll region', state);
	assert(state.visibleCodeLineCount === 0, 'Live Preview viewing left native code rows visible instead of using a whole-block scroll surface', state);
	assert(state.visibleGutterCount > 0, 'Live Preview viewing hid note gutter line numbers', state);
	assert(state.bodyScrollWidth > state.bodyClient, 'Live Preview viewing block body is not horizontally scrollable', state);
	assert(state.bodyScrollLeft > 0, 'Live Preview viewing block body did not scroll horizontally', state);
	assert(state.codeScrollLeft === 0, 'Live Preview viewing scrolled an inner per-line/code scroll container', state);
	assert(state.lineNumberCount === 2, 'Live Preview viewing internal line numbers include fence lines or omit code lines', state);
	assert(JSON.stringify(state.lineNumberValues) === JSON.stringify(['1', '2']), 'Live Preview viewing internal line numbers do not count only code content lines', state);
	assert(state.noteLineNumberCount === 4, 'Live Preview viewing did not render note line numbers for the full fenced range', state);
	assert(JSON.stringify(state.noteLineNumberValues) === JSON.stringify(['3', '4', '5', '6']), 'Live Preview viewing note line numbers do not match the fenced document range', state);
	assert(state.noteLineNumberDisplay === 'flex', 'Live Preview viewing note line number rail is not visible', state);
	assert(Math.abs(state.lineMoved) < 1, 'Live Preview viewing moved line numbers horizontally', state);
	assert(isOpaqueColor(state.lineNumberBackground), 'Live Preview viewing line number gutter is transparent', state);
	assert(state.codeMoved > 0, 'Live Preview viewing did not move code content horizontally', state);
	assert(!state.anyLineOwnScroll, 'Live Preview viewing left horizontal scroll on individual lines', state);
	assert(state.noteScrollLeft === 0, 'Live Preview viewing moved the note horizontally', state);
	return state;
}

async function verifyLivePreviewEditing(client) {
	await requestMode(client, 'source', false);
	const state = await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			void Promise.resolve(window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.()).catch(() => undefined);
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.cm-scroller');
			if (scroller) scroller.scrollLeft = 0;
			const block = root.querySelector('.shiki-live-preview-block');
			const body = block?.querySelector('.shiki-block-body');
			if (body) body.scrollLeft = 260;
			await new Promise(resolve => setTimeout(resolve, 50));
			const beforeTop = block?.getBoundingClientRect().top ?? null;
			const beforeHeight = block?.getBoundingClientRect().height ?? null;
			const codeLine = [...(block?.querySelectorAll('.shiki-code-line') ?? [])].find(el => el.textContent?.includes('insanelyLongValueName'));
			const rect = codeLine?.getBoundingClientRect();
			if (codeLine && rect) {
				codeLine.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: rect.left + 80, clientY: rect.top + rect.height / 2 }));
			}
			await new Promise(resolve => setTimeout(resolve, 500));
			const editor = block?.querySelector('.shiki-live-preview-editor');
			const samples = [];
			const firstBlock = root.querySelector('.shiki-live-preview-block');
			const firstEditor = firstBlock?.querySelector('.shiki-live-preview-editor');
			let sampling = true;
			const sampler = new Promise(resolve => {
				const tick = () => {
					const currentBlock = root.querySelector('.shiki-live-preview-block');
					const currentEditor = currentBlock?.querySelector('.shiki-live-preview-editor');
					samples.push({
						sameBlock: currentBlock === firstBlock,
						sameEditor: currentEditor === firstEditor,
						activeEditor: currentEditor === document.activeElement,
						bodyScrollLeft: currentBlock?.querySelector('.shiki-block-body')?.scrollLeft ?? null,
						nativeLineCount: root.querySelectorAll('.cm-line.shiki-live-preview-code-line').length,
					});
					if (sampling) setTimeout(tick, 16);
					else resolve();
				};
				setTimeout(tick, 16);
			});
			if (editor) {
				editor.setRangeText('__EDIT__', editor.selectionStart, editor.selectionEnd, 'end');
				editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '__EDIT__' }));
			}
			await new Promise(resolve => setTimeout(resolve, 750));
			sampling = false;
			await sampler;
			const updatedBlock = root.querySelector('.shiki-live-preview-block');
			const updatedBody = updatedBlock?.querySelector('.shiki-block-body');
			const updatedEditor = updatedBlock?.querySelector('.shiki-live-preview-editor');
			const updatedPre = updatedBlock?.querySelector('pre');
			const editorStyle = updatedEditor ? getComputedStyle(updatedEditor) : null;
			const preStyle = updatedPre ? getComputedStyle(updatedPre) : null;
			const cursor = leaf.view.editor.getCursor();
			const nativeLines = [...root.querySelectorAll('.cm-line.shiki-live-preview-code-line')].filter(el => el.textContent?.includes('LongValueName'));
			const tokenCount = updatedBlock?.querySelectorAll('.shiki-code-line [style*="color:"]').length ?? 0;
			const content = leaf.view.editor.getValue();
			if (updatedBody && updatedEditor) {
				updatedBody.scrollLeft = 0;
				const editorRect = updatedEditor.getBoundingClientRect();
				const pointerInit = { bubbles: true, cancelable: true, pointerId: 42, pointerType: 'touch', clientX: editorRect.left + 180, clientY: editorRect.top + 12 };
				updatedEditor.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
				updatedEditor.dispatchEvent(new PointerEvent('pointermove', { ...pointerInit, clientX: editorRect.left + 40, clientY: editorRect.top + 14 }));
				updatedEditor.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, clientX: editorRect.left + 40, clientY: editorRect.top + 14 }));
			}
			await new Promise(resolve => setTimeout(resolve, 250));
			return {
				label: 'live-preview-editing',
				hadBlock: !!block,
				activeEditor: updatedEditor === document.activeElement,
				editorValueIncludesEdit: updatedEditor?.value.includes('__EDIT__') ?? false,
				contentIncludesEdit: content.includes('__EDIT__'),
				cursor,
				editorWrap: updatedEditor?.getAttribute('wrap') ?? null,
				nativeLineCount: nativeLines.length,
				scrollerScrollLeft: scroller?.scrollLeft ?? 0,
				bodyScrollLeft: updatedBody?.scrollLeft ?? 0,
				pointerPanScrollLeft: updatedBody?.scrollLeft ?? 0,
				editorFont: editorStyle?.font ?? null,
				preFont: preStyle?.font ?? null,
				editorBorderLeftWidth: editorStyle ? Number.parseFloat(editorStyle.borderLeftWidth) || 0 : null,
				editorBorderRadius: editorStyle ? Number.parseFloat(editorStyle.borderTopLeftRadius) || 0 : null,
				editorBoxShadow: editorStyle?.boxShadow ?? null,
				tokenCount,
				virtualScrollRows: root.querySelectorAll('.shiki-editing-codeblock-active-line-nowrap, .shiki-live-preview-code-line-nowrap[style*="--shiki-editing-scroll-left"]').length,
				anyLineOwnScroll: nativeLines.some(el => el.scrollLeft > 0),
				documentScrollLeft: document.scrollingElement?.scrollLeft ?? 0,
				topDelta: beforeTop !== null && updatedBlock ? Math.abs(updatedBlock.getBoundingClientRect().top - beforeTop) : null,
				heightDelta: beforeHeight !== null && updatedBlock ? Math.abs(updatedBlock.getBoundingClientRect().height - beforeHeight) : null,
				unstableSampleCount: samples.filter(sample => !sample.sameBlock || !sample.sameEditor || !sample.activeEditor || sample.nativeLineCount !== 0 || Math.abs((sample.bodyScrollLeft ?? 0) - 260) > 1).length,
				sampleCount: samples.length,
			};
		})()`,
		'live preview editing',
	);
	assert(state.hadBlock, 'Live Preview editing did not start from a whole-block rendered surface', state);
	assert(state.activeEditor, 'Live Preview editing did not keep focus in the block-level editor', state);
	assert(state.editorValueIncludesEdit, 'Live Preview editing did not update the block-level editor value', state);
	assert(state.contentIncludesEdit, 'Live Preview editing did not write through to the Obsidian document', state);
	assert(state.cursor.line === 3, 'Live Preview editing click did not place the cursor on the first code content line', state);
	assert(state.editorWrap === 'off', 'Live Preview editing overlay allows textarea wrapping and can displace the cursor', state);
	assert(state.nativeLineCount === 0, 'Live Preview editing revealed native code rows instead of keeping the whole-block surface', state);
	assert(state.scrollerScrollLeft === 0, 'Live Preview editing moved the whole editor horizontally', state);
	assert(state.bodyScrollLeft > 0, 'Live Preview editing did not preserve whole-block horizontal scroll', state);
	assert(state.pointerPanScrollLeft > 0, 'Live Preview editing touch pan did not move the whole-block scroller', state);
	assert(state.editorFont === state.preFont, 'Live Preview editing overlay font does not match rendered Shiki code font', state);
	assert(state.editorBorderLeftWidth === 0, 'Live Preview editing overlay leaked a native textarea border', state);
	assert(state.editorBorderRadius === 0, 'Live Preview editing overlay leaked native mobile rounded corners', state);
	assert(state.editorBoxShadow === 'none', 'Live Preview editing overlay leaked native textarea shadow', state);
	assert(state.tokenCount > 0, 'Live Preview editing block is not Shiki-tokenized', state);
	assert(state.virtualScrollRows === 0, 'Live Preview editing still uses virtual per-line horizontal scrolling', state);
	assert(!state.anyLineOwnScroll, 'Live Preview editing left horizontal scroll on individual lines', state);
	assert(state.documentScrollLeft === 0, 'Live Preview editing moved the document horizontally', state);
	assert(state.topDelta !== null && state.topDelta < 2, 'Live Preview editing moved the block vertically during input', state);
	assert(state.heightDelta !== null && state.heightDelta < 2, 'Live Preview editing changed the block height during input', state);
	assert(state.sampleCount > 0, 'Live Preview editing stability sampler did not run', state);
	assert(state.unstableSampleCount === 0, 'Live Preview editing recreated the block editor, lost focus, reset scroll, or revealed native rows during input', state);
	return state;
}

async function verifySourceMode(client) {
	await requestMode(client, 'source', true);
	const state = await evaluate(client, blockScrollExpression('source', true), 'source mode');
	assertBlockScrollerState(state, 'Source mode');
	return state;
}

async function verifyReadingMode(client) {
	await requestMode(client, 'preview', false);
	await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			await Promise.race([
				Promise.resolve(leaf.openFile(file, { active: true, state: { mode: 'preview' } })),
				new Promise(resolve => setTimeout(resolve, 4000)),
			]);
			return true;
		})()`,
		'reading mode open file',
	);
	const state = await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.markdown-preview-view');
			const previewTextLength = scroller?.textContent?.trim().length ?? 0;
			const nativePreCount = root.querySelectorAll('.markdown-preview-view pre').length;
			if (scroller) scroller.scrollLeft = 0;
			const blocks = [...root.querySelectorAll('.shiki-reading-block')];
			const block = blocks[0];
			const directHeaders = block ? [...block.children].filter(el => el.matches('.shiki-block-header')) : [];
			const directBodies = block ? [...block.children].filter(el => el.matches('.shiki-block-body')) : [];
			const body = directBodies[0];
			const codeScroll = body?.querySelector('.shiki-code-scroll');
			const lineNumbers = body?.querySelector('.shiki-line-numbers');
			const tokenColor = token => {
				const span = [...(body?.querySelectorAll('[style*="color:"]') ?? [])].find(el => el.textContent === token);
				return span ? getComputedStyle(span).color : null;
			};
			const pre = body?.querySelector('pre');
			const code = body?.querySelector('code');
			const preStyle = pre ? getComputedStyle(pre) : null;
			const lineNumberStyle = lineNumbers ? getComputedStyle(lineNumbers) : null;
			const codeScrollStyle = codeScroll ? getComputedStyle(codeScroll) : null;
			const visibleNativeCopyButtons = body
				? [...body.querySelectorAll('.copy-code-button')].filter(button => getComputedStyle(button).display !== 'none')
				: [];
			const beforeLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const beforeCodeLeft = code?.getBoundingClientRect().left ?? null;
			if (body) body.scrollLeft = 260;
			const afterLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const afterCodeLeft = code?.getBoundingClientRect().left ?? null;
			return {
				skipped: blocks.length === 0 && previewTextLength === 0 && nativePreCount === 0,
				previewTextLength,
				nativePreCount,
				blockCount: blocks.length,
				directHeaderCount: directHeaders.length,
				directBodyCount: directBodies.length,
				bodyClient: body?.clientWidth ?? 0,
				bodyScrollWidth: body?.scrollWidth ?? 0,
				bodyScrollLeft: body?.scrollLeft ?? 0,
				codeScrollLeft: codeScroll?.scrollLeft ?? 0,
				prePaddingLeft: preStyle ? Number.parseFloat(preStyle.paddingLeft) || 0 : null,
				prePaddingTop: preStyle ? Number.parseFloat(preStyle.paddingTop) || 0 : null,
				preBorderLeft: preStyle ? Number.parseFloat(preStyle.borderLeftWidth) || 0 : null,
				preBorderTop: preStyle ? Number.parseFloat(preStyle.borderTopWidth) || 0 : null,
				visibleNativeCopyButtonCount: visibleNativeCopyButtons.length,
				lineNumberBackground: lineNumberStyle?.backgroundColor ?? null,
				lineNumberBoxShadow: lineNumberStyle?.boxShadow ?? null,
				codeScrollPaddingLeft: codeScrollStyle ? Number.parseFloat(codeScrollStyle.paddingLeft) || 0 : null,
				lineMoved: beforeLineLeft !== null && afterLineLeft !== null ? beforeLineLeft - afterLineLeft : 0,
				codeMoved: beforeCodeLeft !== null && afterCodeLeft !== null ? beforeCodeLeft - afterCodeLeft : 0,
				noteScrollLeft: scroller?.scrollLeft ?? 0,
				constColor: tokenColor('const'),
				identifierColor: tokenColor('insanelyLongValueName'),
			};
		})()`,
		'reading mode',
	);
	assert(state.blockCount === 1, 'Reading mode did not render exactly one Shiki block', state);
	assert(state.directHeaderCount === 1, 'Reading mode rendered duplicate or missing direct block headers', state);
	assert(state.directBodyCount === 1, 'Reading mode rendered duplicate or missing direct block bodies', state);
	assert(state.bodyScrollWidth > state.bodyClient, 'Reading mode block body is not horizontally scrollable', state);
	assert(state.bodyScrollLeft > 0, 'Reading mode block body did not scroll', state);
	assert(state.prePaddingLeft === 0 && state.prePaddingTop === 0, 'Reading mode kept native pre padding inside the Shiki block', state);
	assert(state.preBorderLeft === 0 && state.preBorderTop === 0, 'Reading mode kept native pre border inside the Shiki block', state);
	assert(state.visibleNativeCopyButtonCount === 0, 'Reading mode kept Obsidian native copy button inside the Shiki block body', state);
	assert(Math.abs(state.lineMoved) < 1, 'Reading mode moved line numbers horizontally', state);
	assert(isOpaqueColor(state.lineNumberBackground), 'Reading mode line number gutter is transparent', state);
	assert(state.lineNumberBoxShadow === 'none', 'Reading mode line number gutter uses an overflow shadow strip', state);
	assert(state.codeScrollPaddingLeft > 0, 'Reading mode code column has no gutter spacer padding', state);
	assert(state.codeMoved > 0, 'Reading mode did not move code content horizontally', state);
	assert(state.codeScrollLeft === 0, 'Reading mode scrolled the inner code column instead of the block body', state);
	assert(state.noteScrollLeft === 0, 'Reading mode moved the note horizontally', state);
	return state;
}

function blockScrollExpression(label, source) {
	return `(async () => {
		const leaf = window.app.workspace.activeLeaf;
		const editor = leaf.view.editor;
		const line = editor.getValue().split('\\n').findIndex(value => value.includes('insanelyLongValueName'));
		editor.setCursor({ line, ch: 20 });
		editor.focus();
		await new Promise(resolve => setTimeout(resolve, 1000));
		const root = leaf.view.containerEl;
		const scroller = root.querySelector('.cm-scroller');
		const content = root.querySelector('.cm-content');
		if (scroller) scroller.scrollLeft = 0;
		const lines = [...root.querySelectorAll(${source ? "'.cm-content .cm-line'" : "'.shiki-editing-codeblock-active-line-nowrap'"})].filter(el => el.textContent?.includes('LongValueName'));
		const codeLines = ${source ? "[...root.querySelectorAll('.cm-content .cm-line.HyperMD-codeblock, .cm-content .cm-line.HyperMD-codeblock-bg')]" : '[]'};
		const tokenColor = token => {
			const span = [...root.querySelectorAll('.cm-content .cm-line.HyperMD-codeblock [style*="color:"]')].find(el => el.textContent === token);
			return span ? getComputedStyle(span).color : null;
		};
		const before = lines.map(el => el.getBoundingClientRect().left);
		if (scroller) scroller.scrollLeft = 300;
		const after = lines.map(el => el.getBoundingClientRect().left);
		return {
			label: ${JSON.stringify(label)},
			lineCount: lines.length,
			scrollerClient: scroller?.clientWidth ?? 0,
			scrollerScrollWidth: scroller?.scrollWidth ?? 0,
			scrollerScrollLeft: scroller?.scrollLeft ?? 0,
			contentWidth: content?.getBoundingClientRect().width ?? 0,
			codeLineWidths: codeLines.map(el => el.getBoundingClientRect().width),
			lineMoved: before.map((left, index) => left - after[index]),
			anyLineOwnScroll: lines.some(el => el.scrollLeft > 0),
			bodyScrollLeft: document.scrollingElement?.scrollLeft ?? 0,
			constColor: tokenColor('const'),
			identifierColor: tokenColor('insanelyLongValueName'),
		};
	})()`;
}

function assertColorParity(livePreview, sourceMode, readingMode) {
	assert(livePreview.constColor && sourceMode.constColor && readingMode.constColor, 'Missing const token color in one or more modes', { livePreview, sourceMode, readingMode });
	assert(livePreview.identifierColor && sourceMode.identifierColor && readingMode.identifierColor, 'Missing identifier token color in one or more modes', {
		livePreview,
		sourceMode,
		readingMode,
	});
	assert(
		livePreview.constColor === sourceMode.constColor && sourceMode.constColor === readingMode.constColor,
		'const token color differs across Live Preview, Source, and Reading modes',
		{ livePreview, sourceMode, readingMode },
	);
	assert(
		livePreview.identifierColor === sourceMode.identifierColor && sourceMode.identifierColor === readingMode.identifierColor,
		'identifier token color differs across Live Preview, Source, and Reading modes',
		{ livePreview, sourceMode, readingMode },
	);
}

function assertBlockScrollerState(state, label) {
	assert(state.lineCount >= 2, `${label} did not find both long code lines`, state);
	assert(state.scrollerScrollWidth > state.scrollerClient, `${label} editor scroller is not horizontally scrollable`, state);
	assert(state.scrollerScrollLeft > 0, `${label} editor scroller did not scroll`, state);
	assert(
		state.lineMoved.every(value => Math.abs(value - 300) < 2),
		`${label} did not move every code line with the editor scroller`,
		state,
	);
	assert(!state.anyLineOwnScroll, `${label} left horizontal scroll on individual lines`, state);
	if (label === 'Source mode') {
		assert(state.codeLineWidths.length > 0, `${label} did not find source code block lines`, state);
		assert(
			state.codeLineWidths.every(width => Math.abs(width - state.contentWidth) < 2),
			`${label} left variable-width code line backgrounds`,
			state,
		);
	}
	assert(state.bodyScrollLeft === 0, `${label} moved the document horizontally`, state);
}

async function main() {
	const client = await connectToExistingObsidian();
	try {
		await client.send('Runtime.enable');
		await ensureObsidianVisible(client);
		await setupFixture(client);
		const livePreviewViewing = await verifyLivePreviewViewing(client);
		const livePreviewEditing = await verifyLivePreviewEditing(client);
		const sourceMode = await verifySourceMode(client);
		const readingMode = await verifyReadingMode(client);
		assertColorParity(livePreviewViewing, sourceMode, readingMode);
		console.log(JSON.stringify({ ok: true, livePreviewViewing, livePreviewEditing, sourceMode, readingMode }, null, 2));
	} finally {
		client.close();
	}
}

main().catch(error => {
	console.error(`verify:obsidian-codeblock-horizontal-scroll-regression failed: ${error.stack ?? error.message}`);
	process.exit(1);
});
