#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORT = 9230;
const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT ?? DEFAULT_PORT);
const REPORT_DIR = process.env.OBSIDIAN_LIVE_PREVIEW_REDRAW_REPORT_DIR ?? path.join('planning', 'test-reports', 'runtime', 'live-preview-redraw-loop');
const NOTE_PATH = 'codex-live-preview-redraw-loop.md';
const CODE_MARKER = 'redrawLoopMarker';

const SETTINGS_MATRIX = [
	{ wrap: false, lineNumbers: false },
	{ wrap: false, lineNumbers: true },
	{ wrap: true, lineNumbers: false },
	{ wrap: true, lineNumbers: true },
];

const VIEWPORTS = [
	{ name: 'desktop-1200x900', width: 1200, height: 900, mobile: false, deviceScaleFactor: 1 },
	{ name: 'mobile-390x844', width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
];

function assert(condition, message, details = undefined) {
	if (!condition) {
		const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
		throw new Error(`${message}${suffix}`);
	}
}

async function delay(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return response.json();
}

function isObsidianTarget(target) {
	if (!target?.webSocketDebuggerUrl || target.type !== 'page') {
		return false;
	}
	const title = `${target.title ?? ''}`;
	const url = `${target.url ?? ''}`;
	return /obsidian/i.test(title) || /app:\/\/obsidian\.md/i.test(url);
}

async function connectToExistingObsidian(port) {
	const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
	const page = targets.find(target => /app:\/\/obsidian\.md\/index\.html/i.test(target.url ?? '')) ?? targets.find(isObsidianTarget);
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
	let lastError;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const result = await withTimeout(
				client.send('Runtime.evaluate', {
					expression,
					awaitPromise: true,
					returnByValue: true,
				}),
				5_000,
				`Timed out evaluating ${expression.slice(0, 120)}`,
			);
			if (result.exceptionDetails) {
				throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails));
			}
			return result.result.value;
		} catch (error) {
			lastError = error;
			if (!isRetryableRuntimeReset(error)) {
				throw error;
			}
			await delay(250);
		}
	}
	throw lastError;
}

function isRetryableRuntimeReset(error) {
	const message = String(error?.message ?? error);
	return (
		message.includes('Execution context was destroyed') ||
		message.includes('Cannot find context with specified id') ||
		message.includes('Inspected target navigated or closed') ||
		message.includes('Cannot access a disposed object')
	);
}

async function withTimeout(promise, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitFor(client, expression, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await evaluate(client, expression);
		if (lastValue) {
			return lastValue;
		}
		await delay(150);
	}
	throw new Error(`${message}\nLast value:\n${JSON.stringify(lastValue, null, 2)}`);
}

async function waitForPlugin(client) {
	return waitFor(
		client,
		`Boolean(globalThis.app?.workspace && globalThis.app?.vault && globalThis.app?.plugins?.plugins?.['advanced-code-block'])`,
		'Timed out waiting for advanced-code-block plugin',
	);
}

function fixtureContent() {
	const longTail = 'abcdefghijklmnopqrstuvwxyz0123456789_'.repeat(12);
	return [
		'# Live Preview redraw loop fixture',
		'',
		'Intro paragraph before the code block. '.repeat(10),
		'',
		'```ts',
		'const intervals = [[1, 3], [2, 6], [8, 10], [15, 18]];',
		'const merged: Array<[number, number]> = [];',
		`const ${CODE_MARKER} = "${longTail}";`,
		'for (const [start, end] of intervals) {',
		'  const previous = merged.at(-1);',
		'  if (!previous || previous[1] < start) {',
		'    merged.push([start, end]);',
		'  } else {',
		'    previous[1] = Math.max(previous[1], end);',
		'  }',
		'}',
		'console.log(merged);',
		'```',
		'',
		'After paragraph. '.repeat(160),
	].join('\n');
}

async function setupFixture(client) {
	return evaluate(
		client,
		`(async () => {
			if (!globalThis.app?.vault || !globalThis.app?.workspace) throw new Error('Obsidian app is not ready');
			const plugin = globalThis.app.plugins.plugins['advanced-code-block'];
			if (!plugin) throw new Error('advanced-code-block is not loaded');
			const content = ${JSON.stringify(fixtureContent())};
			let file = globalThis.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			if (!file) {
				file = await globalThis.app.vault.create(${JSON.stringify(NOTE_PATH)}, content);
			} else {
				await globalThis.app.vault.modify(file, content);
			}
			const originalSettings = structuredClone(plugin.settings);
			return { originalSettings, activeFile: file.path };
		})()`,
	);
}

async function restoreSettings(client, originalSettings) {
	await waitForPlugin(client);
	await evaluate(
		client,
		`(async () => {
			const plugin = globalThis.app.plugins.plugins['advanced-code-block'];
			if (!plugin) return false;
			plugin.settings = ${JSON.stringify(originalSettings)};
			plugin.loadedSettings = structuredClone(plugin.settings);
			await plugin.saveData(plugin.settings);
			return true;
		})()`,
	);
}

async function applySettings(client, settings) {
	await waitForPlugin(client);
	await evaluate(
		client,
		`(async () => {
			const plugin = globalThis.app.plugins.plugins['advanced-code-block'];
			if (!plugin) throw new Error('advanced-code-block is not loaded');
			plugin.settings.wrapLines = ${JSON.stringify(settings.wrap)};
			plugin.settings.showLineNumbers = ${JSON.stringify(settings.lineNumbers)};
			plugin.loadedSettings = structuredClone(plugin.settings);
			await plugin.saveData(plugin.settings);
			return {
				wrap: plugin.loadedSettings.wrapLines,
				lineNumbers: plugin.loadedSettings.showLineNumbers,
			};
		})()`,
	);
}

async function setViewport(client, viewport) {
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor,
		mobile: viewport.mobile,
	});
	await waitFor(client, 'Boolean(globalThis.app?.workspace && globalThis.app?.vault)', 'Timed out waiting for Obsidian app global');
	await evaluate(client, `globalThis.app?.emulateMobile?.(${JSON.stringify(viewport.mobile)}); true`);
	await waitFor(
		client,
		`Boolean(globalThis.app?.workspace && globalThis.app?.vault) && globalThis.app?.isMobile === ${JSON.stringify(viewport.mobile)}`,
		`Timed out waiting for ${viewport.name}`,
	);
}

async function openMode(client, mode) {
	const state = mode === 'reading' ? { file: NOTE_PATH, mode: 'preview' } : { file: NOTE_PATH, mode: 'source', source: mode === 'source' };
	await evaluate(
		client,
		`(async () => {
			const bounded = async promise => {
				try {
					await Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error('open mode timed out')), 2000))]);
				} catch (error) {
					if (error?.message?.includes('timed out') && globalThis.app?.workspace?.activeLeaf) {
						return;
					}
					throw error;
				}
			};
			let file = globalThis.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
				if (!file) {
					file = await globalThis.app.vault.create(${JSON.stringify(NOTE_PATH)}, ${JSON.stringify(fixtureContent())});
				}
				// The active workspace leaf can be transiently null during redraw transitions.
				// getLeaf(false) may also return null in some Obsidian states, so we use explicit fallbacks.
				let leaf = globalThis.app.workspace.activeLeaf;
				if (!leaf || leaf.view?.getViewType?.() === 'empty') {
					leaf = globalThis.app.workspace.getLeaf('tab') ?? globalThis.app.workspace.getLeaf(true);
				}
			if (!leaf || !leaf.setViewState || !leaf.openFile) {
				throw new Error('Unable to acquire a valid workspace leaf');
			}
			await bounded(leaf.openFile(file, { active: true }));
			await bounded(leaf.setViewState({ type: 'markdown', state: ${JSON.stringify(state)}, active: true }, { history: false }));
			globalThis.app.workspace.setActiveLeaf?.(leaf, { focus: true });
			for (const element of document.querySelectorAll('.view-content, .cm-scroller, .cm-editor, .markdown-preview-view')) {
				element.scrollTop = 0;
				element.scrollLeft = 0;
			}
			await new Promise(resolve => setTimeout(resolve, 450));
			return leaf.view?.getState?.() ?? null;
		})()`,
	);
}

async function collectState(client) {
	return evaluate(
		client,
		`(() => {
			window.__shikiRedrawVerifierHostIds ??= new WeakMap();
			window.__shikiRedrawVerifierNextHostId ??= 1;
			const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const blocks = [...root.querySelectorAll('.shiki-live-preview-block')];
			const block = blocks[0] ?? null;
			const tokenSpans = block ? [...block.querySelectorAll('[style*="color:"]')] : [];
			const hasLineNumbers = block ? !!block.querySelector('.shiki-line-numbers') : false;
			const hasHeader = block ? !!block.querySelector('.shiki-block-header') : false;
			const hasScrollContainer = block ? !!block.querySelector('.shiki-code-scroll') : false;
			if (block && !window.__shikiRedrawVerifierHostIds.has(block)) {
				window.__shikiRedrawVerifierHostIds.set(block, window.__shikiRedrawVerifierNextHostId++);
			}
			const blockRect = block?.getBoundingClientRect?.() ?? null;
			const rawRows = [...root.querySelectorAll('.shiki-editing-codeblock-line[data-shiki-editing-block-id]')];
			const visibleRawRows = rawRows.filter(row => {
				const rect = row.getBoundingClientRect();
				const style = getComputedStyle(row);
				return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
					&& !row.classList.contains('shiki-editing-codeblock-line-hidden');
			});
			const noteScrollers = [...root.querySelectorAll('.view-content, .cm-scroller, .cm-editor, .markdown-source-view')].map(element => ({
				className: element.className,
				scrollLeft: element.scrollLeft,
				scrollTop: element.scrollTop,
			}));
			const plugin = globalThis.app?.plugins?.plugins?.['advanced-code-block'];
			const settings = plugin ? { showLineNumbers: plugin.loadedSettings?.showLineNumbers } : null;
			return {
				activeFile: globalThis.app?.workspace?.getActiveFile?.()?.path ?? null,
				isMobile: globalThis.app?.isMobile ?? false,
				blocks: blocks.length,
				blockId: block ? window.__shikiRedrawVerifierHostIds.get(block) : null,
				blockRect: blockRect ? {
					left: blockRect.left,
					top: blockRect.top,
					width: blockRect.width,
					height: blockRect.height,
					bottom: blockRect.bottom,
				} : null,
				tokenSpans: tokenSpans.length,
				hasLineNumbers,
				hasHeader,
				hasScrollContainer,
				visibleRawRows: visibleRawRows.length,
				settings,
				noteScrollLeft: Math.max(0, ...noteScrollers.map(scroller => scroller.scrollLeft ?? 0)),
				noteScrollTop: Math.max(0, ...noteScrollers.map(scroller => scroller.scrollTop ?? 0)),
				bodyClass: document.body.className,
			};
		})()`,
	);
}

function assertShikiReady(state, context) {
	assert(state.activeFile === NOTE_PATH, `${context}: fixture note is not active`, state);
	assert(state.blocks === 1, `${context}: expected exactly one Shiki live preview block`, state);
	assert(state.blockRect?.width > 20 && state.blockRect?.height > 20, `${context}: Shiki block has invalid geometry`, state);
	assert(state.tokenSpans > 0, `${context}: Shiki block rendered no token spans`, state);
	if (state.settings?.showLineNumbers !== false) {
		assert(state.hasLineNumbers, `${context}: Shiki block missing line numbers`, state);
	}
	assert(state.hasHeader, `${context}: Shiki block missing header`, state);
	assert(state.hasScrollContainer, `${context}: Shiki block missing scroll container`, state);
	assert(state.visibleRawRows === 0, `${context}: raw CodeMirror code rows are visible after Shiki is ready`, state);
	assert(state.noteScrollLeft === 0, `${context}: note scroller moved horizontally`, state);
}

async function waitForShikiReady(client, context) {
	const deadline = Date.now() + 12_000;
	let lastState;
	while (Date.now() < deadline) {
		lastState = await collectState(client);
		try {
			assertShikiReady(lastState, context);
			return lastState;
		} catch {
			await delay(150);
		}
	}
	assertShikiReady(lastState, context);
	return lastState;
}

async function assertStable(client, context) {
	const samples = [];
	for (let i = 0; i < 12; i++) {
		samples.push(await collectState(client));
		await delay(100);
	}
	for (const sample of samples) {
		assertShikiReady(sample, context);
	}
	const blockIds = new Set(samples.map(sample => sample.blockId));
	assert(blockIds.size === 1, `${context}: Shiki block was recreated during stability sampling`, samples);
	const heights = samples.map(sample => sample.blockRect.height);
	const tops = samples.map(sample => sample.blockRect.top);
	assert(Math.max(...heights) - Math.min(...heights) <= 2, `${context}: Shiki block height is jittering`, samples);
	assert(Math.max(...tops) - Math.min(...tops) <= 2, `${context}: Shiki block top is jittering`, samples);
	return samples.at(-1);
}

async function verifyScroll(client, settings, context) {
	const before = await waitForShikiReady(client, `${context} before scroll`);
	await evaluate(
		client,
		`(() => {
			const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const block = root.querySelector('.shiki-live-preview-block');
			const scrollContainer = block?.querySelector('.shiki-code-scroll');
			if (scrollContainer) scrollContainer.scrollLeft = 280;
			const scroller = [...root.querySelectorAll('.cm-scroller, .view-content, .markdown-source-view')]
				.find(candidate => candidate.scrollHeight > candidate.clientHeight + 20);
			if (scroller) scroller.scrollTop = Math.min(scroller.scrollTop + 260, scroller.scrollHeight - scroller.clientHeight);
			for (const element of root.querySelectorAll('.view-content, .cm-scroller, .cm-editor, .markdown-source-view')) {
				element.scrollLeft = 0;
			}
			return true;
		})()`,
	);
	await delay(300);
	const after = await collectState(client);
	assertShikiReady(after, `${context} after scroll`);
	assert(after.noteScrollLeft === 0, `${context}: note moved horizontally during code scroll`, { before, after, settings });
	if (!settings.wrap) {
		const scrollLeft = await evaluate(client, `(() => document.querySelector('.shiki-live-preview-block .shiki-code-scroll')?.scrollLeft ?? 0)()`);
		assert(scrollLeft > 0, `${context}: Shiki scroll container did not scroll horizontally with wrap off`, { before, after, settings });
	}
	assert(after.noteScrollTop > 0 || before.noteScrollTop > 0, `${context}: note did not move vertically during vertical scroll`, { before, after });
}

async function captureScreenshot(client, filename) {
	const result = await withTimeout(
		client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
		10_000,
		`Timed out capturing screenshot ${filename}`,
	);
	const target = path.join(REPORT_DIR, filename);
	await writeFile(target, Buffer.from(result.data, 'base64'));
	return target;
}

async function run() {
	await mkdir(REPORT_DIR, { recursive: true });
	const client = await connectToExistingObsidian(PORT);
	const checks = [];
	const screenshots = [];
	let originalSettings;
	try {
		await waitForPlugin(client);
		const setup = await setupFixture(client);
		originalSettings = setup.originalSettings;
		for (const viewport of VIEWPORTS) {
			await setViewport(client, viewport);
			for (const settings of SETTINGS_MATRIX) {
				await applySettings(client, settings);
				for (let iteration = 0; iteration < 5; iteration++) {
					const prefix = `${viewport.name} wrap:${settings.wrap ? 'on' : 'off'} lines:${settings.lineNumbers ? 'on' : 'off'} iteration:${iteration + 1}`;
					await openMode(client, 'source');
					await openMode(client, 'live-preview');
					const sourceState = await waitForShikiReady(client, `${prefix} source-to-live-preview`);
					await assertStable(client, `${prefix} source-to-live-preview stable`);
					await openMode(client, 'reading');
					await openMode(client, 'live-preview');
					const readingState = await waitForShikiReady(client, `${prefix} reading-to-live-preview`);
					const stableState = await assertStable(client, `${prefix} reading-to-live-preview stable`);
					checks.push({ viewport: viewport.name, settings, iteration: iteration + 1, sourceState, readingState, stableState });
				}
				await verifyScroll(client, settings, `${viewport.name} wrap:${settings.wrap ? 'on' : 'off'} lines:${settings.lineNumbers ? 'on' : 'off'}`);
				screenshots.push(
					await captureScreenshot(client, `${viewport.name}-wrap-${settings.wrap ? 'on' : 'off'}-lines-${settings.lineNumbers ? 'on' : 'off'}.png`),
				);
			}
		}
		await writeFile(path.join(REPORT_DIR, 'report.json'), JSON.stringify({ checks, screenshots }, null, 2));
		console.log(JSON.stringify({ reportDir: REPORT_DIR, checks: checks.length, screenshots }, null, 2));
	} finally {
		if (originalSettings) {
			await restoreSettings(client, originalSettings).catch(error => console.error(`Failed to restore plugin settings: ${error.message}`));
		}
		await evaluate(client, 'globalThis.app?.emulateMobile?.(false); true').catch(() => undefined);
		await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
		client.close();
	}
}

run().catch(error => {
	console.error(`verify:obsidian-advanced-codeblock-redraw-loop failed: ${error?.message ?? error}`);
	process.exitCode = 1;
});
