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
			await window.app.workspace.getLeaf(false).openFile(file);
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
			await plugin?.updateCm6Plugin?.();
			return true;
		})()`,
		'setup fixture',
	);
	await delay(1000);
}

async function verifyLivePreviewViewing(client) {
	const state = await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			const file = window.app.workspace.getActiveFile();
			await Promise.race([
				Promise.resolve(leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: false }, active: true }, { history: false })),
				new Promise(resolve => setTimeout(resolve, 2000)),
			]);
			await new Promise(resolve => setTimeout(resolve, 1000));
			const editor = leaf.view.editor;
			editor.setCursor({ line: 0, ch: 0 });
			await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.cm-scroller');
			if (scroller) scroller.scrollLeft = 0;
			const block = root.querySelector('.shiki-live-preview-block');
			const body = block?.querySelector('.shiki-block-body');
			const codeScroll = block?.querySelector('.shiki-code-scroll');
			const code = block?.querySelector('code');
			const lineNumbers = block?.querySelector('.shiki-line-numbers');
			const visibleGutters = [...root.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(el => getComputedStyle(el).visibility !== 'hidden');
			const lineNumberStyle = lineNumbers ? getComputedStyle(lineNumbers) : null;
			if (body) body.scrollLeft = 0;
			await new Promise(resolve => requestAnimationFrame(resolve));
			const beforeLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const beforeCodeLeft = code?.getBoundingClientRect().left ?? null;
			if (body) body.scrollLeft = 260;
			await new Promise(resolve => requestAnimationFrame(resolve));
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
				lineNumberBackground: lineNumberStyle?.backgroundColor ?? null,
				lineMoved: beforeLineLeft !== null && afterLineLeft !== null ? beforeLineLeft - afterLineLeft : 0,
				codeMoved: beforeCodeLeft !== null && afterCodeLeft !== null ? beforeCodeLeft - afterCodeLeft : 0,
				anyLineOwnScroll: [...root.querySelectorAll('.cm-line')].some(el => el.scrollLeft > 0),
				noteScrollLeft: scroller?.scrollLeft ?? 0,
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
	assert(state.lineNumberCount >= 2, 'Live Preview viewing did not render internal line numbers', state);
	assert(Math.abs(state.lineMoved) < 1, 'Live Preview viewing moved line numbers horizontally', state);
	assert(isOpaqueColor(state.lineNumberBackground), 'Live Preview viewing line number gutter is transparent', state);
	assert(state.codeMoved > 0, 'Live Preview viewing did not move code content horizontally', state);
	assert(!state.anyLineOwnScroll, 'Live Preview viewing left horizontal scroll on individual lines', state);
	assert(state.noteScrollLeft === 0, 'Live Preview viewing moved the note horizontally', state);
	return state;
}

async function verifyLivePreviewEditing(client) {
	const state = await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			const file = window.app.workspace.getActiveFile();
			await Promise.race([
				Promise.resolve(leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: false }, active: true }, { history: false })),
				new Promise(resolve => setTimeout(resolve, 2000)),
			]);
			await new Promise(resolve => setTimeout(resolve, 1000));
			await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.cm-scroller');
			if (scroller) scroller.scrollLeft = 0;
			const block = root.querySelector('.shiki-live-preview-block');
			const codeLine = [...(block?.querySelectorAll('.shiki-code-line') ?? [])].find(el => el.textContent?.includes('insanelyLongValueName'));
			const rect = codeLine?.getBoundingClientRect();
			if (codeLine && rect) {
				codeLine.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: rect.left + 80, clientY: rect.top + rect.height / 2 }));
			}
			await new Promise(resolve => setTimeout(resolve, 500));
			const cursor = leaf.view.editor.getCursor();
			const lines = [...root.querySelectorAll('.cm-line.shiki-live-preview-code-line')].filter(el => el.textContent?.includes('LongValueName'));
			const tokenCount = lines.reduce((count, line) => count + line.querySelectorAll('[style*="color:"]').length, 0);
			await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
			await new Promise(resolve => setTimeout(resolve, 250));
			return {
				label: 'live-preview-editing',
				hadBlock: !!block,
				cursor,
				lineCount: lines.length,
				scrollerScrollLeft: scroller?.scrollLeft ?? 0,
				tokenCount,
				virtualScrollRows: root.querySelectorAll('.shiki-editing-codeblock-active-line-nowrap, .shiki-live-preview-code-line-nowrap[style*="--shiki-editing-scroll-left"]').length,
				anyLineOwnScroll: lines.some(el => el.scrollLeft > 0),
				bodyScrollLeft: document.scrollingElement?.scrollLeft ?? 0,
			};
		})()`,
		'live preview editing',
	);
	assert(state.hadBlock, 'Live Preview editing did not start from a whole-block rendered surface', state);
	assert(state.cursor.line >= 3 && state.cursor.line <= 4, 'Live Preview editing click did not place the cursor inside the code block', state);
	assert(state.lineCount >= 2, 'Live Preview editing did not reveal native code rows for editing', state);
	assert(state.scrollerScrollLeft === 0, 'Live Preview editing moved the whole editor horizontally', state);
	assert(state.tokenCount > 0, 'Live Preview editing native rows are not Shiki-tokenized', state);
	assert(state.virtualScrollRows === 0, 'Live Preview editing still uses virtual per-line horizontal scrolling', state);
	assert(!state.anyLineOwnScroll, 'Live Preview editing left horizontal scroll on individual lines', state);
	assert(state.bodyScrollLeft === 0, 'Live Preview editing moved the document horizontally', state);
	return state;
}

async function verifySourceMode(client) {
	const state = await evaluate(client, blockScrollExpression('source', true), 'source mode');
	assertBlockScrollerState(state, 'Source mode');
	return state;
}

async function verifyReadingMode(client) {
	const state = await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.activeLeaf;
			const file = window.app.workspace.getActiveFile();
			await leaf.openFile(file, { active: true, state: { mode: 'preview' } });
			await Promise.race([
				Promise.resolve(leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'preview', source: false }, active: true }, { history: false })),
				new Promise(resolve => setTimeout(resolve, 2000)),
			]);
			const preview = leaf.view.containerEl.querySelector('.markdown-preview-view');
			for (let i = 0; i < 20 && !leaf.view.containerEl.querySelector('.shiki-reading-block'); i++) {
				if (preview) {
					preview.scrollTop = i % 2 === 0 ? 0 : 400;
					preview.dispatchEvent(new Event('scroll'));
				}
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.markdown-preview-view');
			if (scroller) scroller.scrollLeft = 0;
			const blocks = [...root.querySelectorAll('.shiki-reading-block')];
			const block = blocks[0];
			const directHeaders = block ? [...block.children].filter(el => el.matches('.shiki-block-header')) : [];
			const directBodies = block ? [...block.children].filter(el => el.matches('.shiki-block-body')) : [];
			const body = directBodies[0];
			const codeScroll = body?.querySelector('.shiki-code-scroll');
			const lineNumbers = body?.querySelector('.shiki-line-numbers');
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
		const file = window.app.workspace.getActiveFile();
		await Promise.race([
			Promise.resolve(leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: ${source} }, active: true }, { history: false })),
			new Promise(resolve => setTimeout(resolve, 2000)),
		]);
		await new Promise(resolve => setTimeout(resolve, 1000));
		const editor = leaf.view.editor;
		const line = editor.getValue().split('\\n').findIndex(value => value.includes('insanelyLongValueName'));
		editor.setCursor({ line, ch: 20 });
		editor.focus();
		await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
		await new Promise(resolve => setTimeout(resolve, 1000));
		const root = leaf.view.containerEl;
		const scroller = root.querySelector('.cm-scroller');
		const content = root.querySelector('.cm-content');
		if (scroller) scroller.scrollLeft = 0;
		const lines = [...root.querySelectorAll(${source ? "'.cm-content .cm-line'" : "'.shiki-editing-codeblock-active-line-nowrap'"})].filter(el => el.textContent?.includes('LongValueName'));
		const codeLines = ${source ? "[...root.querySelectorAll('.cm-content .cm-line.HyperMD-codeblock, .cm-content .cm-line.HyperMD-codeblock-bg')]" : '[]'};
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
		};
	})()`;
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
		await setupFixture(client);
		const livePreviewViewing = await verifyLivePreviewViewing(client);
		const livePreviewEditing = await verifyLivePreviewEditing(client);
		const sourceMode = await verifySourceMode(client);
		const readingMode = await verifyReadingMode(client);
		console.log(JSON.stringify({ ok: true, livePreviewViewing, livePreviewEditing, sourceMode, readingMode }, null, 2));
	} finally {
		client.close();
	}
}

main().catch(error => {
	console.error(`verify:obsidian-codeblock-horizontal-scroll-regression failed: ${error.stack ?? error.message}`);
	process.exit(1);
});
