import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repo = '/Users/rudironsoni/src/github/rudironsoni/obsidian-shiki-plugin';
const obsidian = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const port = Number(process.env.OBSIDIAN_DEBUG_PORT ?? 9230);
const root = '/private/tmp/obsidian-shiki-visual-scroll';
const vault = path.join(root, 'vault');
const userData = path.join(root, 'user-data');
const report = path.join(repo, 'planning/test-reports/mobile-scroll-visual');
const pluginDir = path.join(vault, '.obsidian/plugins/shiki-highlighter');

function resetDir(dir) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
	return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

async function waitForJson() {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		try {
			const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
			const page =
				targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && /obsidian/i.test(`${t.title} ${t.url}`)) ??
				targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
			if (page) return page;
		} catch {
			// Obsidian is still starting.
		}
		await sleep(250);
	}
	throw new Error('Timed out waiting for Obsidian CDP target');
}

async function waitForBrowserWs() {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		try {
			const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
			if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
		} catch {
			// Obsidian is still starting.
		}
		await sleep(250);
	}
	throw new Error('Timed out waiting for Obsidian browser CDP endpoint');
}

async function connect(wsUrl) {
	wsUrl = wsUrl.replace('ws://localhost:', 'ws://127.0.0.1:');
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', event => reject(new Error(`Unable to connect CDP websocket ${wsUrl}: ${event.message ?? event.type}`)), { once: true });
	});
	let id = 0;
	const pending = new Map();
	ws.addEventListener('message', event => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error && msg.error.message === 'Execution context was destroyed.') resolve({ protocolError: msg.error });
			else if (msg.error) reject(new Error(JSON.stringify(msg.error)));
			else resolve(msg.result);
		}
	});
	return {
		send(method, params = {}, sessionId) {
			const messageId = ++id;
			ws.send(JSON.stringify({ id: messageId, method, params, sessionId }));
			return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
		},
		close() {
			ws.close();
		},
	};
}

async function evaluate(cdp, expression, awaitPromise = true) {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const result = await cdp.send('Runtime.evaluate', {
				expression,
				awaitPromise,
				returnByValue: true,
			});
			if (result.protocolError) throw new Error(JSON.stringify(result.protocolError));
			if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
			return result.result.value;
		} catch (error) {
			const message = typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error));
			if (!message.includes('Execution context was destroyed') || attempt === 9) throw error;
			await sleep(1000);
		}
	}
}

async function attachToObsidianRenderer() {
	const browserWs = await waitForBrowserWs();
	const browser = await connect(browserWs);
	const targets = await browser.send('Target.getTargets');
	writeFileSync(path.join(report, 'browser-targets.json'), JSON.stringify(targets, null, '\t'));
	const target =
		targets.targetInfos.find(t => /app:\/\/obsidian|obsidian/i.test(`${t.title} ${t.url}`) && !/devtools/i.test(`${t.title} ${t.url}`)) ??
		targets.targetInfos.find(t => t.type === 'page' && !/devtools/i.test(`${t.title} ${t.url}`));
	if (!target) throw new Error(`Unable to find Obsidian renderer target: ${JSON.stringify(targets.targetInfos)}`);
	const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
	return {
		send(method, params = {}) {
			return browser.send(method, params, sessionId);
		},
		close() {
			browser.close();
		},
		target,
	};
}

async function screenshot(cdp, name) {
	const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
	writeFileSync(path.join(report, name), Buffer.from(result.data, 'base64'));
}

function mark(step) {
	writeFileSync(path.join(report, 'progress.txt'), step);
}

resetDir(root);
resetDir(report);
mkdirSync(userData, { recursive: true });
mkdirSync(pluginDir, { recursive: true });
for (const file of ['main.js', 'styles.css', 'manifest.json', 'modern-monaco.js']) {
	cpSync(path.join(repo, 'dist', file), path.join(pluginDir, file));
}
mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
writeFileSync(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify(['shiki-highlighter'], null, '\t'));
writeFileSync(path.join(vault, '.obsidian/app.json'), JSON.stringify({ livePreview: true }, null, '\t'));
writeFileSync(
	path.join(vault, '.obsidian/workspace.json'),
	JSON.stringify(
		{
			main: {
				id: 'main',
				type: 'split',
				children: [
					{
						id: 'tabs',
						type: 'tabs',
						children: [
							{
								id: 'scroll-test-leaf',
								type: 'leaf',
								state: {
									type: 'markdown',
									state: {
										file: 'Scroll Test.md',
										mode: 'source',
										source: false,
									},
									icon: 'lucide-file',
									title: 'Scroll Test',
								},
							},
						],
					},
				],
				direction: 'vertical',
			},
			left: { id: 'left', type: 'split', children: [], direction: 'horizontal', width: 300, collapsed: true },
			right: { id: 'right', type: 'split', children: [], direction: 'horizontal', width: 300, collapsed: true },
			leftRibbon: { hiddenItems: {} },
			active: 'scroll-test-leaf',
			lastOpenFiles: ['Scroll Test.md'],
		},
		null,
		'\t',
	),
);
writeFileSync(
	path.join(userData, 'obsidian.json'),
	JSON.stringify(
		{
			vaults: {
				visualScrollVault: {
					path: vault,
					ts: Date.now(),
					open: true,
				},
			},
		},
		null,
		'\t',
	),
);
writeFileSync(path.join(userData, 'visualScrollVault.json'), JSON.stringify({}, null, '\t'));

const longLine = 'print("LEFT_EDGE__' + 'a'.repeat(90) + '__CENTER_MARK__' + 'b'.repeat(90) + '__RIGHT_EDGE")';
const noteContent = `# Scroll Test

Below is an overflowing code block.

\`\`\`python
${longLine}
${longLine}
${longLine}
\`\`\`
`;
writeFileSync(path.join(vault, 'Scroll Test.md'), noteContent);

const proc = spawn(obsidian, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, vault], {
	stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
proc.stdout.on('data', chunk => (output += chunk.toString()));
proc.stderr.on('data', chunk => (output += chunk.toString()));

let cdp;
try {
	async function reattach() {
		cdp?.close();
		await sleep(3000);
		cdp = await attachToObsidianRenderer();
		await cdp.send('Runtime.enable');
		await cdp.send('Page.enable');
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width: 390,
			height: 844,
			deviceScaleFactor: 2,
			mobile: false,
		});
		await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	}
	async function evaluateWithReattach(expression, awaitPromise = true) {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await withTimeout(evaluate(cdp, expression, awaitPromise), 7000, 'Runtime.evaluate');
			} catch (error) {
				const message = String(error?.message);
				if (!(message.includes('Execution context was destroyed') || message.includes('timed out')) || attempt === 4) throw error;
				await reattach();
			}
		}
	}
	mark('attach');
	cdp = await attachToObsidianRenderer();
	await sleep(10000);
	mark('runtime-enable');
	await cdp.send('Runtime.enable');
	mark('page-enable');
	await cdp.send('Page.enable');
	mark('device-metrics');
	await cdp.send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 2,
		mobile: false,
	});
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	mark('wait-app-ready');
	let appReady = false;
	for (let i = 0; i < 120; i++) {
		appReady = await evaluate(cdp, '!!window.app?.workspace', false).catch(() => false);
		if (appReady) break;
		await sleep(250);
	}
	if (!appReady) {
		const targets = await fetch(`http://127.0.0.1:${port}/json`)
			.then(r => r.json())
			.catch(error => ({ error: error.message }));
		writeFileSync(path.join(report, 'cdp-targets.json'), JSON.stringify(targets, null, '\t'));
		throw new Error('Timed out waiting for window.app.workspace');
	}
	const trustButton = await evaluateWithReattach(
		`(() => {
			const button = Array.from(document.querySelectorAll('button')).find(button => button.innerText.trim() === 'Trust author and enable plugins');
			if (!button) return null;
			const rect = button.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		})()`,
		false,
	);
	if (trustButton) {
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: Math.round(trustButton.x),
			y: Math.round(trustButton.y),
			button: 'left',
			clickCount: 1,
		});
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: Math.round(trustButton.x),
			y: Math.round(trustButton.y),
			button: 'left',
			clickCount: 1,
		});
		await sleep(1500);
	}
	await evaluateWithReattach(
		`(() => {
			window.app.setting?.close?.();
			document.querySelector('.modal-close-button')?.click();
			document.querySelector('.modal.mod-settings .modal-close-button')?.click();
			return !document.querySelector('.modal');
		})()`,
		false,
	);
	await sleep(500);
	mark('open-note');
	const createNoteButton = await evaluateWithReattach(
		`(() => {
		const button = Array.from(document.querySelectorAll('button, .clickable-icon, .empty-state-action, [role="button"], div, span')).find(element => {
			const rect = element.getBoundingClientRect();
			return element.innerText?.trim() === 'Create new note' && rect.width > 0 && rect.height > 0;
		});
		if (!button) return null;
		const rect = button.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: button.innerText.trim() };
	})()`,
		false,
	);
	const activeEditorBeforeClick = await evaluateWithReattach(
		`(() => ({
		activeFile: window.app.workspace.getActiveFile()?.path ?? null,
		hasEditor: !!window.app.workspace.activeLeaf?.view?.editor,
		bodyText: document.body.innerText.slice(0, 500),
	}))()`,
		false,
	);
	if (!createNoteButton && !activeEditorBeforeClick.hasEditor) {
		const newTabState = await evaluateWithReattach(
			`(() => ({
			bodyText: document.body.innerText,
			candidates: Array.from(document.querySelectorAll('button, .clickable-icon, .empty-state-action, [role="button"], div, span'))
				.map(element => {
					const rect = element.getBoundingClientRect();
					return { text: element.innerText?.trim() ?? element.textContent?.trim() ?? '', tag: element.tagName, className: element.className, width: rect.width, height: rect.height };
				})
				.filter(item => item.text || item.width > 0 || item.height > 0)
				.slice(0, 80),
		}))()`,
			false,
		);
		writeFileSync(path.join(report, 'new-tab-state.json'), JSON.stringify(newTabState, null, '\t'));
		throw new Error('Create new note button was not visible');
	}
	if (createNoteButton) {
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: Math.round(createNoteButton.x),
			y: Math.round(createNoteButton.y),
			button: 'left',
			clickCount: 1,
		});
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: Math.round(createNoteButton.x),
			y: Math.round(createNoteButton.y),
			button: 'left',
			clickCount: 1,
		});
		await sleep(1500);
	}
	await evaluateWithReattach(
		`(async () => {
		window.app.plugins.setEnable(true);
		await window.app.plugins.loadPlugin('shiki-highlighter');
		await new Promise(resolve => {
			window.app.workspace.onLayoutReady(resolve);
			setTimeout(resolve, 3000);
		});
		const view = window.app.workspace.activeLeaf?.view;
		if (!view?.editor) {
			throw new Error('No active markdown editor after clicking Create new note');
		}
		view.editor.setValue(${JSON.stringify(noteContent)});
		view.editor.refresh?.();
		window.__visualOpenResult = {
			command: 'click-create-new-note',
			file: window.app.workspace.getActiveFile()?.path ?? null,
			viewType: view.getViewType?.() ?? null,
			hasEditor: true,
		};
		document.body.classList.add('is-mobile');
		return window.__visualOpenResult;
	})()`,
	);
	if (false) {
		try {
			await evaluateWithReattach(
				`(async () => {
			window.app.plugins.setEnable(true);
			await window.app.plugins.loadPlugin('shiki-highlighter');
			await new Promise(resolve => {
				window.app.workspace.onLayoutReady(resolve);
				setTimeout(resolve, 3000);
			});
			const file = window.app.vault.getAbstractFileByPath('Scroll Test.md');
			if (!file) throw new Error('Scroll Test.md missing');
			window.__visualOpenResult = { restoredFile: window.app.workspace.getActiveFile()?.path ?? null, hasFile: true };
			document.body.classList.add('is-mobile');
			return { isMobile: window.app.isMobile, file: window.app.workspace.getActiveFile()?.path };
		})()`,
			);
		} catch (error) {
			if (!String(error?.message).includes('Execution context was destroyed')) throw error;
			cdp.close();
			await sleep(3000);
			cdp = await attachToObsidianRenderer();
			await cdp.send('Runtime.enable');
			await cdp.send('Page.enable');
			await cdp.send('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 844,
				deviceScaleFactor: 2,
				mobile: false,
			});
			await evaluateWithReattach(
				`(async () => {
				window.app.plugins.setEnable(true);
				await window.app.plugins.loadPlugin('shiki-highlighter');
				await new Promise(resolve => {
					window.app.workspace.onLayoutReady(resolve);
					setTimeout(resolve, 3000);
				});
				const file = window.app.vault.getAbstractFileByPath('Scroll Test.md');
				if (!file) throw new Error('Scroll Test.md missing');
				window.__visualOpenResult = { restoredFile: window.app.workspace.getActiveFile()?.path ?? null, hasFile: true };
				document.body.classList.add('is-mobile');
				return { isMobile: window.app.isMobile, file: window.app.workspace.getActiveFile()?.path };
			})()`,
			);
		}
	}
	for (let i = 0; i < 40; i++) {
		const activeFile = await evaluate(cdp, `window.app.workspace.getActiveFile()?.path ?? null`, false).catch(() => null);
		if (activeFile) break;
		await sleep(250);
	}
	const activeFile = await evaluate(cdp, `window.app.workspace.getActiveFile()?.path ?? null`, false).catch(() => null);
	if (!activeFile) {
		const state = await evaluate(
			cdp,
			`(() => ({
				activeFile: window.app.workspace.getActiveFile()?.path ?? null,
				vaultName: window.app.vault.getName(),
				basePath: window.app.vault.adapter.basePath,
				hasFile: !!window.app.vault.getAbstractFileByPath('Scroll Test.md'),
				leafCount: window.app.workspace.getLeavesOfType('markdown').length,
				openResult: window.__visualOpenResult ?? null,
				pluginsEnabled: window.app.plugins.enabled,
				pluginLoaded: !!window.app.plugins.plugins['shiki-highlighter'],
				bodyText: document.body.innerText.slice(0, 500),
			}))()`,
			false,
		).catch(error => ({ error: error.message }));
		writeFileSync(path.join(report, 'open-state.json'), JSON.stringify(state, null, '\t'));
		throw new Error(`No active file opened for visual scroll test. Active file: ${activeFile}`);
	}
	await evaluate(
		cdp,
		`(async () => {
			const view = window.app.workspace.activeLeaf?.view;
			if (typeof view?.setMode === 'function') {
				await view.setMode(view.previewMode ?? 'preview');
				return true;
			}
			const leaf = window.app.workspace.activeLeaf;
			const state = leaf?.getViewState?.();
			if (leaf?.setViewState && state?.type === 'markdown') {
				await leaf.setViewState({ ...state, state: { ...(state.state ?? {}), mode: 'source', source: false } });
			}
			return true;
		})()`,
	);
	await sleep(1500);
	await cdp.send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 2,
		mobile: true,
	});
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await evaluate(cdp, `document.body.classList.add('is-mobile'); true`, false);
	const before = await evaluate(
		cdp,
		`(() => {
			const candidates = [...document.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')];
			const usable = candidates
				.map((candidate) => {
					const rect = candidate.getBoundingClientRect();
					const editor = candidate._monacoEditor;
					const layoutWidth = editor?.getLayoutInfo?.()?.width ?? candidate.clientWidth;
					const scrollWidth = editor?.getScrollWidth?.() ?? candidate.scrollWidth;
					const modelText = editor?.getModel?.()?.getValue?.() ?? candidate.innerText ?? '';
					return { candidate, rect, editor, layoutWidth, scrollWidth, modelText };
				})
				.filter((entry) => entry.rect.width > 20 && entry.rect.height > 20 && entry.editor && entry.scrollWidth > entry.layoutWidth + 8);
			const pre = usable.find((entry) => /very_long|horizontal|scroll/i.test(entry.modelText))?.candidate ?? usable[0]?.candidate;
			if (!pre) {
				return {
					missing: true,
					candidateCount: candidates.length,
					candidates: candidates.map((candidate) => {
						const rect = candidate.getBoundingClientRect();
						return {
							className: candidate.className,
							rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
							hasEditor: Boolean(candidate._monacoEditor),
							text: candidate.innerText?.slice(0, 120) ?? '',
						};
					}),
					html: document.body.innerText.slice(0, 500),
				};
			}
			for (const candidate of candidates) candidate.removeAttribute('data-shiki-mobile-visual-target');
			pre.setAttribute('data-shiki-mobile-visual-target', 'true');
			pre._monacoEditor?.setScrollLeft?.(0);
			pre.scrollLeft = 0;
			pre.scrollIntoView({ block: 'center', inline: 'nearest' });
			const rect = pre.getBoundingClientRect();
			const styles = getComputedStyle(pre);
			const codeStyles = getComputedStyle(pre.querySelector('code') ?? pre);
			return {
				missing: false,
				scrollLeft: pre._monacoEditor?.getScrollLeft?.() ?? pre.scrollLeft,
				scrollWidth: pre._monacoEditor?.getScrollWidth?.() ?? pre.scrollWidth,
				clientWidth: pre._monacoEditor?.getLayoutInfo?.()?.width ?? pre.clientWidth,
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
				pre: { overflowX: styles.overflowX, whiteSpace: styles.whiteSpace, webkitOverflowScrolling: styles.webkitOverflowScrolling },
				code: { display: codeStyles.display, minWidth: codeStyles.minWidth, flexBasis: codeStyles.flexBasis },
				text: pre.innerText.slice(0, 120),
			};
		})()`,
	);
	if (before.missing) throw new Error(`No rendered Monaco code block surface found: ${JSON.stringify(before)}`);
	await screenshot(cdp, '01-before.png');
	const x1 = Math.floor(before.rect.x + before.rect.width - 30);
	const x2 = Math.floor(before.rect.x + 40);
	const y = Math.floor(before.rect.y + Math.min(before.rect.height - 12, Math.max(20, before.rect.height / 2)));
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: x1, y, radiusX: 2, radiusY: 2, force: 1 }],
	});
	for (const x of [x1 - 80, x1 - 160, x1 - 240, x2]) {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }],
		});
		await sleep(80);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await sleep(500);
	const afterTouch = await evaluate(
		cdp,
		`(() => {
			const pre = document.querySelector('[data-shiki-mobile-visual-target="true"]');
			const line = document.elementFromPoint(${Math.floor(before.rect.x + before.rect.width - 20)}, ${y})?.textContent?.slice(0, 120);
			return { scrollLeft: pre?._monacoEditor?.getScrollLeft?.() ?? pre?.scrollLeft ?? null, line };
		})()`,
	);
	await screenshot(cdp, '02-after-touch-drag.png');
	await cdp.send('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x: Math.floor(before.rect.x + before.rect.width / 2),
		y,
		deltaX: 700,
		deltaY: 0,
	});
	await sleep(500);
	const afterWheel = await evaluate(
		cdp,
		`(() => {
			const pre = document.querySelector('[data-shiki-mobile-visual-target="true"]');
			return { scrollLeft: pre?._monacoEditor?.getScrollLeft?.() ?? pre?.scrollLeft ?? null };
		})()`,
	);
	await screenshot(cdp, '03-after-wheel.png');
	const summary = { before, afterTouch, afterWheel, report };
	if ((afterTouch.scrollLeft ?? 0) <= 0 && (afterWheel.scrollLeft ?? 0) <= 0) {
		throw new Error(`Visual scroll test did not move the code block: ${JSON.stringify(summary)}`);
	}
	if (before.line === afterTouch.line && before.line === afterWheel.line) {
		throw new Error(`Visual scroll test did not change the visible code text: ${JSON.stringify(summary)}`);
	}
	writeFileSync(path.join(report, 'summary.json'), JSON.stringify(summary, null, '\t'));
	console.log(JSON.stringify(summary, null, '\t'));
} catch (error) {
	writeFileSync(
		path.join(report, 'failure.json'),
		JSON.stringify(
			{
				message: error?.message,
				stack: error?.stack,
				output,
			},
			null,
			'\t',
		),
	);
	throw error;
} finally {
	try {
		await evaluate(cdp, 'window.app.quit()', false);
	} catch {
		// The window.app may already be closed or not connected.
	}
	cdp?.close();
	proc.kill();
	await sleep(500);
	if (!proc.killed) proc.kill('SIGKILL');
	if (output.trim()) writeFileSync(path.join(report, 'obsidian-output.log'), output);
}
