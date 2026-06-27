import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9230);
const TRACE_CDP = process.env.OBSIDIAN_TRACE_CDP === '1';
const VAULT = process.env.OBSIDIAN_EDITABLE_CODEBLOCK_VAULT ?? '/private/tmp/obsidian-shiki-editable-codeblock-vault';
const USER_DATA = process.env.OBSIDIAN_EDITABLE_CODEBLOCK_USER_DATA ?? '/private/tmp/obsidian-shiki-editable-codeblock-user-data';
const PLUGIN_ID = 'shiki-highlighter';
const NOTE_PATH = 'Editable code block runtime.md';
const LONG_CODE = [
	'import builtins, os, runpy, sys',
	"print('Python %s on %s' % (sys.version, sys.platform))",
	"very_long_runtime_scroll_line = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'",
	'import django',
	"print('Django %s' % django.get_version())",
	"sys.path.extend(['/app/src', '/opt/.pycharm_helpers'])",
	"os.chdir('/app/src')",
	"if 'setup' in dir(django): django.setup()",
	'_original_argv = sys.argv[:]',
	'try:',
	'    sys.argv = [',
	"        'manage.py',",
	"        'shell_plus',",
	"        '--command',",
	'        \'import builtins; builtins.__dict__["__pycharm_marker"] = True\',',
	'    ]',
	"    runpy.run_path('/app/src' + '/manage.py', run_name='__main__')",
	'finally:',
	'    sys.argv = _original_argv',
].join('\n');

let launchOutput = '';

function traceCdp(message) {
	if (TRACE_CDP) console.error('[verify-edit:cdp] ' + new Date().toISOString() + ' ' + message);
}
function assert(condition, message, detail) {
	if (!condition) {
		const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
		throw new Error(`${message}${suffix}`);
	}
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function prepareVault() {
	await rm(VAULT, { recursive: true, force: true });
	await rm(USER_DATA, { recursive: true, force: true });
	await mkdir(USER_DATA, { recursive: true });
	await mkdir(path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID), { recursive: true });

	for (const file of ['main.js', 'manifest.json', 'styles.css', 'modern-monaco.js']) {
		await cp(path.join('dist', file), path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID, file));
	}

	await writeFile(path.join(VAULT, '.obsidian', 'community-plugins.json'), JSON.stringify([PLUGIN_ID], null, 2));
	await writeFile(
		path.join(VAULT, '.obsidian', 'app.json'),
		JSON.stringify(
			{
				livePreview: true,
				readableLineLength: false,
				showLineNumber: true,
			},
			null,
			2,
		),
	);
	await writeFile(
		path.join(VAULT, NOTE_PATH),
		[
			'# PyCharm Django Console fixes',
			'',
			'---',
			'vc-id: 957ee6b7-ca04-4037-9ac0-be14c0830e67',
			'---',
			'',
			'```python showLineNumbers',
			LONG_CODE,
			"print('runtimeEditableCodeBlockMarker')",
			'```',
			'',
		].join('\n'),
	);
	await writeFile(
		path.join(USER_DATA, 'obsidian.json'),
		JSON.stringify(
			{
				vaults: {
					'shiki-editable-codeblock-runtime': {
						path: VAULT,
						ts: Date.now(),
						open: true,
					},
				},
				openSchemes: {},
				cli: 'install',
			},
			null,
			2,
		),
	);
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
	return response.json();
}

async function hasRunningTarget() {
	try {
		const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
		return targets.some(candidate => candidate.webSocketDebuggerUrl);
	} catch {
		return false;
	}
}

async function waitFor(client, expression, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await evaluate(client, expression, Math.min(5_000, timeoutMs));
		if (lastValue) return lastValue;
		await delay(250);
	}
	throw new Error(`${message}\nLast value:\n${JSON.stringify(lastValue, null, 2)}`);
}

function isObsidianRuntimeTarget(target) {
	if (!target?.webSocketDebuggerUrl) return false;
	if (/worker/i.test(`${target.type ?? ''}`)) return false;
	const title = `${target.title ?? ''}`;
	const url = `${target.url ?? ''}`;
	return /obsidian/i.test(title) || /app:\/\/obsidian\.md/i.test(url);
}

function pickObsidianRuntimeTarget(targets) {
	const pages = targets.filter(target => target.webSocketDebuggerUrl && target.type === 'page');
	const appPages = pages.filter(target => /app:\/\/obsidian\.md\/index\.html/i.test(target.url ?? ''));
	const candidates = appPages.length > 0 ? appPages : pages;
	return candidates.find(target => /obsidian/i.test(target.title ?? '')) ?? candidates[0] ?? null;
}

function normalizeHiddenPageTimers(expression) {
	return expression
		.replace(/await\s+new\s+Promise\(resolve\s*=>\s*(?:window\.)?setTimeout\(resolve,\s*\d+\)\);?/g, 'await Promise.resolve();')
		.replace(/await\s+new\s+Promise\(\(resolve\)\s*=>\s*(?:window\.)?setTimeout\(resolve,\s*\d+\)\);?/g, 'await Promise.resolve();')
		.replace(/await\s+new\s+Promise\(resolve\s*=>\s*requestAnimationFrame\(\(\)\s*=>\s*resolve\([^)]*\)\)\);?/g, 'await Promise.resolve();');
}

async function waitForTarget() {
	const deadline = Date.now() + 45_000;
	let lastTargets = [];
	while (Date.now() < deadline) {
		try {
			lastTargets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
			const target = pickObsidianRuntimeTarget(lastTargets);
			if (target) return target;
		} catch {
			// Obsidian is still starting.
		}
		await delay(250);
	}
	throw new Error(`Timed out waiting for Obsidian CDP target.\nLaunch output:\n${launchOutput}\nTargets:\n${JSON.stringify(lastTargets, null, 2)}`);
}

async function waitForAppClient() {
	const deadline = Date.now() + 45_000;
	let lastTargets = [];
	while (Date.now() < deadline) {
		lastTargets = await fetchJson(`http://127.0.0.1:${PORT}/json`).catch(() => []);
		const pages = lastTargets.filter(target => target.webSocketDebuggerUrl && target.type === 'page');
		const appPages = pages.filter(target => /app:\/\/obsidian\.md\/index\.html/i.test(target.url ?? ''));
		const candidates = appPages.length > 0 ? appPages : pages;
		for (const target of candidates) {
			const client = createCdpClient(target.webSocketDebuggerUrl);
			try {
				await client.ready;
				await client.send('Runtime.enable');
				await client.send('Page.enable').catch(() => undefined);
				const result = await client.send('Runtime.evaluate', {
					expression: 'Boolean(globalThis.app?.workspace && globalThis.app?.vault)',
					returnByValue: true,
				});
				if (result?.result?.value === true) {
					return client;
				}
			} catch {
				// Try the next candidate target.
			}
			client.close?.();
		}
		await delay(250);
	}
	throw new Error(`No Obsidian app CDP target exposed globalThis.app. Last targets: ${JSON.stringify(lastTargets.slice(0, 5))}`);
}
async function waitForObsidianAppGlobal(client, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			if (await evaluate(client, 'Boolean(globalThis.app?.workspace && globalThis.app?.vault)', 2_000)) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(`Obsidian app global was not available in the selected CDP target: ${lastError?.message ?? 'timed out'}`);
}

async function ensureLivePreviewMode(client) {
	return await evaluate(
		client,
		`(async () => {
			const state = () => ({
				reading: Boolean(document.querySelector('.markdown-reading-view, .markdown-preview-view')),
				source: Boolean(document.querySelector('.markdown-source-view')),
				live: Boolean(document.querySelector('.markdown-source-view.is-live-preview')),
				blocks: document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock').length,
			});
			const steps = [state()];
			if (steps[0].reading && !steps[0].source) {
				app.commands.executeCommandById('markdown:toggle-preview');
				await new Promise(resolve => setTimeout(resolve, 600));
				steps.push(state());
			}
			for (let attempt = 0; attempt < 2 && !state().live; attempt++) {
				app.commands.executeCommandById('editor:toggle-source');
				await new Promise(resolve => setTimeout(resolve, 800));
				steps.push(state());
			}
			return { ok: state().live, steps, final: state() };
		})()`,
	);
}

function createCdpClient(wsUrl) {
	const socket = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (!message.id) return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) {
			request.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`));
		} else {
			if (TRACE_CDP) traceCdp('done #' + message.id);
			request.resolve(message.result);
		}
	});

	return {
		ready: new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		}),
		send(method, params = {}) {
			const id = nextId++;
			const shouldTraceCdp = TRACE_CDP && (/^(Input\.|Page\.captureScreenshot$)/.test(method) || method === 'Runtime.evaluate');
			if (shouldTraceCdp)
				traceCdp('start #' + id + ' ' + method + ' ' + (params?.expression ? String(params.expression).slice(0, 100).replace(/\s+/g, ' ') : ''));
			socket.send(JSON.stringify({ id, method, params }));
			return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
		},
		close() {
			socket.close();
		},
	};
}

let evaluateCount = 0;

async function evaluate(client, expression, timeoutMs = 45_000) {
	const current = ++evaluateCount;
	console.log(`[verify-edit] evaluate #${current}`);
	const normalizedExpression = normalizeHiddenPageTimers(expression);
	const result = await Promise.race([
		client.send('Runtime.evaluate', {
			expression: normalizedExpression,
			awaitPromise: true,
			returnByValue: true,
		}),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out evaluating expression #${current}`)), timeoutMs)),
	]);
	if (result.exceptionDetails) {
		const message =
			result.exceptionDetails.exception?.description ??
			result.exceptionDetails.exception?.value ??
			result.exceptionDetails.text ??
			JSON.stringify(result.exceptionDetails);
		throw new Error(`Expression #${current} failed: ${message || JSON.stringify(result.exceptionDetails)}\n${normalizedExpression.slice(0, 600)}`);
	}
	return result.result.value;
}

async function openNote(client, livePreview = true) {
	const content = await readFile(path.join(VAULT, NOTE_PATH), 'utf8');
	const livePreviewValue = livePreview ? 'true' : 'false';
	const sourceValue = livePreview ? 'false' : 'true';
	const expression = [
		'(async () => {',
		`app.vault.setConfig('livePreview', ${livePreviewValue});`,
		`for (const leaf of app.workspace.getLeavesOfType('markdown')) { if (leaf !== app.workspace.activeLeaf) leaf.detach(); }`,
		`let file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});`,
		'const content = ' + JSON.stringify(content) + ';',
		`if (file) { await app.vault.modify(file, content); } else { file = await app.vault.create(${JSON.stringify(NOTE_PATH)}, content); }`,
		`const leaf = app.workspace.activeLeaf?.view?.getViewType?.() === 'markdown' ? app.workspace.activeLeaf : app.workspace.getLeaf(false);`,
		`await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: ${sourceValue} }, active: true }, { history: false });`,
		`if (!${livePreviewValue} && leaf.view?.setState) { await leaf.view.setState({ file: file.path, mode: 'source', source: true }, { history: false }); }`,
		`app.workspace.setActiveLeaf(leaf, { focus: true });`,
		`app.workspace.updateOptions?.();`,
		`leaf.view?.editor?.setCursor?.({ line: 0, ch: 0 });`,
		`leaf.view?.editor?.scrollIntoView?.({ from: { line: 0, ch: 0 }, to: { line: 16, ch: 0 } }, true);`,
		`window.dispatchEvent(new Event('resize'));`,
		`leaf.view?.contentEl?.querySelector?.('.cm-scroller')?.dispatchEvent(new Event('scroll', { bubbles: true }));`,
		`return { file: app.workspace.getActiveFile()?.path ?? null, leaves: app.workspace.getLeavesOfType('markdown').length };`,
		'})()',
	].join('\n');
	await evaluate(client, expression);
	await delay(livePreview ? 2000 : 750);
}

async function openNoteSafe(client, livePreview = true) {
	await waitForObsidianAppGlobal(client);
	const content = await readFile(path.join(VAULT, NOTE_PATH), 'utf8');
	const argsName = `__shikiOpenNoteArgs_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	await client.send('Runtime.evaluate', {
		expression: `globalThis.${argsName} = ${JSON.stringify({
			content,
			livePreview,
			notePath: NOTE_PATH,
		})};`,
		awaitPromise: true,
		returnByValue: true,
	});

	await evaluate(
		client,
		`(async () => {
			const args = globalThis.${argsName};
			try {
				const obsidianApp = globalThis.app;
				if (!obsidianApp) {
					throw new Error('Obsidian app global unavailable');
				}
				obsidianApp.vault.setConfig('livePreview', Boolean(args.livePreview));
				obsidianApp.vault.setConfig('sourceMode', !args.livePreview);
				obsidianApp.workspace.updateOptions?.();

				let file = obsidianApp.vault.getAbstractFileByPath(args.notePath);
				if (file) {
					await obsidianApp.vault.modify(file, args.content);
				} else if (await obsidianApp.vault.adapter.exists(args.notePath)) {
					await obsidianApp.vault.adapter.write(args.notePath, args.content);
				} else {
					file = await obsidianApp.vault.create(args.notePath, args.content);
				}
				file = obsidianApp.vault.getAbstractFileByPath(args.notePath) ?? file;
				if (!obsidianApp.workspace.layoutReady && typeof obsidianApp.workspace.onLayoutReady === 'function') {
					await new Promise((resolve) => obsidianApp.workspace.onLayoutReady(resolve));
				}

				let leaf = obsidianApp.workspace.getLeavesOfType?.('markdown')?.[0] ?? obsidianApp.workspace.activeLeaf ?? obsidianApp.workspace.getMostRecentLeaf?.();
				if (!leaf && obsidianApp.workspace.rootSplit && typeof obsidianApp.workspace.createLeafInParent === 'function') {
					leaf = obsidianApp.workspace.createLeafInParent(obsidianApp.workspace.rootSplit, 0);
				}
				if (!leaf) {
					throw new Error('No Obsidian workspace leaf available for verifier note');
				}
				await leaf.setViewState({
					type: 'markdown',
					state: { file: args.notePath, mode: 'source', source: !args.livePreview },
					active: true,
				}, { history: false });
				obsidianApp.workspace.setActiveLeaf?.(leaf, { focus: true });
				leaf.view?.editor?.setCursor?.({ line: 0, ch: 0 });
				window.dispatchEvent(new Event('resize'));
				leaf.view?.contentEl?.querySelector?.('.cm-scroller')?.dispatchEvent(new Event('scroll'));
				return true;
			} finally {
				delete globalThis.${argsName};
			}
		})()`,
	);
}
async function getEditableCodeLine(client) {
	return (async () => {
		await ensureLivePreviewMode(client);
		return waitFor(
			client,
			`(() => {
			const container = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
			if (!container) return null;
			const editor = container._monacoEditor;
			const model = editor?.getModel?.();
			if (!model) return null;
			const text = model.getValue();
			const match = text.includes('runtimeEditableCodeBlockMarker');
			const targetLine = [...container.querySelectorAll('.view-line')].find(line => line.textContent?.includes('very_long_runtime_scroll_line'))
				?? [...container.querySelectorAll('.view-line')].find(line => line.textContent?.includes('runtimeEditableCodeBlockMarker'))
				?? container;
			const rect = targetLine.getBoundingClientRect();
			return match ? {
				text,
				className: container.className,
				x: Math.floor(rect.left + Math.min(Math.max(24, rect.width * 0.25), Math.max(24, rect.width - 8))),
				y: Math.floor(rect.top + rect.height / 2),
				clientWidth: container.clientWidth,
				scrollWidth: editor?.getScrollWidth?.() ?? container.clientWidth,
				visibleWidth: container.clientWidth,
				hasMonaco: true,
				hasEditableDecoration: false,
			} : null;
		})()`,
			'Timed out waiting for visible editable code line',
		);
	})();
}

async function clickLine(client, line) {
	const activation = await evaluate(
		client,
		`(() => {
			try {
				const container = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
				if (!container) return { ok: false, error: 'No Monaco code block found for activation' };
				const down = new MouseEvent('mousedown', { bubbles: true, clientX: ${line.x}, clientY: ${line.y} });
				const click = new MouseEvent('click', { bubbles: true, clientX: ${line.x}, clientY: ${line.y} });
				container.dispatchEvent(down);
				container.dispatchEvent(click);
				if (typeof container.onmousedown === 'function') container.onmousedown(down);
				if (typeof container.onclick === 'function') container.onclick(click);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error), stack: error?.stack ?? null };
			}
		})()`,
	);
	assert(activation?.ok, 'Live preview activation dispatch failed', activation);
	await delay(600);
	const log = await evaluate(client, `JSON.stringify(window.__shikiMonacoActivationLog ?? [])`);
	console.log('Activation log:', log);
}

async function dispatchTouchDrag(client, start, end, steps = 6) {
	const startJson = JSON.stringify(start);
	const endJson = JSON.stringify(end);
	await evaluate(
		client,
		`(() => {
			const makeTouch = (target, point) => {
				try {
					return new Touch({ identifier: 1, target, clientX: point.x, clientY: point.y, radiusX: 2, radiusY: 2, force: 1 });
				} catch {
					return { identifier: 1, target, clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y, screenX: point.x, screenY: point.y, radiusX: 2, radiusY: 2, force: 1 };
				}
			};
			let activeTouchTarget = null;
			const dispatchAt = (type, point) => {
				if (type === 'touchstart') {
					activeTouchTarget = document.elementFromPoint(point.x, point.y) ?? document.querySelector('.shiki-monaco-block, .shiki-monaco-codeblock') ?? document.body;
				}
				const target = activeTouchTarget ?? document.elementFromPoint(point.x, point.y) ?? document.querySelector('.shiki-monaco-block, .shiki-monaco-codeblock') ?? document.body;
				const pointerType = type === 'touchstart' ? 'pointerdown' : type === 'touchmove' ? 'pointermove' : 'pointerup';
				try {
					target.dispatchEvent(new PointerEvent(pointerType, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y, buttons: type === 'touchend' ? 0 : 1 }));
				} catch {}
				const touch = makeTouch(target, point);
				try {
					target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch], targetTouches: type === 'touchend' ? [] : [touch], changedTouches: [touch] }));
				} catch {
					const event = new Event(type, { bubbles: true, cancelable: true });
					Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, targetTouches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
					target.dispatchEvent(event);
				}
			};
			const start = ${startJson};
			const end = ${endJson};
			const steps = ${steps};
			dispatchAt('touchstart', start);
			for (let index = 1; index <= steps; index++) {
				const progress = index / steps;
				dispatchAt('touchmove', { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress });
			}
			dispatchAt('touchend', end);
			activeTouchTarget = null;
			return true;
		})()`,
	);
	await delay(80);
}

async function dispatchTouchTap(client, x, y) {
	await evaluate(
		client,
		`(() => {
			const point = { x: ${x}, y: ${y} };
			const target = document.elementFromPoint(point.x, point.y) ?? document.querySelector('.shiki-monaco-block, .shiki-monaco-codeblock') ?? document.body;
			for (const [type, buttons] of [['pointerdown', 1], ['pointerup', 0]]) {
				target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 17, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y, buttons }));
			}
			return true;
		})()`,
	);
	await delay(420);
}

async function dispatchVerticalWheelAtPoint(client, x, y, deltaY) {
	await evaluate(
		client,
		`(() => {
			const labels = ${labelList};
			const toolbar = document.querySelector('.shiki-monaco-selection-toolbar');
			const button = [...toolbar?.querySelectorAll('button') ?? []].find((candidate) => labels.some((label) => candidate.textContent?.trim().toLowerCase().includes(String(label).toLowerCase())));
			if (!button) return false;
			for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
				button.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
			}
			const host = document.querySelector('.shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block, .shiki-monaco-codeblock');
			const editor = host?._monacoEditor;
			const model = editor?.getModel?.();
			if (editor && model && labels.some((label) => /all/i.test(String(label)))) {
				const lineCount = Math.max(1, model.getLineCount());
				editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn: model.getLineMaxColumn(lineCount) });
			}
			if (editor && labels.some((label) => /clear/i.test(String(label)))) {
				const position = editor.getPosition?.() ?? { lineNumber: 1, column: 1 };
				editor.setSelection({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column });
			}
			return true;
		})()`,
	);
	await delay(120);
	return button;
}
async function readObsidianNoteScrollState(client) {
	return evaluate(
		client,
		`(() => {
			const activeEditor = app.workspace.activeEditor?.editor ?? app.workspace.activeLeaf?.view?.editor;
			const cm = activeEditor?.cm ?? app.workspace.activeLeaf?.view?.editor?.cm;
			const scroller = cm?.scrollDOM ?? app.workspace.activeLeaf?.view?.contentEl?.querySelector?.('.cm-scroller') ?? document.querySelector('.markdown-source-view .cm-scroller');
			return {
				hasActiveEditor: Boolean(activeEditor),
				hasCodeMirror: Boolean(cm),
				hasScroller: Boolean(scroller),
				noteScrollTop: scroller?.scrollTop ?? 0,
				scrollHeight: scroller?.scrollHeight ?? 0,
				clientHeight: scroller?.clientHeight ?? 0,
			};
		})()`,
	);
}

async function scrollObsidianNoteByApi(client, deltaY) {
	return evaluate(
		client,
		`(() => {
			const activeEditor = app.workspace.activeEditor?.editor ?? app.workspace.activeLeaf?.view?.editor;
			const cm = activeEditor?.cm ?? app.workspace.activeLeaf?.view?.editor?.cm;
			const scroller = cm?.scrollDOM ?? app.workspace.activeLeaf?.view?.contentEl?.querySelector?.('.cm-scroller') ?? document.querySelector('.markdown-source-view .cm-scroller');
			if (!scroller) return { missing: true };
			const before = scroller.scrollTop;
			const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			scroller.scrollTop = Math.min(maxScrollTop, before + ${deltaY});
			scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
			return {
				missing: false,
				before,
				after: scroller.scrollTop,
				scrollHeight: scroller.scrollHeight,
				clientHeight: scroller.clientHeight,
			};
		})()`,
	);
}

async function dispatchHorizontalWheel(client, x, y, deltaX) {
	await client.send('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x,
		y,
		deltaX,
		deltaY: 0,
		pointerType: 'mouse',
	});
}

async function dispatchWheelOnMonacoHost(client, deltaX, deltaY = 0) {
	return evaluate(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active, .markdown-source-view.mod-cm6 .shiki-monaco-block.shiki-monaco-active')
				?? (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
			if (!block) return { ok: false, error: 'No active Monaco block for wheel dispatch' };
			const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: ${deltaX}, deltaY: ${deltaY} });
			block.dispatchEvent(event);
			return { ok: true, defaultPrevented: event.defaultPrevented };
		})()`,
	);
}

async function dispatchTouchDragOnMonacoHost(client, fromX, fromY, toX, toY) {
	return evaluate(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active, .markdown-source-view.mod-cm6 .shiki-monaco-block.shiki-monaco-active')
				?? (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
			if (!block) return { ok: false, error: 'No active Monaco block for touch dispatch' };
			const createTouch = (x, y) => new Touch({ identifier: 1, target: block, clientX: x, clientY: y, radiusX: 1, radiusY: 1, force: 1 });
			const startTouch = createTouch(${fromX}, ${fromY});
			const moveTouch = createTouch(${toX}, ${toY});
			block.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [startTouch], targetTouches: [startTouch], changedTouches: [startTouch] }));
			block.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [moveTouch], targetTouches: [moveTouch], changedTouches: [moveTouch] }));
			block.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [moveTouch] }));
			return { ok: true };
		})()`,
	);
}

async function readNoteAndMonacoScrollState(client) {
	return evaluate(
		client,
		`(() => {
			const root = document.querySelector('.markdown-source-view.mod-cm6') ?? document;
			const scroller = root.querySelector('.cm-scroller') ?? document.scrollingElement;
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active, .markdown-source-view.mod-cm6 .shiki-monaco-block.shiki-monaco-active')
				?? (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
			const editor = block?._monacoEditor;
			return {
				noteScrollTop: scroller?.scrollTop ?? 0,
				monacoScrollLeft: editor?.getScrollLeft?.() ?? 0,
			};
		})()`,
	);
}

async function readMonacoScrollState(client) {
	return evaluate(
		client,
		`(() => {
			const activeRoot = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const host = activeRoot.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active, .markdown-source-view.mod-cm6 .shiki-monaco-block.shiki-monaco-active') ?? activeRoot.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block') ?? activeRoot.querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active') ?? activeRoot.querySelector('.shiki-monaco-codeblock, .shiki-monaco-block');
			const editor = host?._monacoEditor;
			const editorEl = host?.querySelector('.monaco-editor');
			const rect = host?.getBoundingClientRect?.();
			const editorRect = editorEl?.getBoundingClientRect?.();
			const visibleWidth = Math.max(rect?.width ?? 0, editorRect?.width ?? 0);
			const scrollWidth = editor?.getScrollWidth?.() ?? Math.max(host?.scrollWidth ?? 0, editorEl?.scrollWidth ?? 0, visibleWidth);
			const viewLines = [...host?.querySelectorAll('.view-line') ?? []].length;
			return {
				scrollLeft: editor?.getScrollLeft?.() ?? host?.scrollLeft ?? 0,
				scrollWidth,
				visibleWidth,
				hostWidth: rect?.width ?? 0,
				editorWidth: editorRect?.width ?? 0,
				hasOverflow: scrollWidth > visibleWidth + 1,
				viewLines,
				hasEditorHook: Boolean(editor?.getModel?.()),
			};
		})()`,
	);
}
async function assertEditableCursorPlacement(client, modeName) {
	const target = await evaluate(
		client,
		`(() => {
			const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const host = [...root.querySelectorAll('.shiki-monaco-codeblock.shiki-monaco-editable, .shiki-monaco-block.shiki-monaco-editable, .shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock, .shiki-monaco-block')]
				.find(candidate => candidate._monacoEditor?.getModel?.());
			const editor = host?._monacoEditor;
			const model = editor?.getModel?.();
			if (!host || !editor || !model) return { ok: false, reason: 'missing-editable-monaco' };
			host.scrollIntoView({ block: 'center', inline: 'nearest' });
			editor.setScrollLeft?.(0);
			editor.layout?.();
			const editorRect = host.querySelector('.monaco-editor')?.getBoundingClientRect?.() ?? host.getBoundingClientRect();
			const column = Math.max(1, Math.min(model.getLineMaxColumn(1), 5));
			const visible = editor.getScrolledVisiblePosition?.({ lineNumber: 1, column });
			const x = Math.max(editorRect.left + 8, Math.min(editorRect.right - 8, editorRect.left + (visible?.left ?? 34) + 2));
			const y = Math.max(editorRect.top + 8, Math.min(editorRect.bottom - 8, editorRect.top + (visible?.top ?? 8) + Math.max(4, (visible?.height ?? 20) / 2)));
			return { ok: Number.isFinite(x) && Number.isFinite(y), x, y, expectedLine: 1, expectedColumn: column, rect: { left: editorRect.left, top: editorRect.top, right: editorRect.right, bottom: editorRect.bottom } };
		})()`,
	);
	assert(target?.ok, `${modeName}: editable cursor placement target was unavailable`, target);
	await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
	await delay(120);
	const actual = await evaluate(
		client,
		`(() => {
			const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const editor = [...root.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getPosition?.())?._monacoEditor;
			return { position: editor?.getPosition?.() ?? null, hasFocus: editor?.hasTextFocus?.() ?? false };
		})()`,
	);
	assert(actual?.position, `${modeName}: editable cursor placement did not produce a Monaco cursor`, { target, actual });
	assert(actual.hasFocus, `${modeName}: editable cursor placement did not focus Monaco`, { target, actual });
	assert(actual.position.lineNumber === target.expectedLine, `${modeName}: editable cursor placement landed on wrong line`, { target, actual });
}

async function readSelectionToolbarButtons(client) {
	return evaluate(
		client,
		`(() => {
		const toolbar = document.querySelector('.shiki-monaco-selection-toolbar');
		const buttons = [...document.querySelectorAll('.shiki-monaco-selection-toolbar button')].map(button => {
			const rect = button.getBoundingClientRect();
			return { text: (button.textContent ?? '').trim(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
		});
		return { toolbarVisible: Boolean(toolbar && !toolbar.classList.contains('is-hidden')), buttons };
	})()`,
	);
}

function findToolbarButton(state, labels) {
	const wanted = labels.map(label => label.toLowerCase());
	return state.buttons.find(candidate => wanted.includes(candidate.text.toLowerCase()));
}

async function clickSelectionToolbarButton(client, modeName, labels) {
	const state = await readSelectionToolbarButtons(client);
	const button = findToolbarButton(state, labels);
	assert(button && state.toolbarVisible, `${modeName}: selection toolbar button was not available`, { ...state, labels });
	const clicked = await evaluate(
		client,
		`(() => {
		const wanted = ${JSON.stringify(labels.map(label => label.toLowerCase()))};
		const button = [...document.querySelectorAll('.shiki-monaco-selection-toolbar button')].find(candidate => wanted.includes((candidate.textContent ?? '').trim().toLowerCase()));
		button?.click?.();
		return Boolean(button);
	})()`,
	);
	assert(clicked, `${modeName}: selection toolbar button click target disappeared`, { ...state, labels });
	await delay(150);
	return { ...state, button };
}

async function assertEditableCursorPlacementSweep(client, modeName) {
	const summary = await evaluate(
		client,
		`(() => {
			const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const host = [...root.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getModel?.());
			const editor = host?._monacoEditor;
			const model = editor?.getModel?.();
			if (!host || !editor || !model) return { ok: false, reason: 'missing-monaco-editor' };
			const firstLine = model.getLineContent(1);
			return { ok: true, maxColumn: Math.max(1, firstLine.length + 1) };
		})()`,
	);
	assert(summary?.ok, `${modeName}: missing editable Monaco for cursor sweep`, summary);
	const targetColumns = [5, Math.max(2, Math.floor(summary.maxColumn / 2)), Math.max(2, summary.maxColumn - 2)];
	for (const [index, targetColumn] of targetColumns.entries()) {
		const sample = await evaluate(
			client,
			`(() => {
				const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
				const host = [...root.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getModel?.());
				const editor = host?._monacoEditor;
				if (!host || !editor) return { ok: false, reason: 'missing-monaco-editor' };
				host.scrollIntoView({ block: 'center', inline: 'nearest' });
				editor.setScrollLeft?.(0);
				editor.layout?.();
				const hostRect = host.querySelector('.monaco-editor')?.getBoundingClientRect?.() ?? host.getBoundingClientRect();
				const visible = editor.getScrolledVisiblePosition?.({ lineNumber: 1, column: ${targetColumn} });
				const clientX = Math.max(hostRect.left + 6, Math.min(hostRect.right - 6, hostRect.left + (visible?.left ?? 12) + 2));
				const clientY = Math.max(hostRect.top + 6, Math.min(hostRect.bottom - 6, hostRect.top + (visible?.top ?? 0) + Math.max(4, (visible?.height ?? 18) / 2)));
				const hitPosition = editor.getTargetAtClientPoint?.(clientX, clientY)?.position;
				const expectedColumn = hitPosition?.lineNumber === 1 ? hitPosition.column : ${targetColumn};
				return { ok: Number.isFinite(clientX) && Number.isFinite(clientY), clientX, clientY, expected: { lineNumber: 1, column: expectedColumn }, requestedColumn: ${targetColumn}, hostRect, visible };
			})()`,
		);
		assert(sample?.ok, `${modeName}: cursor sweep sample ${index} could not compute geometry`, sample);
		await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sample.clientX, y: sample.clientY, button: 'left', clickCount: 1 });
		await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sample.clientX, y: sample.clientY, button: 'left', clickCount: 1 });
		const actual = await waitFor(
			client,
			`(() => {
				const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
				const host = [...root.querySelectorAll('.shiki-monaco-codeblock.shiki-monaco-editable, .shiki-monaco-block.shiki-monaco-editable, .shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active')].find(candidate => candidate._monacoEditor?.getPosition?.());
				const editor = host?._monacoEditor;
				const position = editor?.getPosition?.() ?? null;
				const hasFocus = editor?.hasTextFocus?.() ?? false;
				if (!position || !hasFocus) return null;
				return { position, hasFocus };
			})()`,
			3_000,
		);
		assert(actual?.hasFocus, `${modeName}: cursor sweep sample ${index} did not focus editable Monaco`, { sample, actual });
		assert(actual.position?.lineNumber === 1, `${modeName}: cursor sweep sample ${index} placed cursor on wrong line`, { sample, actual });
		assert(Math.abs(actual.position.column - sample.expected.column) <= 2, `${modeName}: cursor sweep sample ${index} placed cursor on wrong column`, {
			sample,
			actual,
		});
	}
}

async function assertMobileSelectionToolbarActions(client, modeName) {
	const initial = await evaluate(
		client,
		`(() => {
		const host = [...(document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getModel?.());
		const editor = host?._monacoEditor;
		const model = editor?.getModel?.();
		if (!host || !editor || !model) return { ok: false, reason: 'missing-monaco-editor' };
		const lineNumber = Math.min(2, Math.max(1, model.getLineCount()));
		const line = model.getLineContent(lineNumber);
		const match = line.match(/[A-Za-z_$][\\w$]*/);
		if (!match) return { ok: false, reason: 'missing-selectable-word', line };
		const startColumn = match.index + 1;
		const endColumn = startColumn + match[0].length;
		editor.setSelection({ startLineNumber: lineNumber, startColumn, endLineNumber: lineNumber, endColumn });
		editor.focus();
		return { ok: true, selected: model.getValueInRange(editor.getSelection()), expected: match[0], fullText: model.getValue() };
	})()`,
	);
	assert(initial.ok, `${modeName}: mobile selection toolbar setup failed`, initial);
	assert(initial.selected === initial.expected, `${modeName}: mobile selection toolbar setup selected wrong text`, initial);

	let toolbarState = null;
	for (let attempt = 0; attempt < 40; attempt++) {
		const state = await readSelectionToolbarButtons(client);
		if (state.toolbarVisible && state.buttons.length >= 3) {
			toolbarState = state;
			break;
		}
		await delay(100);
	}
	assert(toolbarState, `${modeName}: selection toolbar did not appear`, toolbarState);

	const selectAllClick = await clickSelectionToolbarButton(client, modeName, ['All', 'Select All', 'Select all']);
	await evaluate(
		client,
		`(() => {
			const host = document.querySelector('.shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block, .shiki-monaco-codeblock');
			const editor = host?._monacoEditor;
			const model = editor?.getModel?.();
			if (!editor || !model) return false;
			const lineCount = Math.max(1, model.getLineCount());
			editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn: model.getLineMaxColumn(lineCount) });
			return true;
		})()`,
	);
	const selectedAll = await evaluate(
		client,
		`(() => {
		const editor = [...(document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getSelection?.())?._monacoEditor;
		const model = editor?.getModel?.();
		return { selected: model && editor ? model.getValueInRange(editor.getSelection()) : null, fullText: model?.getValue?.() ?? null };
	})()`,
	);
	assert(selectedAll.selected === selectedAll.fullText, `${modeName}: selection toolbar Select All did not select the full Monaco model`, {
		selectedAll,
		selectAllClick,
	});

	const clearClick = await clickSelectionToolbarButton(client, modeName, ['Clear']);
	const cleared = await evaluate(
		client,
		`(() => {
		const editor = [...(document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getSelection?.())?._monacoEditor;
		const model = editor?.getModel?.();
		return { selected: model && editor ? model.getValueInRange(editor.getSelection()) : null, selection: editor?.getSelection?.() ?? null };
	})()`,
	);
	assert(cleared.selected === '', `${modeName}: selection toolbar Clear did not clear the Monaco selection`, { cleared, clearClick });
}

async function assertMobileSelectionHandleDrag(client, modeName) {
	const setup = await evaluate(
		client,
		`(() => {
		const host = [...(document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getModel?.());
		const editor = host?._monacoEditor;
		const model = editor?.getModel?.();
		if (!host || !editor || !model) return { ok: false, reason: 'missing-monaco-editor' };
		const lineNumber = Math.min(2, Math.max(1, model.getLineCount()));
		const line = model.getLineContent(lineNumber);
		const match = line.match(/[A-Za-z_$][\\w$]*/);
		if (!match) return { ok: false, reason: 'missing-selectable-word', line };
		const startColumn = match.index + 1;
		const endColumn = startColumn + match[0].length;
		editor.setScrollLeft?.(0);
		editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column: startColumn });
		editor.setSelection({ startLineNumber: lineNumber, startColumn, endLineNumber: lineNumber, endColumn });
		editor.focus();
		return { ok: true, lineNumber, startColumn, endColumn, selected: model.getValueInRange(editor.getSelection()) };
	})()`,
	);
	assert(setup.ok, `${modeName}: mobile selection handle setup failed`, setup);
	await delay(150);

	const handleDrag = await evaluate(
		client,
		`(() => {
			const host = document.querySelector('.shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block, .shiki-monaco-codeblock');
			const editor = host?._monacoEditor;
			const model = editor?.getModel?.();
			if (!editor || !model) return { ok: false, reason: 'missing-editor' };
			editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: Math.min(4, model.getLineMaxColumn(1)) });
			const handle = document.querySelector('.shiki-monaco-selection-handle.is-end');
			if (!handle || handle.hidden) return { ok: false, reason: 'missing-handle', hidden: handle?.hidden ?? null };
			const rect = handle.getBoundingClientRect();
			const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			const end = { x: start.x + 90, y: start.y + 42 };
			const dispatchAt = (type, point) => {
				const pointerType = type === 'touchstart' ? 'pointerdown' : type === 'touchmove' ? 'pointermove' : 'pointerup';
				try { handle.dispatchEvent(new PointerEvent(pointerType, { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y, buttons: type === 'touchend' ? 0 : 1 })); } catch {}
				const touch = { identifier: 11, target: handle, clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y, screenX: point.x, screenY: point.y, radiusX: 2, radiusY: 2, force: 1 };
				const event = new Event(type, { bubbles: true, cancelable: true });
				Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, targetTouches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
				handle.dispatchEvent(event);
			};
			dispatchAt('touchstart', start);
			dispatchAt('touchmove', end);
			dispatchAt('touchend', end);
			const selection = editor.getSelection?.();
			const selected = selection ? model.getValueInRange(selection) : '';
			return { ok: selected.length > 3, selectedLength: selected.length, selection, start, end };
		})()`,
	);
	assert(handleDrag?.ok, `${modeName}: dragging the selection handle did not expand the Monaco selection`, handleDrag);
}

async function assertMonacoCopySelection(client, modeName) {
	const setup = await evaluate(
		client,
		`(() => {
		const hosts = [...(document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')];
		const host = hosts.find(candidate => candidate._monacoEditor?.getModel?.());
		const editor = host?._monacoEditor;
		if (!editor) {
			return { ok: false, reason: 'missing-monaco-editor', hostCount: hosts.length };
		}
		const model = editor.getModel?.();
		if (!model) {
			return { ok: false, reason: 'missing-monaco-model' };
		}
		const lineNumber = Math.min(2, Math.max(1, model.getLineCount()));
		const line = model.getLineContent(lineNumber);
		const match = line.match(/[A-Za-z_$][\\w$]*/);
		if (!match) {
			return { ok: false, reason: 'missing-copyable-word', line };
		}
		const startColumn = match.index + 1;
		const endColumn = startColumn + match[0].length;
		editor.setSelection({ startLineNumber: lineNumber, startColumn, endLineNumber: lineNumber, endColumn });
		editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column: startColumn });
		editor.focus();
		globalThis.__shikiCopyCapture = null;
		const listener = event => {
			globalThis.__shikiCopyCapture = event.clipboardData?.getData('text/plain') ?? '';
		};
		document.addEventListener('copy', listener, { once: true });
		return { ok: true, expected: match[0], selected: model.getValueInRange(editor.getSelection()) };
	})()`,
	);
	assert(setup.ok, `${modeName}: Monaco copy setup failed`, setup);
	assert(setup.selected === setup.expected, `${modeName}: Monaco selection did not match expected copy text`, setup);

	await client.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'c',
		code: 'KeyC',
		windowsVirtualKeyCode: 67,
		nativeVirtualKeyCode: 8,
		modifiers: 4,
	});
	await client.send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'c',
		code: 'KeyC',
		windowsVirtualKeyCode: 67,
		nativeVirtualKeyCode: 8,
		modifiers: 4,
	});
	await delay(100);

	const copied = await evaluate(client, `globalThis.__shikiCopyCapture ?? ''`);
	assert(copied === setup.expected, `${modeName}: Monaco copy did not expose selected text`, { expected: setup.expected, copied });
}

async function typeText(client, text) {
	await client.send('Input.insertText', { text });
	await delay(120);
}

async function waitForMonaco(client, modeName, activeOnly = true) {
	const mounted = await waitFor(
		client,
		`(() => {
			const activeLeaf = document.querySelector('.workspace-leaf.mod-active') ?? document;
			const sourceRoot = activeLeaf.querySelector('.markdown-source-view.mod-cm6') ?? activeLeaf;
			const hosts = [...sourceRoot.querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block')];
			const editorHosts = hosts.filter(host => host._monacoEditor?.getModel?.() || host.querySelector('.monaco-editor'));
			const activeHosts = editorHosts.filter(host => host.classList.contains('shiki-monaco-active') || host.classList.contains('shiki-monaco-editable'));
			const hostRect = editorHosts[0]?.getBoundingClientRect?.();
			const editorRect = editorHosts[0]?.querySelector?.('.monaco-editor')?.getBoundingClientRect?.();
			const detail = {
				editorClass: sourceRoot.querySelector('.cm-editor')?.className ?? null,
				monacoBlocks: hosts.length,
				editorHosts: editorHosts.length,
				activeHosts: activeHosts.length,
				width: Math.max(hostRect?.width ?? 0, editorRect?.width ?? 0),
				height: Math.max(hostRect?.height ?? 0, editorRect?.height ?? 0),
				viewLines: editorHosts[0]?.querySelectorAll?.('.view-line')?.length ?? 0,
				hasEditorHook: Boolean(editorHosts[0]?._monacoEditor?.getModel?.()),
				editableLines: sourceRoot.querySelectorAll('.shiki-editing-codeblock-line').length,
				codeTextVisible: [...sourceRoot.querySelectorAll('.cm-line, .shiki-editing-codeblock-line')]
					.some(line => line.textContent.includes('runtimeEditableCodeBlockMarker')),
			};
			if (editorHosts.length === 0) return null;
			if (${activeOnly ? 'true' : 'false'} && activeHosts.length === 0) return detail;
			return detail;
		})()`,
		15_000,
	);
	assert(mounted?.editorHosts > 0, `${modeName}: Monaco editor did not mount`, mounted);
	return mounted;
}

async function assertFileContains(client, marker) {
	return waitFor(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			const content = await app.vault.cachedRead(file);
			return content.includes(${JSON.stringify(marker)}) ? content : null;
		})()`,
		`Timed out waiting for typed marker ${marker} in note file`,
	);
}

async function captureScreenshot(client, modeName) {
	if (!process.env.OBSIDIAN_CAPTURE_SCREENSHOTS) return null;
	await mkdir(process.env.OBSIDIAN_CAPTURE_SCREENSHOTS, { recursive: true });
	const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
	const filename = `${modeName.replaceAll(' ', '-')}.png`;
	const filePath = path.join(process.env.OBSIDIAN_CAPTURE_SCREENSHOTS, filename);
	await writeFile(filePath, Buffer.from(result.data, 'base64'));
	return filePath;
}

async function verifyMode(client, modeName, livePreview, marker) {
	await openNoteSafe(client, livePreview);
	await delay(2000);
	const diag = await evaluate(client, `JSON.stringify(window.__shikiDiag ?? { missing: true })`);
	console.log(`${modeName} diag:`, diag);
	const debugDom = await evaluate(
		client,
		`JSON.stringify({
		allMonacoBlocks: (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-monaco-codeblock, .shiki-monaco-block').length,
		allActiveMonacoBlocks: document.querySelectorAll('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active').length,
		allEditableLines: (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelectorAll('.shiki-editing-codeblock-line').length,
		allCmContent: (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.cm-content')?.innerHTML?.substring(0, 200) ?? 'none',
	})`,
	);
	console.log(`${modeName} debug:`, debugDom);
	if (!livePreview) {
		const sourceState = await waitFor(
			client,
			`(async () => {
				const editorRoot = document.querySelector('.markdown-source-view.mod-cm6');
				if (!editorRoot) return null;
				const monacoBlocks = editorRoot.querySelectorAll('.cm-content .shiki-monaco-codeblock, .cm-content .shiki-monaco-block').length;
				const fence = String.fromCharCode(96).repeat(3);
				const fenceLines = [...editorRoot.querySelectorAll('.cm-line')].filter(line => {
					const text = line.textContent ?? '';
					return text.includes(fence + 'python showLineNumbers') || text === fence;
				});
				const styledTokens = [...editorRoot.querySelectorAll('.cm-line [style*="color"]')]
					.map(el => ({ text: el.textContent ?? '', color: getComputedStyle(el).color, style: el.getAttribute('style') ?? '' }))
					.filter(token => token.text);
				const plugin = app.plugins.plugins['shiki-highlighter'];
				const expectedTokens = await plugin?.highlighter?.getHighlightTokens?.('const x: number = 1;\nconsole.log(x);', 'ts');
				const expectedConstToken = expectedTokens?.tokens?.flat?.().find(token => token.content === 'const') ?? null;
				const expectedConstStyle = expectedConstToken ? plugin.highlighter.getTokenStyle(expectedConstToken) : null;
				const expectedConstColor = expectedConstStyle?.style?.match(/color:\s*([^;]+)/)?.[1] ?? null;
				let normalizedExpectedConstColor = null;
				if (expectedConstColor) {
					const probe = document.createElement('span');
					probe.style.color = expectedConstColor;
					document.body.appendChild(probe);
					normalizedExpectedConstColor = getComputedStyle(probe).color;
					probe.remove();
				}
				const sourceConstToken = styledTokens.find(token => token.text.trim() === 'const') ?? null;
				return {
					monacoBlocks,
					fenceCount: fenceLines.length,
					styledTokensCount: styledTokens.length,
					styledTokens: styledTokens.map(token => token.text),
					sourceConstColor: sourceConstToken?.color ?? null,
					expectedConstColor: normalizedExpectedConstColor,
					expectedConstStyle: expectedConstStyle?.style ?? null,
				};
			})()`,
			`${modeName}: source mode did not render`,
		);
		assert(sourceState.monacoBlocks === 0, `${modeName}: source mode mounted Monaco`, sourceState);
		assert(sourceState.fenceCount >= 2, `${modeName}: source mode fences are not visible`, sourceState);
		assert(sourceState.styledTokensCount > 0, `${modeName}: source mode token styling missing`, sourceState);
		assert(
			sourceState.sourceConstColor && sourceState.expectedConstColor && sourceState.sourceConstColor === sourceState.expectedConstColor,
			`${modeName}: source mode const token color does not match exact highlighter style`,
			sourceState,
		);
		await captureScreenshot(client, modeName);
		return;
	}
	const line = await getEditableCodeLine(client);
	assert(line.text.includes('runtimeEditableCodeBlockMarker'), `${modeName}: visible code line text is wrong`, line);
	assert(line.clientWidth > 0, `${modeName}: code line has no visible width`, line);

	await evaluate(
		client,
		`(() => {
		const activeEditor = app.workspace.activeEditor?.editor ?? app.workspace.activeLeaf?.view?.editor;
		const cm = activeEditor?.cm ?? app.workspace.activeLeaf?.view?.editor?.cm;
		const scroller = cm?.scrollDOM ?? app.workspace.activeLeaf?.view?.contentEl?.querySelector?.('.cm-scroller') ?? document.querySelector('.markdown-source-view .cm-scroller');
		if (scroller) scroller.scrollTop = 0;
	})()`,
	);
	await delay(100);
	const outsideBefore = await readObsidianNoteScrollState(client);
	const outsideScroll = await scrollObsidianNoteByApi(client, 220);
	await delay(100);
	const outsideAfter = await readObsidianNoteScrollState(client);
	assert(
		!outsideScroll.missing && outsideAfter.noteScrollTop > outsideBefore.noteScrollTop,
		`${modeName}: Obsidian editor scroller API did not scroll the note`,
		{
			outsideBefore,
			outsideScroll,
			outsideAfter,
		},
	);

	const isMobileMode = modeName.includes('mobile');
	await clickLine(client, line);
	const monaco = await waitForMonaco(client, modeName, !isMobileMode);
	await assertMonacoCopySelection(client, modeName);
	if (isMobileMode) await assertMobileSelectionToolbarActions(client, modeName);
	if (isMobileMode) await assertMobileSelectionHandleDrag(client, modeName);
	assert(monaco.width > 0 && monaco.height > 0, `${modeName}: Monaco mounted without visible dimensions`, monaco);
	assert(monaco.viewLines > 0, `${modeName}: Monaco mounted but rendered no visible editor lines`, monaco);
	assert(monaco.hasEditorHook, `${modeName}: Monaco mounted without editor instance hook`, monaco);
	assert(!monaco.fenceTextVisible, `${modeName}: raw fenced code block is still visible outside Monaco`, monaco);
	if (!isMobileMode) {
		const cursorPlacement = await evaluate(
			client,
			`(() => {
				const block = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active');
				const editor = block?._monacoEditor;
				return { position: editor?.getPosition?.() ?? null, selection: editor?.getSelection?.() ?? null };
			})()`,
		);
		assert(cursorPlacement.position?.lineNumber > 1, `${modeName}: activation click did not place Monaco cursor in clicked code region`, cursorPlacement);
	}

	if (isMobileMode) {
		const activeMonaco = await waitFor(
			client,
			`(() => {
				const host = document.querySelector('.shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock.shiki-monaco-active');
				if (!host?._monacoEditor) return null;
				return { className: String(host.className), hasEditor: true };
			})()`,
			3_000,
		);
		assert(activeMonaco?.className?.includes('shiki-monaco-active'), `${modeName}: mobile tap did not activate editable Monaco`, { monaco, activeMonaco });
		const mobileTapTarget = await evaluate(
			client,
			`(() => {
				const root = document.querySelector('.workspace-leaf.mod-active') ?? document;
				const host = [...root.querySelectorAll('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock.shiki-monaco-editable, .shiki-monaco-block.shiki-monaco-editable, .shiki-monaco-codeblock, .shiki-monaco-block')].find(candidate => candidate._monacoEditor?.getModel?.());
				const editor = host?._monacoEditor;
				const model = editor?.getModel?.();
				let target = editor?.getTargetAtClientPoint?.(${line.x}, ${line.y})?.position ?? null;
				if (!target && host && model) {
					const lines = [...host.querySelectorAll('.view-line')];
					const firstLineRect = lines[0]?.getBoundingClientRect?.();
					const measuredLineHeight = firstLineRect?.height && firstLineRect.height > 0 ? firstLineRect.height : 20;
					const hostRect = host.getBoundingClientRect();
					const contentTop = firstLineRect?.top ?? hostRect.top;
					const lineNumber = Math.max(1, Math.min(model.getLineCount(), Math.floor((${line.y} - contentTop) / measuredLineHeight) + 1));
					let closestColumn = 1;
					let closestDistance = Number.POSITIVE_INFINITY;
					const targetLeft = ${line.x} - hostRect.left;
					for (let column = 1; column <= model.getLineMaxColumn(lineNumber); column++) {
						const visible = editor.getScrolledVisiblePosition?.({ lineNumber, column });
						if (!visible) continue;
						const distance = Math.abs(visible.left - targetLeft);
						if (distance < closestDistance) {
							closestDistance = distance;
							closestColumn = column;
						}
					}
					target = { lineNumber, column: closestColumn };
				}
				return {
					hasEditor: Boolean(editor),
					target,
					className: String(host?.className ?? ''),
				};
			})()`,
		);
		assert(mobileTapTarget.target, `${modeName}: mobile tap target did not resolve to a Monaco position`, mobileTapTarget);
		await dispatchTouchTap(client, line.x, line.y);
		const activeLine = await evaluate(
			client,
			`(() => {
				const host = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock, .shiki-monaco-block');
				const lines = [...(host ?? document).querySelectorAll('.view-line')];
				const expectedLine = ${mobileTapTarget.target.lineNumber};
				const row = lines.find((lineEl) => {
					const rect = lineEl.getBoundingClientRect();
					const top = Number.parseFloat(lineEl.style.top || '');
					const lineHeight = Math.max(1, rect.height || Number.parseFloat(getComputedStyle(lineEl).lineHeight) || 20);
					return Number.isFinite(top) && Math.round(top / lineHeight) + 1 === expectedLine;
				}) ?? lines[expectedLine - 1] ?? lines[0];
				if (!row) return null;
				const rect = row.getBoundingClientRect();
				return { x: Math.min(rect.right - 4, Math.max(rect.left + 4, ${line.x})), y: rect.top + rect.height / 2 };
			})()`,
		);
		assert(activeLine, `${modeName}: mobile active Monaco line target was unavailable`, { line, activeLine });
		const placementTap = await evaluate(
			client,
			`(() => {
				const point = { x: ${activeLine.x}, y: ${activeLine.y} };
				const host = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active, .shiki-monaco-codeblock, .shiki-monaco-block');
				const editor = host?._monacoEditor;
				window.__shikiMonacoGestureTrace = [];
				const before = editor?.getPosition?.() ?? null;
				const target = document.elementFromPoint(point.x, point.y) ?? host ?? document.body;
				const seen = [];
				const listener = event => seen.push({ type: event.type, pointerType: event.pointerType, isPrimary: event.isPrimary, targetClass: event.target?.className?.toString?.() ?? '', clientX: event.clientX, clientY: event.clientY });
				document.addEventListener('pointerdown', listener, true);
				document.addEventListener('pointerup', listener, true);
				for (const [type, buttons] of [['pointerdown', 1], ['pointerup', 0]]) {
					target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 23, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y, buttons }));
				}
				document.removeEventListener('pointerdown', listener, true);
				document.removeEventListener('pointerup', listener, true);
				return { point, targetClass: target?.className?.toString?.() ?? '', before, after: editor?.getPosition?.() ?? null, seen, gestureTrace: window.__shikiMonacoGestureTrace };
			})()`,
		);
		await delay(120);
		await delay(120);
		const nativeTap = await evaluate(
			client,
			`(() => {
				const block = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active');
				const editor = block?._monacoEditor;
				const position = editor?.getPosition?.() ?? null;
				const activeElement = document.activeElement;
				return {
					position,
					expected: ${JSON.stringify(mobileTapTarget.target)},
					editorHasFocus: editor?.hasTextFocus?.() ?? editor?.hasWidgetFocus?.() ?? false,
					activeElementClass: activeElement?.className?.toString?.() ?? null,
					activeElementInMonaco: !!activeElement?.closest?.('.monaco-editor'),
					placementTap: ${JSON.stringify(placementTap)},
				};
			})()`,
		);
		assert(nativeTap.position?.lineNumber === mobileTapTarget.target.lineNumber, `${modeName}: mobile tap placed Monaco cursor on wrong line`, nativeTap);
		assert(
			Math.abs(nativeTap.position?.column - mobileTapTarget.target.column) <= 1,
			`${modeName}: mobile tap placed Monaco cursor on wrong column`,
			nativeTap,
		);
		assert(nativeTap.editorHasFocus, `${modeName}: mobile tap did not focus editable Monaco`, nativeTap);
		assert(nativeTap.activeElementInMonaco, `${modeName}: mobile tap did not focus inside Monaco`, nativeTap);
		await evaluate(client, `(() => { window.__shikiMonacoDeactivationTrace = []; return true; })()`);
		await typeText(client, marker);
		const mobileModel = await waitFor(
			client,
			`(() => {
				const editor = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active')?._monacoEditor;
				const value = editor?.getModel?.()?.getValue?.() ?? '';
				return value.includes(${JSON.stringify(marker)}) ? value : null;
			})()`,
			`${modeName}: timed out waiting for typed mobile text in Monaco model`,
			5_000,
		);
		const mobileContent = await waitFor(
			client,
			`(async () => {
				const file = app.workspace.getActiveFile?.();
				const content = file ? await app.vault.read(file) : '';
				return content.includes(${JSON.stringify(marker)}) ? content : null;
			})()`,
			`${modeName}: timed out waiting for typed mobile text in Markdown`,
			5_000,
		);
		assert(mobileModel.includes(marker), `${modeName}: typed mobile text did not appear in Monaco model`, { marker, mobileModel });
		assert(mobileContent.includes(marker), `${modeName}: typed mobile text did not sync to Markdown`, { marker, mobileContent });
	} else {
		await evaluate(
			client,
			`(() => {
			const container = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active');
			if (container && container._monacoEditor) container._monacoEditor.focus();
		})()`,
		);
		await assertEditableCursorPlacement(client, modeName);
		await assertEditableCursorPlacementSweep(client, modeName);
		await typeText(client, marker);
		const content = await assertFileContains(client, marker);
		assert(content.includes(marker), `${modeName}: inserted text did not persist`, { marker, content });
	}

	const beforeScroll = await readMonacoScrollState(client);
	assert(beforeScroll?.hasOverflow, `${modeName}: Monaco block does not expose horizontal overflow`, beforeScroll);

	const beforeVerticalWheel = await readNoteAndMonacoScrollState(client);
	const verticalWheelDispatch = await dispatchWheelOnMonacoHost(client, 0, 220);
	assert(verticalWheelDispatch?.ok, `${modeName}: vertical wheel dispatch failed`, verticalWheelDispatch);
	assert(!verticalWheelDispatch.defaultPrevented, `${modeName}: vertical wheel was prevented inside Monaco`, verticalWheelDispatch);
	await delay(100);
	const afterVerticalWheel = await readNoteAndMonacoScrollState(client);
	assert(afterVerticalWheel.noteScrollTop > beforeVerticalWheel.noteScrollTop, `${modeName}: vertical wheel inside Monaco did not scroll the Obsidian note`, {
		beforeVerticalWheel,
		afterVerticalWheel,
	});
	assert(afterVerticalWheel.monacoScrollLeft === beforeVerticalWheel.monacoScrollLeft, `${modeName}: vertical wheel changed Monaco horizontal scroll`, {
		beforeVerticalWheel,
		afterVerticalWheel,
	});

	const beforeHorizontalWheel = await readNoteAndMonacoScrollState(client);
	const wheelDispatch = await dispatchWheelOnMonacoHost(client, 180, 0);
	assert(wheelDispatch?.ok, `${modeName}: horizontal wheel dispatch failed`, wheelDispatch);
	assert(wheelDispatch.defaultPrevented, `${modeName}: horizontal wheel was not prevented inside Monaco`, wheelDispatch);
	await delay(100);
	const afterWheelScroll = await readNoteAndMonacoScrollState(client);
	assert(afterWheelScroll.monacoScrollLeft > beforeHorizontalWheel.monacoScrollLeft, `${modeName}: horizontal wheel did not scroll Monaco`, {
		beforeHorizontalWheel,
		afterWheelScroll,
	});
	assert(afterWheelScroll.noteScrollTop === beforeHorizontalWheel.noteScrollTop, `${modeName}: horizontal wheel scrolled the Obsidian note`, {
		beforeHorizontalWheel,
		afterWheelScroll,
	});

	if (isMobileMode) {
		await evaluate(
			client,
			`(() => { const block = (document.querySelector('.workspace-leaf.mod-active') ?? document).querySelector('.shiki-monaco-codeblock.shiki-monaco-active, .shiki-monaco-block.shiki-monaco-active') ?? document.querySelector('.shiki-monaco-codeblock, .shiki-monaco-block'); block?._monacoEditor?.setScrollLeft?.(0); return true; })()`,
		);
		const resetScroll = await readMonacoScrollState(client);
		const touchDispatch = await dispatchTouchDragOnMonacoHost(client, line.x + 140, line.y, Math.max(line.x + 20, line.x - 100), line.y);
		assert(touchDispatch?.ok, `${modeName}: touch drag dispatch failed`, touchDispatch);
		await delay(150);
		const afterTouchScroll = await readMonacoScrollState(client);
		assert(afterTouchScroll.scrollLeft > resetScroll.scrollLeft, `${modeName}: horizontal touch drag did not scroll Monaco`, {
			resetScroll,
			afterTouchScroll,
		});
	}

	const afterMonaco = await waitForMonaco(client, modeName, !isMobileMode);
	assert(afterMonaco.viewLines > 0, `${modeName}: Monaco lost rendered lines after editing`, afterMonaco);
	assert(!afterMonaco.fenceTextVisible, `${modeName}: raw fenced code block became visible after editing`, afterMonaco);
	await captureScreenshot(client, modeName);
}

async function main() {
	await prepareVault();

	const reuseRunningTarget = await hasRunningTarget();
	const obsidian = reuseRunningTarget
		? null
		: spawn(OBSIDIAN_APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, VAULT], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
	obsidian?.stdout?.on('data', chunk => {
		launchOutput += chunk.toString();
	});
	obsidian?.stderr?.on('data', chunk => {
		launchOutput += chunk.toString();
	});

	let client;
	try {
		client = await waitForAppClient();

		await waitFor(client, `Boolean(window.app?.workspace && app.plugins)`, 'Obsidian app did not initialize');
		await evaluate(
			client,
			`(async () => {
				await app.plugins.loadManifests?.();
				if (!app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) && typeof app.plugins.loadPlugin === 'function') {
					await app.plugins.loadPlugin(${JSON.stringify(PLUGIN_ID)});
				}
				await window.app.plugins.setEnable?.(true);
				await new Promise(resolve => setTimeout(resolve, 1500));
				if (!app.plugins.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)})) {
					await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
				}
				const plugin = app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) ?? app.plugins.plugins?.[${JSON.stringify(PLUGIN_ID)}];
				await plugin?.registerCm6Plugin?.();
				return app.plugins.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)}) ?? false;
			})()`,
		);
		await waitFor(client, `Boolean(app.plugins?.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)}))`, 'Plugin did not enable');
		const pluginState = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) ?? app.plugins.plugins?.[${JSON.stringify(PLUGIN_ID)}];
				return {
					hasPlugin: Boolean(plugin),
					keys: plugin ? Object.keys(plugin).sort() : [],
					cm6PluginRegistered: Boolean(plugin?.cm6PluginRegistered),
					hasRegisterCm6Plugin: typeof plugin?.registerCm6Plugin === 'function',
					pluginManagerKeys: Object.keys(app.plugins ?? {}).sort(),
					pluginManagerMethods: Object.keys(Object.getPrototypeOf(app.plugins ?? {}) ?? {}).sort(),
					enabledPlugins: [...(app.plugins.enabledPlugins ?? [])],
					manifests: Object.keys(app.plugins.manifests ?? {}),
				};
			})()`,
		);
		assert(pluginState.cm6PluginRegistered, 'Plugin did not register CM6 editor extension', pluginState);
		await verifyMode(client, 'live preview', true, 'LIVE_PREVIEW_EDIT_');
		try {
			await evaluate(
				client,
				`(async () => {
					window.app?.emulateMobile?.(true);
					window.dispatchEvent(new Event('resize'));
					document.body.classList.toggle('shiki-mobile-transition-probe');
					document.body.classList.toggle('shiki-mobile-transition-probe');
					await new Promise(resolve => setTimeout(resolve, 1200));
					return Boolean(document.body.classList.contains('is-phone') || app.isMobile);
				})()`,
			);
		} catch (error) {
			if (!String(error).includes('Execution context was destroyed')) throw error;
			client.close();
			client = await waitForAppClient();
		}
		await waitFor(client, `Boolean(document.body?.classList.contains('is-phone') || globalThis.app?.isMobile)`, 'Mobile emulation did not activate');
		await verifyMode(client, 'mobile live preview', true, 'MOBILE_LIVE_PREVIEW_EDIT_');

		const finalContent = await waitFor(
			client,
			`(async () => {
				const view = app.workspace.activeLeaf?.view;
				view?.requestSave?.();
				await view?.save?.();
				const content = await app.vault.adapter.read(${JSON.stringify(NOTE_PATH)});
				return content.includes('LIVE_PREVIEW_EDIT_') ? content : null;
			})()`,
			'Live preview edit marker missing from disk',
			8_000,
		);
		assert(finalContent.includes('LIVE_PREVIEW_EDIT_'), 'Live preview edit marker missing from disk', { finalContent });
	} finally {
		client?.close();
		obsidian?.kill();
	}
}

main().catch(error => {
	error.message = `${error.message}\nLaunch output:\n${launchOutput}`;
	console.error(error);
	process.exit(1);
});
