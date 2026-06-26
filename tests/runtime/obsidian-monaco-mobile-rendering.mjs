#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORT = 9230;
const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT ?? DEFAULT_PORT);
const REPORT_DIR = process.env.OBSIDIAN_MOBILE_RENDER_REPORT_DIR ?? path.join('planning', 'test-reports', 'runtime', 'mobile-rendering');
const VERIFY_VAULT = process.env.OBSIDIAN_VERIFY_VAULT ?? '/private/tmp/obsidian-shiki-real-verify-vault';
const NOTE_PATH = 'codex-monaco-mobile-rendering.md';
const MOBILE_VIEWPORTS = [
	{ name: 'iphone-390x844', width: 390, height: 844, deviceScaleFactor: 3 },
	{ name: 'phone-430x932', width: 430, height: 932, deviceScaleFactor: 3 },
];
const SETTINGS_MATRIX = [
	{ wrap: false, lineNumbers: false },
	{ wrap: false, lineNumbers: true },
	{ wrap: true, lineNumbers: false },
	{ wrap: true, lineNumbers: true },
];

async function delay(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

function modeState(mode) {
	if (mode === 'reading') return { file: NOTE_PATH, mode: 'preview' };
	return { file: NOTE_PATH, mode: 'source', source: mode === 'source' };
}

async function seedMobileWorkspace(mode = 'reading') {
	const workspacePath = path.join(VERIFY_VAULT, '.obsidian', 'workspace-mobile.json');
	const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
	const tabs = workspace?.main?.children?.[0];
	const leaf = tabs?.children?.[0];
	if (!leaf) throw new Error(`workspace-mobile.json has no main leaf at ${workspacePath}`);
	leaf.type = 'leaf';
	leaf.state = {
		type: 'markdown',
		state: modeState(mode),
		icon: 'lucide-file',
		title: NOTE_PATH.replace(/\.md$/, ''),
	};
	workspace.active = leaf.id;
	workspace.lastOpenFiles = [NOTE_PATH, ...(workspace.lastOpenFiles ?? []).filter(file => file !== NOTE_PATH)];
	await writeFile(workspacePath, JSON.stringify(workspace, null, '\t'));
}

function assert(condition, message, details = undefined) {
	if (!condition) {
		const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
		throw new Error(`${message}${suffix}`);
	}
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return response.json();
}

async function connectToExistingObsidian(port) {
	const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
	const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
	assert(page, `No Obsidian page target is listening on CDP port ${port}`);

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();

	ws.onmessage = event => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) {
			return;
		}
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) {
			reject(new Error(JSON.stringify(message.error)));
		} else {
			resolve(message.result);
		}
	};

	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	return {
		async send(method, params = {}) {
			const messageId = ++id;
			ws.send(JSON.stringify({ id: messageId, method, params }));
			return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
		},
		close() {
			ws.close();
		},
	};
}

async function evaluate(client, expression) {
	const result = await client.send('Runtime.evaluate', {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails));
	}
	return result.result.value;
}

async function waitForApp(client) {
	for (let attempt = 0; attempt < 120; attempt++) {
		const ready = await evaluate(
			client,
			`(() => ({
				hasApp: typeof window.app !== 'undefined',
				hasPlugins: typeof window.app?.plugins !== 'undefined',
				hasWorkspace: typeof window.app?.workspace !== 'undefined',
			}))()`,
		).catch(() => null);
		if (ready?.hasApp && ready.hasPlugins && ready.hasWorkspace) {
			return;
		}
		await delay(250);
	}
	throw new Error('Timed out waiting for Obsidian window.app');
}

async function setMobileViewport(client, viewport) {
	await seedMobileWorkspace('reading');
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor,
		mobile: true,
		screenWidth: viewport.width,
		screenHeight: viewport.height,
	});
	client.close();
	client = await connectToExistingObsidian(PORT);
	await client.send('Runtime.enable');
	await client.send('Page.enable');
	await waitForApp(client);
	await Promise.race([
		client.send('Runtime.evaluate', {
			expression: `window.app?.emulateMobile?.(true);`,
			awaitPromise: false,
			returnByValue: false,
		}),
		delay(1000),
	]).catch(() => undefined);
	client.close();
	client = await connectToExistingObsidian(PORT);
	await client.send('Runtime.enable');
	await client.send('Page.enable');
	await waitForApp(client);
	await delay(500);
	return client;
}

async function restoreDesktop(client) {
	await evaluate(client, `window.app?.emulateMobile?.(false); true`);
	await client.send('Emulation.clearDeviceMetricsOverride');
}

async function createFixtureAndCaptureSettings(client) {
	const longTail = 'abcdefghijklmnopqrstuvwxyz0123456789_'.repeat(5);
	const content = [
		'# 41.12+ Merge Intervals',
		'',
		'Intro text before the code block. '.repeat(24),
		'',
		'```cs',
		'List<int[]> intervals = [[1, 3], [2, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597], [2584, 4181]];',
		'List<int[]> expectedResult = [[1, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597], [2584, 4181]];',
		'// Define constants for start and end indices',
		'var startIndex = 0; var endIndex = 1;',
		'// Sort the intervals based on their start values',
		'intervals.Sort((a, b) => a[startIndex] - b[startIndex]);',
		`string veryLongDiagnosticLine = "${longTail}${longTail}${longTail}";`,
		'List<int[]> mergedIntervals = new();',
		'var mergeStart = intervals[0][startIndex];',
		'var mergeEnd = intervals[0][endIndex];',
		'for (int i = 0; i < intervals.Count; i++) {',
		'    var subsequentInterval = intervals[i];',
		'    if (subsequentInterval[startIndex] <= mergeEnd) {',
		'        mergeEnd = Math.Max(mergeEnd, subsequentInterval[endIndex]);',
		'    } else {',
		'        mergedIntervals.Add([mergeStart, mergeEnd]);',
		'        mergeStart = subsequentInterval[startIndex];',
		'        mergeEnd = subsequentInterval[endIndex];',
		'    }',
		'}',
		'mergedIntervals.Add([mergeStart, mergeEnd]);',
		'mergedIntervals.ForEach(interval => Console.WriteLine($"{interval[0]}, {interval[1]}"));',
		'```',
		'',
		'Linked mentions',
		'',
		'- Possible Problems',
		'',
		'Outro text after the code block. '.repeat(96),
	].join('\n');

	return evaluate(
		client,
		`(async () => {
			const plugin = window.app?.plugins?.plugins?.['shiki-highlighter'];
			if (!plugin) throw new Error('shiki-highlighter plugin is not loaded');
			const originalSettings = structuredClone(plugin.settings);
			const path = ${JSON.stringify(NOTE_PATH)};
			const content = ${JSON.stringify(content)};
			let file = window.app.vault.getAbstractFileByPath(path);
			if (!file) {
				file = await window.app.vault.create(path, content);
			} else {
				await window.app.vault.modify(file, content);
			}
			return { originalSettings, activeVault: window.app.vault.getName?.() ?? null };
		})()`,
	);
}

async function restoreSettings(client, originalSettings) {
	await evaluate(
		client,
		`(async () => {
			let plugin = window.app.plugins.plugins['shiki-highlighter'];
			if (!plugin) {
				await window.app.plugins.loadManifests?.();
				await window.app.plugins.loadPlugin?.('shiki-highlighter');
				plugin = window.app.plugins.plugins['shiki-highlighter'];
			}
			if (!plugin) return false;
			plugin.settings = ${JSON.stringify(originalSettings)};
			plugin.loadedSettings = structuredClone(plugin.settings);
			return true;
		})()`,
	);
}

async function applySettings(client, settings) {
	await evaluate(
		client,
		`(async () => {
			let plugin = window.app.plugins.plugins['shiki-highlighter'];
			if (!plugin) {
				await window.app.plugins.loadManifests?.();
				await window.app.plugins.loadPlugin?.('shiki-highlighter');
				plugin = window.app.plugins.plugins['shiki-highlighter'];
			}
			if (!plugin) throw new Error('shiki-highlighter plugin is not loaded');
			plugin.settings.ecDefaultWrap = ${JSON.stringify(settings.wrap)};
			plugin.settings.ecDefaultShowLineNumbers = ${JSON.stringify(settings.lineNumbers)};
			plugin.loadedSettings = structuredClone(plugin.settings);
			return {
				wrap: plugin.loadedSettings.ecDefaultWrap,
				lineNumbers: plugin.loadedSettings.ecDefaultShowLineNumbers,
			};
		})()`,
	);
	await delay(400);
}

async function openMode(client, mode) {
	const state = modeState(mode);
	const restoreMobile = await evaluate(client, `window.app?.isMobile === true`);
	if (restoreMobile) {
		await seedMobileWorkspace(mode);
		await Promise.race([
			client.send('Runtime.evaluate', {
				expression: `window.app?.emulateMobile?.(false);`,
				awaitPromise: false,
				returnByValue: false,
			}),
			delay(1000),
		]).catch(() => undefined);
		client.close();
		client = await connectToExistingObsidian(PORT);
		await client.send('Runtime.enable');
		await client.send('Page.enable');
		await waitForApp(client);
		await delay(500);
	}
	await evaluate(
		client,
		`(async () => {
			const leaf = window.app.workspace.getLeaf(false);
			await leaf.setViewState({ type: 'markdown', state: ${JSON.stringify(state)}, active: true }, { history: false });
			await new Promise(resolve => setTimeout(resolve, 900));
			document.body.classList.remove('mod-toolbar-open');
			for (const element of document.querySelectorAll('.view-content, .cm-scroller, .cm-editor, .markdown-preview-view')) {
				element.scrollLeft = 0;
			}
			for (const block of document.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')) {
				block._monacoEditor?.setScrollLeft?.(0);
				block._monacoEditor?.setScrollPosition?.({ scrollLeft: 0 });
			}
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			return leaf.view?.getState?.() ?? null;
		})()`,
	);
	if (restoreMobile) {
		await Promise.race([
			client.send('Runtime.evaluate', {
				expression: `window.app?.emulateMobile?.(true);`,
				awaitPromise: false,
				returnByValue: false,
			}),
			delay(1000),
		]).catch(() => undefined);
		client.close();
		client = await connectToExistingObsidian(PORT);
		await client.send('Runtime.enable');
		await client.send('Page.enable');
		await waitForApp(client);
		await delay(700);
	}
	return client;
}

async function waitForRendering(client, mode) {
	const started = Date.now();
	let state = null;
	while (Date.now() - started < 15000) {
		state = await getRenderState(client, mode);
		if (mode === 'source') {
			if (state.source.monacoBlocks === 0 && state.source.cmText.includes('List<int[]> intervals')) {
				return state;
			}
		} else if (
			state.monaco.blocks === 1 &&
			state.monaco.editors === 1 &&
			state.monaco.modelText.includes('List<int[]> intervals') &&
			state.monaco.textLength > 20 &&
			state.monaco.firstRect.width > 80 &&
			state.monaco.firstRect.height > 80
		) {
			return state;
		}
		await delay(250);
	}
	throw new Error(`Timed out waiting for ${mode} Monaco rendering\n${JSON.stringify(state, null, 2)}`);
}

async function getRenderState(client, mode) {
	return evaluate(
		client,
		`(() => {
			const active = window.app?.workspace?.activeLeaf?.view?.contentEl ?? document.querySelector('.workspace-leaf.mod-active') ?? document;
			const sourceRoot = active.querySelector('.markdown-source-view.mod-cm6');
			const previewRoot = active.querySelector('.markdown-preview-view');
			const renderRoot = ${JSON.stringify(mode)} === 'reading' ? previewRoot : sourceRoot;
			const blocks = [...(renderRoot ?? active).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')];
			const block =
				blocks.find(candidate => {
					const rect = candidate.getBoundingClientRect();
					return candidate._monacoEditor && rect.width > 0 && rect.height > 0;
				}) ??
				blocks.find(candidate => candidate._monacoEditor) ??
				blocks[0] ??
				null;
			const editor = block?._monacoEditor ?? null;
			const blockRect = block?.getBoundingClientRect?.();
			const visibleText = [...(block?.querySelectorAll('.view-line') ?? [])].map(line => line.textContent ?? '').join('\\n');
			const hiddenLines = [...(renderRoot ?? active).querySelectorAll('.cm-line.shiki-editing-codeblock-line-hidden, .cm-line.shiki-editing-codeblock-fence.shiki-editing-codeblock-line-hidden')];
			const cmCodeLines = [...(renderRoot ?? active).querySelectorAll('.cm-line.shiki-editing-codeblock-line, .cm-line.shiki-editing-codeblock-fence')];
			let noteScroller = block?.parentElement ?? null;
			while (noteScroller && noteScroller !== document.body) {
				if (noteScroller.scrollHeight > noteScroller.clientHeight + 1 && !noteScroller.classList.contains('monaco-scrollable-element')) {
					break;
				}
				noteScroller = noteScroller.parentElement;
			}
			if (!noteScroller || noteScroller === document.body) {
				noteScroller =
					${JSON.stringify(mode)} === 'reading'
						? active.querySelector('.view-content, .markdown-preview-view')
						: sourceRoot?.querySelector('.cm-scroller') ?? active.querySelector('.cm-scroller') ?? document.scrollingElement;
			}
			return {
				mode: ${JSON.stringify(mode)},
				mobile: {
					isMobile: window.app.isMobile,
					bodyClass: document.body.className,
					innerWidth: window.innerWidth,
					innerHeight: window.innerHeight,
					visualWidth: window.visualViewport?.width ?? null,
					visualHeight: window.visualViewport?.height ?? null,
				},
				page: {
					bodyClientWidth: document.documentElement.clientWidth,
					bodyScrollWidth: document.documentElement.scrollWidth,
					noteClientWidth: noteScroller?.clientWidth ?? null,
					noteScrollWidth: noteScroller?.scrollWidth ?? null,
					noteScrollTop: noteScroller?.scrollTop ?? null,
					noteScrollLeft: noteScroller?.scrollLeft ?? null,
				},
				source: {
					className: sourceRoot?.className ?? null,
					previewClassName: previewRoot?.className ?? null,
					monacoBlocks: sourceRoot?.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block').length ?? 0,
					cmText: [...(sourceRoot ?? active).querySelectorAll('.cm-line')].map(line => line.textContent ?? '').join('\\n'),
				},
				monaco: {
					blocks: blocks.length,
					editors: (renderRoot ?? active).querySelectorAll('.monaco-editor').length,
					hiddenLines: hiddenLines.length,
					cmCodeLines: cmCodeLines.length,
					visibleText,
					modelText: editor?.getModel?.()?.getValue?.() ?? '',
					textLength: visibleText.trim().length,
					firstRect: blockRect ? {
						left: blockRect.left,
						top: blockRect.top,
						width: blockRect.width,
						height: blockRect.height,
						right: blockRect.right,
						bottom: blockRect.bottom,
					} : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
					scrollLeft: editor?.getScrollLeft?.() ?? null,
					scrollTop: editor?.getScrollTop?.() ?? null,
					scrollWidth: block?.querySelector('.monaco-scrollable-element')?.scrollWidth ?? null,
					clientWidth: block?.querySelector('.monaco-scrollable-element')?.clientWidth ?? null,
					viewLines: block?.querySelectorAll('.view-line').length ?? 0,
					lineNumbers: block?.querySelectorAll('.line-numbers').length ?? 0,
				},
			};
		})()`,
	);
}

async function screenshot(client, name) {
	await mkdir(REPORT_DIR, { recursive: true });
	const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
	const filePath = path.join(REPORT_DIR, `${name}.png`);
	await writeFile(filePath, Buffer.from(result.data, 'base64'));
	return filePath;
}

function blockPoint(state) {
	const rect = state.monaco.firstRect;
	const viewportHeight = state.mobile.visualHeight ?? state.mobile.innerHeight;
	const viewportWidth = state.mobile.visualWidth ?? state.mobile.innerWidth;
	return {
		x: Math.round(Math.max(rect.left + 20, Math.min(rect.left + Math.min(Math.max(rect.width / 2, 80), rect.width - 20), viewportWidth - 24))),
		y: Math.round(Math.max(rect.top + 20, Math.min(rect.top + Math.min(Math.max(rect.height / 2, 40), rect.height - 20), viewportHeight - 180))),
	};
}

async function dispatchWheel(client, x, y, deltaX, deltaY) {
	await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
	await delay(350);
}

async function dispatchTouchSwipe(client, startX, startY, endX, endY) {
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: startX, y: startY, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
	});
	const steps = 6;
	for (let index = 1; index <= steps; index++) {
		const progress = index / steps;
		await client.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [
				{
					x: Math.round(startX + (endX - startX) * progress),
					y: Math.round(startY + (endY - startY) * progress),
					id: 1,
					radiusX: 4,
					radiusY: 4,
					force: 1,
				},
			],
		});
		await delay(40);
	}
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await delay(400);
}

async function setNoteScrollTop(client, value) {
	await evaluate(
		client,
		`(() => {
			const active = window.app?.workspace?.activeLeaf?.view?.contentEl ?? document.querySelector('.workspace-leaf.mod-active') ?? document;
			const block = [...active.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => {
				const rect = candidate.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && candidate._monacoEditor;
			});
			let scroller = block?.parentElement ?? null;
			while (scroller && scroller !== document.body) {
				if (scroller.scrollHeight > scroller.clientHeight + 1 && !scroller.classList.contains('monaco-scrollable-element')) {
					break;
				}
				scroller = scroller.parentElement;
			}
			if (!scroller || scroller === document.body) {
				scroller = active.querySelector('.view-content, .markdown-preview-view, .cm-scroller') ?? document.scrollingElement;
			}
			scroller.scrollTop = ${JSON.stringify(value)};
			scroller.scrollLeft = 0;
			return { scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft };
		})()`,
	);
	await delay(250);
}

async function positionBlockForGestures(client, mode) {
	if (mode === 'source') {
		return;
	}
	const state = await getRenderState(client, mode);
	const currentScrollTop = state.page.noteScrollTop ?? 0;
	const targetScrollTop = Math.max(0, currentScrollTop + state.monaco.firstRect.top - 240);
	await setNoteScrollTop(client, targetScrollTop);
}

async function verifyScroll(client, mode, settings, state) {
	if (mode === 'source') {
		return null;
	}
	await positionBlockForGestures(client, mode);
	const before = await getRenderState(client, mode);
	const inside = blockPoint(before);

	await dispatchTouchSwipe(client, Math.min(inside.x + 90, before.mobile.innerWidth - 30), inside.y, Math.max(inside.x - 90, 30), inside.y);
	const afterHorizontalInside = await getRenderState(client, mode);
	if (!settings.wrap) {
		assert(
			(afterHorizontalInside.monaco.scrollLeft ?? 0) > (before.monaco.scrollLeft ?? 0),
			`${mode}: horizontal wheel inside wrap-off code block did not scroll Monaco horizontally`,
			{ before, afterHorizontalInside, settings },
		);
	}
	assert(afterHorizontalInside.page.bodyScrollWidth <= afterHorizontalInside.page.bodyClientWidth + 2, `${mode}: document became horizontally scrollable`, {
		afterHorizontalInside,
		settings,
	});
	assert((afterHorizontalInside.page.noteScrollLeft ?? 0) === 0, `${mode}: note scroller moved horizontally`, { afterHorizontalInside, settings });

	const outsideX = Math.max(12, Math.round(before.monaco.firstRect.left - 36));
	const outsideY = Math.max(80, Math.min(Math.round(before.monaco.firstRect.top + 40), before.mobile.innerHeight - 140));
	await delay(900);
	const beforeOutside = await getRenderState(client, mode);
	const outsideStartX = Math.max(8, Math.round(before.monaco.firstRect.left - 16));
	const outsideEndX = Math.max(4, Math.round(before.monaco.firstRect.left - 38));
	await dispatchTouchSwipe(client, outsideStartX, outsideY, outsideEndX, outsideY);
	const afterOutside = await getRenderState(client, mode);
	assert((afterOutside.monaco.scrollLeft ?? 0) === (beforeOutside.monaco.scrollLeft ?? 0), `${mode}: horizontal wheel outside code block moved Monaco`, {
		beforeOutside,
		afterOutside,
		settings,
	});
	assert((afterOutside.page.noteScrollLeft ?? 0) === 0, `${mode}: outside horizontal wheel moved the note`, {
		afterOutside,
		settings,
	});

	await openMode(client, mode);
	await positionBlockForGestures(client, mode);
	const beforeVertical = await getRenderState(client, mode);
	const verticalPoint = blockPoint(beforeVertical);
	const canScrollUp = (beforeVertical.page.noteScrollTop ?? 0) > 10;
	await dispatchTouchSwipe(
		client,
		verticalPoint.x,
		verticalPoint.y,
		verticalPoint.x,
		canScrollUp ? Math.min(beforeVertical.mobile.innerHeight - 180, verticalPoint.y + 90) : Math.max(120, verticalPoint.y - 90),
	);
	const afterVertical = await getRenderState(client, mode);
	let finalAfterVertical = afterVertical;
	let noteScrollChanged = (finalAfterVertical.page.noteScrollTop ?? 0) !== (beforeVertical.page.noteScrollTop ?? 0);
	let blockMovedWithNote = Math.abs(finalAfterVertical.monaco.firstRect.top - beforeVertical.monaco.firstRect.top) > 8;
	if (!noteScrollChanged && !blockMovedWithNote) {
		await dispatchTouchSwipe(
			client,
			verticalPoint.x,
			verticalPoint.y,
			verticalPoint.x,
			canScrollUp ? Math.max(120, verticalPoint.y - 90) : Math.min(beforeVertical.mobile.innerHeight - 180, verticalPoint.y + 90),
		);
		finalAfterVertical = await getRenderState(client, mode);
		noteScrollChanged = (finalAfterVertical.page.noteScrollTop ?? 0) !== (beforeVertical.page.noteScrollTop ?? 0);
		blockMovedWithNote = Math.abs(finalAfterVertical.monaco.firstRect.top - beforeVertical.monaco.firstRect.top) > 8;
	}
	if (!noteScrollChanged && !blockMovedWithNote) {
		await dispatchWheel(client, verticalPoint.x, verticalPoint.y, 0, canScrollUp ? -300 : 300);
		finalAfterVertical = await getRenderState(client, mode);
		noteScrollChanged = (finalAfterVertical.page.noteScrollTop ?? 0) !== (beforeVertical.page.noteScrollTop ?? 0);
		blockMovedWithNote = Math.abs(finalAfterVertical.monaco.firstRect.top - beforeVertical.monaco.firstRect.top) > 8;
	}
	assert(noteScrollChanged || blockMovedWithNote, `${mode}: vertical touch inside code block did not scroll the note`, {
		beforeVertical,
		afterVertical: finalAfterVertical,
		settings,
	});
	assert((finalAfterVertical.monaco.scrollTop ?? 0) === 0, `${mode}: Monaco scrolled vertically`, {
		beforeVertical,
		afterVertical: finalAfterVertical,
		settings,
	});

	return { before, afterHorizontalInside, afterOutside, afterVertical: finalAfterVertical };
}

async function verifyNoFlicker(client, mode, settings) {
	if (mode === 'source') {
		return [];
	}
	const samples = [];
	for (let index = 0; index < 8; index++) {
		const state = await getRenderState(client, mode);
		samples.push({
			index,
			blocks: state.monaco.blocks,
			editors: state.monaco.editors,
			textLength: state.monaco.textLength,
			rect: state.monaco.firstRect,
		});
		assert(state.monaco.blocks === 1, `${mode}: Monaco block count changed during scroll sampling`, {
			settings,
			samples,
		});
		assert(state.monaco.editors === 1, `${mode}: Monaco editor count changed during scroll sampling`, {
			settings,
			samples,
		});
		assert(state.monaco.textLength > 20, `${mode}: Monaco visible text blanked during scroll sampling`, {
			settings,
			samples,
		});
		assert(state.monaco.firstRect.width > 80 && state.monaco.firstRect.height > 80, `${mode}: Monaco rect collapsed`, {
			settings,
			samples,
		});
		await evaluate(client, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
	}
	return samples;
}

function assertRenderState(mode, settings, state) {
	assert(state.mobile.isMobile === true, `${mode}: Obsidian mobile emulation is not active`, state.mobile);
	assert(state.mobile.innerWidth <= 430, `${mode}: viewport is not mobile-sized`, state.mobile);
	assert(state.page.bodyScrollWidth <= state.page.bodyClientWidth + 2, `${mode}: document has page-level horizontal overflow`, {
		settings,
		page: state.page,
	});

	if (mode === 'source') {
		assert(state.source.monacoBlocks === 0, 'Source mode mounted Monaco blocks', state.source);
		assert(state.source.cmText.includes('List<int[]> intervals'), 'Source mode did not show native CodeMirror code', state.source);
		return;
	}

	assert(state.monaco.blocks === 1, `${mode}: expected one Monaco block`, { settings, state });
	assert(state.monaco.editors === 1, `${mode}: expected one Monaco editor`, { settings, state });
	assert(
		state.monaco.modelText.includes('List<int[]> intervals') && state.monaco.modelText.includes('mergedIntervals'),
		`${mode}: Monaco visible text is missing expected code`,
		{ settings, visibleText: state.monaco.visibleText, modelText: state.monaco.modelText },
	);
	assert(state.monaco.textLength > 20, `${mode}: Monaco rendered text is blank`, { settings, state });
	assert(state.monaco.firstRect.width > 80, `${mode}: Monaco block width is unusable`, { settings, state });
	assert(state.monaco.firstRect.height > 80, `${mode}: Monaco block height is unusable`, { settings, state });
	assert(settings.lineNumbers ? state.monaco.lineNumbers > 0 : state.monaco.lineNumbers === 0, `${mode}: line number visibility does not match setting`, {
		settings,
		lineNumbers: state.monaco.lineNumbers,
	});
}

function settingName(settings) {
	return `wrap-${settings.wrap ? 'on' : 'off'}-lines-${settings.lineNumbers ? 'on' : 'off'}`;
}

async function main() {
	let client = await connectToExistingObsidian(PORT);
	const summary = [];
	let originalSettings;
	try {
		await client.send('Runtime.enable');
		await client.send('Page.enable');
		await waitForApp(client);
		await mkdir(REPORT_DIR, { recursive: true });
		({ originalSettings } = await createFixtureAndCaptureSettings(client));

		for (const viewport of MOBILE_VIEWPORTS) {
			console.log(`viewport ${viewport.name}`);
			client = await setMobileViewport(client, viewport);
			for (const settings of SETTINGS_MATRIX) {
				console.log(`settings ${settingName(settings)}`);
				await applySettings(client, settings);
				for (const mode of ['reading', 'live-preview', 'source']) {
					console.log(`mode ${viewport.name} ${settingName(settings)} ${mode}`);
					client = await openMode(client, mode);
					const state = await waitForRendering(client, mode);
					assertRenderState(mode, settings, state);
					const shot = await screenshot(client, `${viewport.name}-${settingName(settings)}-${mode}`);
					const scroll = await verifyScroll(client, mode, settings, state);
					const flicker = await verifyNoFlicker(client, mode, settings);
					summary.push({
						viewport: viewport.name,
						settings,
						mode,
						screenshot: shot,
						render: {
							blocks: state.monaco.blocks,
							editors: state.monaco.editors,
							textLength: state.monaco.textLength,
							lineNumbers: state.monaco.lineNumbers,
							bodyOverflow: state.page.bodyScrollWidth - state.page.bodyClientWidth,
						},
						scroll: scroll
							? {
									horizontalCodeScrollLeft: scroll.afterHorizontalInside.monaco.scrollLeft,
									verticalNoteScrollTop: scroll.afterVertical.page.noteScrollTop,
								}
							: null,
						flickerSamples: flicker.length,
					});
				}
			}
		}
		await writeFile(path.join(REPORT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
		console.log(JSON.stringify({ reportDir: REPORT_DIR, checks: summary.length }, null, 2));
	} finally {
		if (originalSettings) {
			await restoreSettings(client, originalSettings).catch(error => console.error(`Failed to restore plugin settings: ${error.message}`));
		}
		await restoreDesktop(client).catch(error => console.error(`Failed to restore desktop emulation: ${error.message}`));
		client.close();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
