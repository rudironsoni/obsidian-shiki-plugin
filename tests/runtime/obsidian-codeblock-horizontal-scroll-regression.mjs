#!/usr/bin/env node

const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT ?? 9230);
const NOTE_PATH = 'narrow-scroll-regression.md';

function assert(condition, message, details = undefined) {
	if (!condition) {
		const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
		throw new Error(`${message}${suffix}`);
	}
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
			editor.setCursor({ line: 7, ch: 0 });
			await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.cm-scroller');
			if (scroller) scroller.scrollLeft = 0;
			const block = root.querySelector('.shiki-live-preview-block');
			const body = block?.querySelector('.shiki-block-body');
			const codeScroll = block?.querySelector('.shiki-code-scroll');
			const lineNumbers = block?.querySelector('.shiki-line-numbers');
			const code = block?.querySelector('code');
			const beforeLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const beforeCodeLeft = code?.getBoundingClientRect().left ?? null;
			if (body) body.scrollLeft = 260;
			const afterLineLeft = lineNumbers?.getBoundingClientRect().left ?? null;
			const afterCodeLeft = code?.getBoundingClientRect().left ?? null;
			return {
				hasBlock: !!block,
				bodyClient: body?.clientWidth ?? 0,
				bodyScrollWidth: body?.scrollWidth ?? 0,
				bodyScrollLeft: body?.scrollLeft ?? 0,
				codeScrollLeft: codeScroll?.scrollLeft ?? 0,
				lineMoved: beforeLineLeft !== null && afterLineLeft !== null ? beforeLineLeft - afterLineLeft : 0,
				codeMoved: beforeCodeLeft !== null && afterCodeLeft !== null ? beforeCodeLeft - afterCodeLeft : 0,
				noteScrollLeft: scroller?.scrollLeft ?? 0,
			};
		})()`,
		'live preview viewing',
	);
	assert(state.hasBlock, 'Live Preview viewing did not render a Shiki block', state);
	assert(state.bodyScrollWidth > state.bodyClient, 'Live Preview viewing block body is not horizontally scrollable', state);
	assert(state.bodyScrollLeft > 0, 'Live Preview viewing block body did not scroll', state);
	assert(state.lineMoved > 0 && state.codeMoved > 0, 'Live Preview viewing did not scroll the whole block content together', state);
	assert(state.codeScrollLeft === 0, 'Live Preview viewing scrolled the inner code column instead of the block body', state);
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
			const editor = leaf.view.editor;
			const line = editor.getValue().split('\\n').findIndex(value => value.includes('insanelyLongValueName'));
			editor.setCursor({ line, ch: 20 });
			editor.focus();
			await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
			await new Promise(resolve => setTimeout(resolve, 1000));
			const root = leaf.view.containerEl;
			const scroller = root.querySelector('.cm-scroller');
			if (scroller) scroller.scrollLeft = 0;
			const lines = [...root.querySelectorAll('.shiki-editing-codeblock-active-line-nowrap')].filter(el => el.textContent?.includes('LongValueName'));
			for (const line of lines) line.style.setProperty('--shiki-editing-scroll-left', '0');
			const tokenLeftBefore = lines.map(line => line.querySelector('span')?.getBoundingClientRect().left ?? null);
			const rect = lines[0]?.getBoundingClientRect();
			if (rect) {
				const y = rect.top + Math.min(rect.height / 2, 20);
				const fromX = Math.min(rect.right - 24, rect.left + 320);
				const toX = Math.max(rect.left + 16, fromX - 300);
				lines[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 991, pointerType: 'touch', clientX: fromX, clientY: y }));
				lines[0].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 991, pointerType: 'touch', clientX: toX, clientY: y }));
				lines[0].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 991, pointerType: 'touch', clientX: toX, clientY: y }));
			}
			const virtualScrollLeft = lines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || 0);
			const tokenLeftAfter = lines.map(line => line.querySelector('span')?.getBoundingClientRect().left ?? null);
			await window.app.plugins.plugins['advanced-code-block']?.updateCm6Plugin?.();
			await new Promise(resolve => setTimeout(resolve, 250));
			const refreshedLines = [...root.querySelectorAll('.shiki-editing-codeblock-active-line-nowrap')].filter(el => el.textContent?.includes('LongValueName'));
			return {
				label: 'live-preview-editing',
				lineCount: lines.length,
				scrollerScrollLeft: scroller?.scrollLeft ?? 0,
				virtualScrollLeft,
				refreshedVirtualScrollLeft: refreshedLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || 0),
				tokenMoved: tokenLeftBefore.map((left, index) => left !== null && tokenLeftAfter[index] !== null ? left - tokenLeftAfter[index] : 0),
				anyLineOwnScroll: lines.some(el => el.scrollLeft > 0),
				bodyScrollLeft: document.scrollingElement?.scrollLeft ?? 0,
			};
		})()`,
		'live preview editing',
	);
	assert(state.lineCount >= 2, 'Live Preview editing did not find both long code lines', state);
	assert(state.scrollerScrollLeft === 0, 'Live Preview editing moved the whole editor horizontally', state);
	assert(
		state.virtualScrollLeft.every(value => value > 0),
		'Live Preview editing did not set shared block scroll offset',
		state,
	);
	assert(
		state.virtualScrollLeft.every(value => Math.abs(value - state.virtualScrollLeft[0]) < 1),
		'Live Preview editing did not sync every active row',
		state,
	);
	assert(
		state.refreshedVirtualScrollLeft.every(value => value > 0),
		'Live Preview editing lost scroll offset after refresh',
		state,
	);
	assert(
		state.tokenMoved.every(value => value > 0),
		'Live Preview editing did not move token content horizontally',
		state,
	);
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
	assert(state.lineMoved > 0 && state.codeMoved > 0, 'Reading mode did not scroll the whole block content together', state);
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
		if (scroller) scroller.scrollLeft = 0;
		const lines = [...root.querySelectorAll(${source ? "'.cm-content .cm-line'" : "'.shiki-editing-codeblock-active-line-nowrap'"})].filter(el => el.textContent?.includes('LongValueName'));
		const before = lines.map(el => el.getBoundingClientRect().left);
		if (scroller) scroller.scrollLeft = 300;
		const after = lines.map(el => el.getBoundingClientRect().left);
		return {
			label: ${JSON.stringify(label)},
			lineCount: lines.length,
			scrollerClient: scroller?.clientWidth ?? 0,
			scrollerScrollWidth: scroller?.scrollWidth ?? 0,
			scrollerScrollLeft: scroller?.scrollLeft ?? 0,
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
