import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const OBSIDIAN_APP_BUNDLE =
	process.env.OBSIDIAN_APP_BUNDLE ?? (OBSIDIAN_APP.endsWith('/Contents/MacOS/Obsidian') ? path.resolve(path.dirname(OBSIDIAN_APP), '../..') : OBSIDIAN_APP);
const OBSIDIAN_LAUNCH_MODE = process.env.OBSIDIAN_LAUNCH_MODE ?? 'reuse';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9230);
const VAULT = process.env.OBSIDIAN_VERIFY_VAULT ?? '/private/tmp/obsidian-shiki-real-verify-vault';
const USER_DATA = process.env.OBSIDIAN_VERIFY_USER_DATA ?? '/private/tmp/obsidian-shiki-real-verify-user-data';
const PLUGIN_SOURCE_DIR = process.env.OBSIDIAN_VERIFY_PLUGIN_DIR ?? 'dist';
const PLUGIN_ID = 'shiki-highlighter';
const BRAT_INSTALL = process.env.OBSIDIAN_VERIFY_BRAT_INSTALL === 'true';
const ENFORCE_PLUGIN_LOAD_MS = OBSIDIAN_LAUNCH_MODE === 'fresh' || process.env.OBSIDIAN_VERIFY_ENFORCE_STARTUP === 'true';
const VERIFY_READING_MODE = OBSIDIAN_LAUNCH_MODE === 'fresh' || process.env.OBSIDIAN_VERIFY_READING === 'true';
const VERIFY_TARGET = process.env.OBSIDIAN_VERIFY_TARGET ?? 'both';
const SOURCE_MODE_EDIT_MARKER = '__shiki_source_mode_persistence_marker__';

function assert(condition, message, detail) {
	if (!condition) {
		const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
		throw new Error(`${message}${suffix}`);
	}
}

function prepareVault({ resetUserData }) {
	rmSync(VAULT, { recursive: true, force: true });
	if (resetUserData) {
		rmSync(USER_DATA, { recursive: true, force: true });
	}

	const pluginDir = path.join(VAULT, '.obsidian/plugins', PLUGIN_ID);
	mkdirSync(pluginDir, { recursive: true });
	if (BRAT_INSTALL) {
		for (const file of ['main.js', 'manifest.json', 'styles.css']) {
			cpSync(path.join(PLUGIN_SOURCE_DIR, file), path.join(pluginDir, file));
		}
	} else {
		cpSync(PLUGIN_SOURCE_DIR, pluginDir, { recursive: true });
	}

	mkdirSync(path.join(VAULT, 'customLanguages'), { recursive: true });
	cpSync('exampleVault/customLanguages/odin.json', path.join(VAULT, 'customLanguages/odin.json'));
	mkdirSync(path.join(VAULT, 'customThemes'), { recursive: true });
	cpSync('exampleVault/customThemes/OneMonokai-color-theme.json', path.join(VAULT, 'customThemes/OneMonokai-color-theme.json'));

	writeFileSync(path.join(VAULT, '.obsidian/community-plugins.json'), JSON.stringify([PLUGIN_ID], null, '\t'));
	writeFileSync(path.join(VAULT, '.obsidian/app.json'), JSON.stringify({ safeMode: false }, null, '\t'));
	writeFileSync(
		path.join(pluginDir, 'data.json'),
		JSON.stringify(
			{
				customLanguageFolder: 'customLanguages',
				customThemeFolder: 'customThemes',
				inlineHighlighting: true,
				ecDefaultShowLineNumbers: false,
				ecDefaultWrap: false,
				darkTheme: 'obsidian-theme',
				lightTheme: 'obsidian-theme',
				preferThemeColors: true,
				disabledLanguages: [],
			},
			null,
			'\t',
		),
	);
	writeFileSync(
		path.join(VAULT, 'feature-test.md'),
		[
			'# Feature test',
			'',
			'Inline code `{ts} const inlineValue: number = 2` should render.',
			'',
			'~~~ts title="Startup check" showLineNumbers {1}',
			'const x: number = 1;',
			'console.log(x);',
			'~~~',
			'',
			'~~~diff',
			'- old line',
			'+ new line',
			'~~~',
			'',
			'~~~odin',
			'package main',
			'~~~',
			'',
			'```cs',
			'List<int[]> intervals = [[1, 3], [2, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597]];',
			'var startIndex = 0;',
			'intervals.Sort((a, b) => a[startIndex] - b[startIndex]);',
			'```',
			'',
		].join('\n'),
	);

	mkdirSync(USER_DATA, { recursive: true });
	writeFileSync(
		path.join(USER_DATA, 'obsidian.json'),
		JSON.stringify(
			{
				vaults: {
					'codex-shiki-real-verify': {
						path: VAULT,
						ts: Date.now(),
						open: true,
					},
				},
				openSchemes: {},
			},
			null,
			'\t',
		),
	);
}

async function waitForTarget() {
	const started = Date.now();
	while (Date.now() - started < 30000) {
		const page = await findTarget();
		if (page) return page;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for Obsidian DevTools target.');
}

async function waitForAppTarget() {
	const started = Date.now();
	while (Date.now() - started < 30000) {
		const page = await findTarget();
		if (page) {
			try {
				const result = await evaluate(page.webSocketDebuggerUrl, `(() => ({ hasApp: typeof window.app !== 'undefined' }))()`);
				if (result.hasApp) return page;
			} catch {}
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for Obsidian app target.');
}

async function findTarget() {
	try {
		const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(response => response.json());
		return targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl) ?? null;
	} catch {
		return null;
	}
}

async function getTargetVaultPath(target) {
	try {
		const current = await evaluate(
			target.webSocketDebuggerUrl,
			`(() => ({
				hasApp: typeof window.app !== 'undefined',
				vaultPath: typeof window.app !== 'undefined' ? window.app.vault?.adapter?.basePath ?? null : null,
			}))()`,
		);
		return current.hasApp ? current.vaultPath : null;
	} catch {
		return null;
	}
}

async function closeOwnedTarget(target) {
	if (!target) return;
	const vaultPath = await getTargetVaultPath(target);
	assert(vaultPath === VAULT, 'refusing to close a non-verifier Obsidian target', {
		port: PORT,
		vaultPath,
		expectedVault: VAULT,
	});
	await closeTarget(target);
	try {
		const pids = execFileSync('lsof', [`-tiTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
			.split('\n')
			.map(pid => Number(pid.trim()))
			.filter(pid => Number.isInteger(pid) && pid > 0);
		for (const pid of pids) {
			process.kill(pid, 'SIGTERM');
		}
	} catch {}
	for (let i = 0; i < 40 && (await findTarget()); i++) {
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	try {
		const pids = execFileSync('lsof', [`-tiTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
			.split('\n')
			.map(pid => Number(pid.trim()))
			.filter(pid => Number.isInteger(pid) && pid > 0);
		for (const pid of pids) {
			process.kill(pid, 'SIGKILL');
		}
	} catch {}
	for (let i = 0; i < 40 && (await findTarget()); i++) {
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

function portOwnerPids() {
	try {
		return execFileSync('lsof', [`-tiTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
			.split('\n')
			.map(pid => Number(pid.trim()))
			.filter(pid => Number.isInteger(pid) && pid > 0);
	} catch {
		return [];
	}
}

function assertOwnedPid(pid) {
	const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
	assert(
		command.includes(`--remote-debugging-port=${PORT}`) && command.includes(`--user-data-dir=${USER_DATA}`),
		'refusing to kill a non-verifier Obsidian process',
		{
			pid,
			command,
			expectedPort: PORT,
			expectedUserData: USER_DATA,
		},
	);
}

async function killOwnedPortProcesses() {
	const pids = portOwnerPids();
	for (const pid of pids) {
		assertOwnedPid(pid);
		process.kill(pid, 'SIGTERM');
	}
	for (let i = 0; i < 40 && portOwnerPids().length > 0; i++) {
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	for (const pid of portOwnerPids()) {
		assertOwnedPid(pid);
		process.kill(pid, 'SIGKILL');
	}
	for (let i = 0; i < 40 && portOwnerPids().length > 0; i++) {
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

async function assertOwnedTarget(target) {
	if (!target) return;
	const vaultPath = await getTargetVaultPath(target);
	assert(vaultPath === VAULT, 'refusing to reuse a non-verifier Obsidian target', {
		port: PORT,
		vaultPath,
		expectedVault: VAULT,
	});
}

async function relaunchExistingTarget() {
	const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(response => response.json());
	const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
	assert(page, 'existing Obsidian target has no page to relaunch from', { port: PORT, targets });

	const current = await evaluate(
		page.webSocketDebuggerUrl,
		`(() => ({
			hasApp: typeof window.app !== 'undefined',
			vaultPath: typeof window.app !== 'undefined' ? window.app.vault?.adapter?.basePath ?? null : null,
		}))()`,
	);
	if (current.hasApp && current.vaultPath === VAULT) {
		return;
	}

	await evaluate(
		page.webSocketDebuggerUrl,
		`(() => {
			if (!window.electron?.remote?.app || !window.electron?.remote?.process) {
				throw new Error('existing page does not expose Electron remote relaunch APIs');
			}
			const app = window.electron.remote.app;
			const process = window.electron.remote.process;
			app.relaunch({ args: process.argv });
			setTimeout(() => app.exit(0), 50);
			return { relaunching: true, argv: process.argv };
		})()`,
	);
}

function launchObsidian() {
	const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`];
	if (OBSIDIAN_LAUNCH_MODE === 'existing') {
		return null;
	}
	if (OBSIDIAN_LAUNCH_MODE === 'reuse' || OBSIDIAN_LAUNCH_MODE === 'fresh') {
		const child = spawn(OBSIDIAN_APP, args, {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();
		return null;
	}
	if (OBSIDIAN_LAUNCH_MODE === 'open') {
		return spawn('open', ['-na', OBSIDIAN_APP_BUNDLE, '--args', ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	}
	return spawn(OBSIDIAN_APP, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

async function closeTarget(target) {
	if (!target?.id) return;
	try {
		await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
	} catch {}
}

async function evaluate(wsUrl, expression) {
	const socket = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const callbacks = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) callbacks.reject(message.error);
			else callbacks.resolve(message.result);
		}
	});

	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}

	try {
		await send('Runtime.enable');
		const result = await send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			console.error('Renderer exception details:', result.exceptionDetails);
			if (result.exceptionDetails.stackTrace) {
				console.error('Renderer exception stack:', result.exceptionDetails.stackTrace);
			}
			const description = result.exceptionDetails.exception?.description;
			const value = result.exceptionDetails.exception?.value;
			const message = result.exceptionDetails.text ?? description ?? value ?? 'Uncaught';
			throw new Error(`Renderer exception: ${message}`);
		}
		return result.result.value;
	} finally {
		socket.close();
	}
}

async function dispatchMouseClick(wsUrl, x, y) {
	const socket = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const callbacks = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) callbacks.reject(message.error);
			else callbacks.resolve(message.result);
		}
	});

	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}

	try {
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
	} finally {
		socket.close();
	}
}

async function dispatchMouseDrag(wsUrl, fromX, fromY, toX, toY, steps = 8) {
	const socket = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const callbacks = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) callbacks.reject(message.error);
			else callbacks.resolve(message.result);
		}
	});

	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}

	try {
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, button: 'none' });
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
		for (let step = 1; step <= steps; step++) {
			const progress = step / steps;
			await send('Input.dispatchMouseEvent', {
				type: 'mouseMoved',
				x: fromX + (toX - fromX) * progress,
				y: fromY + (toY - fromY) * progress,
				button: 'left',
				buttons: 1,
			});
			await new Promise(resolve => setTimeout(resolve, 16));
		}
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 });
	} finally {
		socket.close();
	}
}

async function dispatchTouchTap(wsUrl, x, y) {
	const socket = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const callbacks = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) callbacks.reject(message.error);
			else callbacks.resolve(message.result);
		}
	});

	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}

	try {
		await send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }],
		});
		await send('Input.dispatchTouchEvent', {
			type: 'touchEnd',
			touchPoints: [],
		});
	} finally {
		socket.close();
	}
}

async function dispatchTouchDrag(wsUrl, fromX, fromY, toX, toY, steps = 8) {
	const socket = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const callbacks = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) callbacks.reject(message.error);
			else callbacks.resolve(message.result);
		}
	});

	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}

	try {
		await send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x: fromX, y: fromY, radiusX: 2, radiusY: 2, force: 1 }],
		});
		for (let step = 1; step <= steps; step++) {
			const progress = step / steps;
			await send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [
					{
						x: fromX + (toX - fromX) * progress,
						y: fromY + (toY - fromY) * progress,
						radiusX: 2,
						radiusY: 2,
						force: 1,
					},
				],
			});
			await new Promise(resolve => setTimeout(resolve, 16));
		}
		await send('Input.dispatchTouchEvent', {
			type: 'touchEnd',
			touchPoints: [],
		});
	} finally {
		socket.close();
	}
}

async function dispatchHorizontalWheel(wsUrl, x, y, deltaX) {
	const socket = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});

	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const callbacks = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) callbacks.reject(message.error);
			else callbacks.resolve(message.result);
		}
	});

	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}

	try {
		await send('Input.dispatchMouseEvent', {
			type: 'mouseWheel',
			x,
			y,
			deltaX,
			deltaY: 0,
		});
	} finally {
		socket.close();
	}
}

async function dispatchWheelOnActiveMonaco(wsUrl, deltaX) {
	return evaluate(
		wsUrl,
		`(() => {
			const block = document.querySelector('.shiki-monaco-codeblock.shiki-monaco-active');
			if (!block) return { ok: false, error: 'no-active-monaco-block' };
			const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: ${deltaX}, deltaY: 0 });
			block.dispatchEvent(event);
			return { ok: true, defaultPrevented: event.defaultPrevented };
		})()`,
	);
}

async function dispatchTouchDragOnTargetMonaco(wsUrl, fromX, fromY, toX, toY) {
	return evaluate(
		wsUrl,
		`(() => {
			const block = [...document.querySelectorAll('.shiki-monaco-codeblock')].find(el => {
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && el.textContent?.replace(/\u00a0/g, ' ').includes('List<int[]> intervals');
			});
			if (!block) return { ok: false, error: 'no-monaco-block' };
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

async function readTargetMonacoScrollState(wsUrl) {
	return evaluate(
		wsUrl,
		`(() => {
			const block = [...document.querySelectorAll('.shiki-monaco-codeblock')].find(el => {
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && el.textContent?.replace(/\u00a0/g, ' ').includes('List<int[]> intervals');
			});
			const editor = block?._monacoEditor;
			if (!block || !editor) return null;
			const noteScroller = block.closest('.markdown-source-view, .markdown-preview-view')?.querySelector('.cm-scroller, .markdown-preview-sizer') ?? null;
			const line = block.querySelector('.view-line');
			return {
				scrollLeft: editor.getScrollLeft?.() ?? 0,
				hasOverflow: (editor.getScrollWidth?.() ?? block.scrollWidth) > block.clientWidth,
				contentLeft: line?.getBoundingClientRect?.().left ?? null,
				width: block.clientWidth,
				scrollWidth: editor.getScrollWidth?.() ?? block.scrollWidth,
				noteClientWidth: noteScroller?.clientWidth ?? null,
				noteScrollWidth: noteScroller?.scrollWidth ?? null,
			};
		})()`,
	);
}

async function measureEditableGestureSet(wsUrl, stateName, label) {
	const target = await evaluate(
		wsUrl,
		`(async () => {
			const app = window.app;
			const plugin = app.plugins.plugins['shiki-highlighter'];
			const activeView = app.workspace.activeLeaf?.view;
			const editor = activeView?.editor;
			const csharpLineIndex = editor?.getValue?.().split('\\n').findIndex(line => line.includes('List<int[]> intervals')) ?? -1;
			if (editor && csharpLineIndex >= 0) {
				editor.scrollIntoView?.({ from: { line: csharpLineIndex, ch: 0 }, to: { line: csharpLineIndex, ch: 24 } }, true);
				editor.setCursor({ line: csharpLineIndex, ch: 12 });
				editor.focus();
			}
			if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
			await new Promise(resolve => setTimeout(resolve, 750));
			const editorRoot = activeView?.contentEl ?? document;
			const csharpLine = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-codeblock-line')].find(el =>
				el.textContent?.includes('List<int[]> intervals')
			);
			if (!csharpLine) {
				globalThis[${JSON.stringify(stateName)}] = { label: ${JSON.stringify(label)}, missingEditableLine: true };
				return null;
			}
			const blockId = csharpLine.getAttribute('data-shiki-editing-block-id');
			const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${blockId}"]\`)];
			for (const line of blockLines) line.scrollLeft = 0;
			app.workspace.rightSplit?.collapse?.();
			const rect = csharpLine.getBoundingClientRect();
			const y = rect.top + Math.min(rect.height / 2, 24);
			const fromX = Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75));
			globalThis[${JSON.stringify(stateName)}] = {
				label: ${JSON.stringify(label)},
				blockId,
			before: blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft),
				after: null,
				hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
				beforeContentLeft: csharpLine.querySelector('.shiki-editing-token')?.getBoundingClientRect().left ?? null,
				afterContentLeft: null,
				rightSplitCollapsedBefore: app.workspace.rightSplit?.collapsed ?? null,
				rightSplitCollapsedAfter: null,
				vertical: null,
				wheel: null,
				drag: null,
			};
			return { blockId, fromX, fromY: y, toX: Math.max(rect.left + 24, fromX - 220), toY: y };
		})()`,
	);
	if (!target) return;

	await dispatchTouchDrag(wsUrl, target.fromX, target.fromY, target.toX, target.toY);
	await new Promise(resolve => setTimeout(resolve, 100));
	await evaluate(
		wsUrl,
		`(() => {
			const app = window.app;
			const state = globalThis[${JSON.stringify(stateName)}];
			if (!state?.blockId) return null;
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
			state.after = blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft);
			const csharpLine = blockLines.find(el => el.textContent?.includes('List<int[]> intervals'));
			state.afterContentLeft = csharpLine?.querySelector('.shiki-editing-token')?.getBoundingClientRect().left ?? null;
			state.rightSplitCollapsedAfter = app.workspace.rightSplit?.collapsed ?? null;
			return state;
		})()`,
	);

	const verticalTarget = await evaluate(
		wsUrl,
		`(() => {
			const app = window.app;
			const state = globalThis[${JSON.stringify(stateName)}];
			if (!state?.blockId) return null;
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const scroller = editorRoot.querySelector('.cm-scroller');
			const csharpLine = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)].find(el =>
				el.textContent?.includes('List<int[]> intervals')
			);
			if (!scroller || !csharpLine) return null;
			scroller.scrollTop = 0;
			const rect = csharpLine.getBoundingClientRect();
			const x = Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75));
			const y = rect.top + Math.min(rect.height / 2, 24);
			state.vertical = { before: scroller.scrollTop, after: null, scrollable: scroller.scrollHeight > scroller.clientHeight };
			return { x, fromY: y, toY: Math.max(12, y - 180) };
		})()`,
	);
	if (verticalTarget) {
		await dispatchTouchDrag(wsUrl, verticalTarget.x, verticalTarget.fromY, verticalTarget.x, verticalTarget.toY);
		await new Promise(resolve => setTimeout(resolve, 100));
		await evaluate(
			wsUrl,
			`(() => {
				const app = window.app;
				const state = globalThis[${JSON.stringify(stateName)}];
				if (!state?.vertical) return null;
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const scroller = editorRoot.querySelector('.cm-scroller');
				state.vertical.after = scroller?.scrollTop ?? null;
				return state.vertical;
			})()`,
		);
	}

	const wheelTarget = await evaluate(
		wsUrl,
		`(() => {
			const app = window.app;
			const state = globalThis[${JSON.stringify(stateName)}];
			if (!state?.blockId) return null;
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const csharpLine = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)].find(el =>
				el.textContent?.includes('List<int[]> intervals')
			);
			if (!csharpLine) return null;
			const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
			for (const line of blockLines) line.scrollLeft = 0;
			const rect = csharpLine.getBoundingClientRect();
			state.wheel = {
				before: blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft),
				after: null,
				hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
			};
			return { x: Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75)), y: rect.top + Math.min(rect.height / 2, 24) };
		})()`,
	);
	if (wheelTarget) {
		await dispatchHorizontalWheel(wsUrl, wheelTarget.x, wheelTarget.y, 180);
		await new Promise(resolve => setTimeout(resolve, 100));
		await evaluate(
			wsUrl,
			`(() => {
				const app = window.app;
				const state = globalThis[${JSON.stringify(stateName)}];
				if (!state?.wheel) return null;
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
			state.wheel.after = blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft);
				return state.wheel;
			})()`,
		);
	}

	const dragTarget = await evaluate(
		wsUrl,
		`(() => {
			const app = window.app;
			const state = globalThis[${JSON.stringify(stateName)}];
			if (!state?.blockId) return null;
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const csharpLine = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)].find(el =>
				el.textContent?.includes('List<int[]> intervals')
			);
			if (!csharpLine) return null;
			const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
			for (const line of blockLines) line.scrollLeft = 0;
			const rect = csharpLine.getBoundingClientRect();
			const y = rect.top + Math.min(rect.height / 2, 24);
			const fromX = Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75));
			state.drag = {
				before: blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft),
				after: null,
				hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
			};
			return { fromX, fromY: y, toX: Math.max(rect.left + 24, fromX - 220), toY: y };
		})()`,
	);
	if (dragTarget) {
		await dispatchMouseDrag(wsUrl, dragTarget.fromX, dragTarget.fromY, dragTarget.toX, dragTarget.toY);
		await new Promise(resolve => setTimeout(resolve, 100));
		await evaluate(
			wsUrl,
			`(() => {
				const app = window.app;
				const state = globalThis[${JSON.stringify(stateName)}];
				if (!state?.drag) return null;
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
			state.drag.after = blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft);
				return state.drag;
			})()`,
		);
	}
}

async function trustVault(wsUrl) {
	return evaluate(
		wsUrl,
		`(async () => {
			const app = window.app;
			await new Promise(resolve => setTimeout(resolve, 1000));
			const trust = [...document.querySelectorAll('button')].find(button => button.innerText.includes('Trust author'));
			if (trust) trust.click();
			await new Promise(resolve => setTimeout(resolve, 2000));
			return { clickedTrust: !!trust, hasApp: typeof app, enabled: app ? [...app.plugins.enabledPlugins] : [] };
		})()`,
	);
}

async function setMobileEmulation(wsUrl, enabled) {
	try {
		await evaluate(
			wsUrl,
			`(async () => {
				for (let i = 0; i < 300 && !window.app; i++) await new Promise(resolve => setTimeout(resolve, 100));
				const app = window.app;
				if (!app) throw new Error('Obsidian app was not ready for mobile emulation');
				if (typeof app.emulateMobile === 'function') app.emulateMobile(${enabled ? 'true' : 'false'});
				else app.isMobile = ${enabled ? 'true' : 'false'};
				return { isMobile: app.isMobile };
			})()`,
		);
		return wsUrl;
	} catch (error) {
		if (!String(error?.message ?? error).includes('Execution context was destroyed')) {
			throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 1500));
		return (await waitForAppTarget()).webSocketDebuggerUrl;
	}
}

async function verifyFeatureSet(wsUrl, mobile) {
	let activeWsUrl = wsUrl;
	if (mobile) {
		activeWsUrl = await setMobileEmulation(activeWsUrl, true);
	}

	await evaluate(
		activeWsUrl,
		`(async () => {
			for (let i = 0; i < 300 && !window.app?.plugins; i++) await new Promise(resolve => setTimeout(resolve, 100));
			if (!window.app?.plugins) throw new Error('Obsidian app was not ready');
			const app = window.app;
				const measurements = {};
				let loadError = null;
				try {
					if (app.plugins.plugins['${PLUGIN_ID}']) await app.plugins.unloadPlugin('${PLUGIN_ID}');
					if (app.plugins.loadManifests) await app.plugins.loadManifests();
					const loadStart = performance.now();
					await app.plugins.loadPlugin('${PLUGIN_ID}');
					measurements.pluginLoadMs = performance.now() - loadStart;
				} catch (e) {
					loadError = { name: e.name, message: e.message, stack: e.stack };
				}
				const plugin = app.plugins.plugins['${PLUGIN_ID}'];
				if (!plugin) {
					throw new Error(
						'Plugin did not load: ' +
							JSON.stringify({
								loadError,
								enabledPlugins: [...app.plugins.enabledPlugins],
								hasManifest: !!app.plugins.manifests?.['${PLUGIN_ID}'],
								loadedPlugins: Object.keys(app.plugins.plugins),
							}),
					);
				}
				const file = app.vault.getAbstractFileByPath('feature-test.md');
			if (file) {
				const leaf = app.workspace.getLeaf(false);
				await leaf.openFile(file, { state: { mode: 'preview' } });
				const view = leaf.view;
				if (view?.setState) await view.setState({ file: file.path, mode: 'preview' }, { history: false });
			}
			await new Promise(resolve => setTimeout(resolve, 5000));
			const tokenStart = performance.now();
			const tokens = await plugin.highlighter.getHighlightTokens('const x: number = 1', 'ts');
			measurements.warmTokenizeMs = performance.now() - tokenStart;
			const renderHost = document.createElement('div');
			document.body.appendChild(renderHost);
			const renderStart = performance.now();
			await plugin.highlighter.renderWithEc('const z: number = 3', 'ts', 'title="Perf" showLineNumbers', renderHost);
			measurements.warmRenderWithEcMs = performance.now() - renderStart;
			const renderedText = renderHost.textContent;
			renderHost.remove();
			const languages = await plugin.highlighter.supportedLanguages();
			const originalDisabled = [...plugin.settings.disabledLanguages];
			plugin.settings.disabledLanguages = ['ts', 'typescript'];
			plugin.loadedSettings = structuredClone(plugin.settings);
			const disabledTokens = await plugin.highlighter.getHighlightTokens('const disabled = true', 'ts');
			plugin.settings.disabledLanguages = originalDisabled;
			plugin.loadedSettings = structuredClone(plugin.settings);
			const originalClassName = document.body.className;
			const originalSettings = structuredClone(plugin.loadedSettings);
			const themeSelection = {};
			plugin.loadedSettings.darkTheme = 'runtime-selected-dark-theme';
			plugin.loadedSettings.lightTheme = 'runtime-selected-light-theme';
			document.body.classList.remove('theme-dark', 'theme-light');
			document.body.classList.add('theme-light');
			themeSelection.light = plugin.getActiveTheme();
			document.body.classList.remove('theme-dark', 'theme-light');
			document.body.classList.add('theme-dark');
			themeSelection.dark = plugin.getActiveTheme();
			document.body.className = originalClassName;
			plugin.loadedSettings = originalSettings;
			const dynamicThemeSelection = {};
			const savedSettings = structuredClone(plugin.settings);
			plugin.settings.darkTheme = 'github-dark-default';
			plugin.settings.lightTheme = 'github-light-default';
			await plugin.saveSettingsAndReloadHighlighter();
			document.body.classList.remove('theme-dark', 'theme-light');
			document.body.classList.add('theme-light');
			dynamicThemeSelection.light = plugin.getActiveTheme();
			document.body.classList.remove('theme-dark', 'theme-light');
			document.body.classList.add('theme-dark');
			dynamicThemeSelection.dark = plugin.getActiveTheme();
			document.body.className = originalClassName;
			plugin.settings = savedSettings;
			await plugin.saveSettingsAndReloadHighlighter();
			const viewRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const codeBlocks = [...viewRoot.querySelectorAll('.shiki-monaco-block')].map(el => ({
				text: el.textContent,
				hasMonacoEditor: !!el.querySelector('.monaco-editor'),
				hasEditorHook: !!el._monacoEditor,
				viewLines: el.querySelectorAll('.view-line').length,
				hasLineNumbers: !!el.querySelector('.line-numbers'),
				parentClassName: el.parentElement?.className ?? '',
				grandParentClassName: el.parentElement?.parentElement?.className ?? '',
				previousSibling: el.previousElementSibling?.tagName ?? null,
				nextSibling: el.nextElementSibling?.tagName ?? null,
			}));
			const inline = [...viewRoot.querySelectorAll('.shiki-inline')].map(el => el.textContent);
			if (file) {
				const leaf = app.workspace.getLeaf(false);
				await leaf.openFile(file, { state: { mode: 'source', source: false } });
				const view = leaf.view;
				if (view?.setState) await view.setState({ file: file.path, mode: 'source', source: false }, { history: false });
			}
			for (let i = 0; i < 100 && !document.querySelector('.cm-content'); i++) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
			await new Promise(resolve => setTimeout(resolve, 500));
			const livePreviewRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const livePreviewCodeBlocks = [...livePreviewRoot.querySelectorAll('.shiki-monaco-codeblock')].map(el => ({
				text: el.textContent,
				hasMonacoEditor: !!el.querySelector('.monaco-editor'),
				hasEditorHook: !!el._monacoEditor,
				viewLines: el.querySelectorAll('.view-line').length,
				hasLineNumbers: !!el.querySelector('.line-numbers'),
			}));
			const activeView = app.workspace.activeLeaf?.view;
			const editor = activeView?.editor;
			const csharpLine = editor?.getValue?.().split('\\n').findIndex(line => line.includes('List<int[]> intervals')) ?? -1;
			const editorActivation = {
				viewType: activeView?.getViewType?.() ?? null,
				hasEditor: !!editor,
				csharpLine,
				beforeCursor: editor?.getCursor?.() ?? null,
			};
			if (editor && csharpLine >= 0) {
				editor.scrollIntoView?.({ from: { line: csharpLine, ch: 0 }, to: { line: csharpLine, ch: 24 } }, true);
				editor.setCursor({ line: csharpLine, ch: 12 });
				editor.focus();
				await new Promise(resolve => setTimeout(resolve, 1000));
				editorActivation.afterCursor = editor.getCursor?.() ?? null;
				editorActivation.activeElement = document.activeElement?.className ?? document.activeElement?.tagName ?? null;
			}
			if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
			await new Promise(resolve => setTimeout(resolve, 500));
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			editorActivation.cmContent = !!editorRoot.querySelector('.cm-content');
			editorActivation.cmActiveLineText = editorRoot.querySelector('.cm-active')?.textContent ?? null;
			editorActivation.hyperMdCodeblockCount = editorRoot.querySelectorAll('.HyperMD-codeblock').length;
			globalThis.__shikiVerifyState = {
				isMobile: app.isMobile,
				loadError,
				pluginLoaded: !!plugin,
				settingsTabLoaded: !!app.setting?.pluginTabs?.find?.(tab => tab.id === '${PLUGIN_ID}' || tab.plugin === plugin),
				highlighterLoaded: !!plugin?.monacoRuntime?.isLoaded?.(),
				themes: {
					dark: plugin.settings.darkTheme,
					light: plugin.settings.lightTheme,
				},
				activeFile: app.workspace.getActiveFile()?.path ?? null,
				activeCodeBlocks: plugin?.activeCodeBlocks ? [...plugin.activeCodeBlocks.entries()].map(([key, value]) => [key, value.length]) : null,
				tokenSummary: { lines: tokens?.tokens?.length ?? null, firstLineTokens: tokens?.tokens?.[0]?.length ?? null },
				renderedText,
				customLanguageOdinSupported: languages.includes('odin'),
				disabledLanguageReturns: disabledTokens ?? null,
				themeSelection,
				dynamicThemeSelection,
				measurements,
				editorActivation,
				codeBlocks,
				livePreviewCodeBlocks,
				inline,
			};
			return {};
		})()`,
	);
	if (mobile) {
		const livePreviewEditTarget = await evaluate(
			activeWsUrl,
			`(() => {
				const app = window.app;
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const renderedCodeBlock = [...editorRoot.querySelectorAll('.shiki-monaco-codeblock')].find(el => {
					const rect = el.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0 && el.textContent?.replace(/\u00a0/g, ' ').includes('List<int[]> intervals');
				});
				if (!renderedCodeBlock) return null;
				const rect = renderedCodeBlock.getBoundingClientRect();
				return {
					x: rect.left + Math.min(rect.width / 2, 160),
					y: rect.top + Math.min(rect.height / 2, 32),
				};
			})()`,
		);
		if (livePreviewEditTarget) {
			await dispatchTouchTap(activeWsUrl, livePreviewEditTarget.x, livePreviewEditTarget.y);
			await evaluate(
				activeWsUrl,
				`(() => {
					const app = window.app;
					const activeView = app.workspace.activeLeaf?.view;
					const editor = activeView?.editor;
					const cursor = editor?.getCursor?.() ?? null;
					const csharpLine = editor?.getValue?.().split('\n').findIndex(line => line.includes('List<int[]> intervals')) ?? -1;
					const activeElement = document.activeElement;
					globalThis.__shikiVerifyMobileNativeTap = {
						cursor,
						csharpLine,
						editorHasFocus: editor?.hasFocus?.() ?? false,
						activeElementClass: activeElement?.className?.toString?.() ?? null,
						activeElementTag: activeElement?.tagName ?? null,
						activeElementInMonaco: !!activeElement?.closest?.('.monaco-editor'),
					};
					return globalThis.__shikiVerifyMobileNativeTap;
				})()`,
			);
			await evaluate(
				activeWsUrl,
				`(async () => {
					const app = window.app;
					const plugin = app.plugins.plugins['${PLUGIN_ID}'];
					const activeView = app.workspace.activeLeaf?.view;
					const editor = activeView?.editor;
					const csharpLine = editor?.getValue?.().split('\\n').findIndex(line => line.includes('List<int[]> intervals')) ?? -1;
					if (editor && csharpLine >= 0) {
						editor.setCursor({ line: csharpLine, ch: 12 });
						editor.focus();
					}
					if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
					await new Promise(resolve => setTimeout(resolve, 1000));
					return {
						csharpLine,
						activeLine: activeView?.contentEl?.querySelector('.cm-active')?.textContent ?? null,
						editableLines: activeView?.contentEl?.querySelectorAll('.shiki-editing-codeblock-line')?.length ?? 0,
					};
				})()`,
			);
			const monacoHorizontalTarget = await evaluate(
				activeWsUrl,
				`(() => {
					const block = [...document.querySelectorAll('.shiki-monaco-codeblock')].find(el => {
						const rect = el.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0 && el.textContent?.replace(/\u00a0/g, ' ').includes('List<int[]> intervals');
					});
					const editor = block?._monacoEditor;
					if (!block || !editor) return null;
					editor.setScrollLeft?.(0);
					const rect = block.getBoundingClientRect();
					return {
						fromX: Math.min(rect.right - 24, rect.left + Math.max(160, rect.width * 0.8)),
						fromY: rect.top + Math.min(rect.height / 2, 40),
						toX: Math.max(rect.left + 24, rect.left + Math.max(40, rect.width * 0.2)),
						toY: rect.top + Math.min(rect.height / 2, 40),
					};
				})()`,
			);
			if (monacoHorizontalTarget) {
				const before = await readTargetMonacoScrollState(activeWsUrl);
				await dispatchTouchDragOnTargetMonaco(
					activeWsUrl,
					monacoHorizontalTarget.fromX,
					monacoHorizontalTarget.fromY,
					monacoHorizontalTarget.toX,
					monacoHorizontalTarget.toY,
				);
				await new Promise(resolve => setTimeout(resolve, 100));
				const after = await readTargetMonacoScrollState(activeWsUrl);
				await evaluate(
					activeWsUrl,
					`(() => {
						globalThis.__shikiVerifyMonacoHorizontal = ${JSON.stringify({ before, after })};
						return globalThis.__shikiVerifyMonacoHorizontal;
					})()`,
				);
			}
		}
		const swipeTarget = await evaluate(
			activeWsUrl,
			`(() => {
				const app = window.app;
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const csharpLine = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-codeblock-line')].find(el =>
					el.textContent?.includes('List<int[]> intervals')
				);
				if (!csharpLine) return null;
				const blockId = csharpLine.getAttribute('data-shiki-editing-block-id');
				const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${blockId}"]\`)];
				for (const line of blockLines) line.scrollLeft = 0;
				app.workspace.rightSplit?.collapse?.();
				const rect = csharpLine.getBoundingClientRect();
				const y = rect.top + Math.min(rect.height / 2, 24);
				const fromX = Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75));
					globalThis.__shikiVerifyEditableSwipe = {
						blockId,
						before: blockLines.map(line => line.scrollLeft),
						after: null,
						hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
						beforeContentLeft: csharpLine.querySelector('.shiki-editing-token')?.getBoundingClientRect().left ?? null,
						afterContentLeft: null,
						rightSplitCollapsedBefore: app.workspace.rightSplit?.collapsed ?? null,
						rightSplitCollapsedAfter: null,
					};
				return {
					fromX,
					fromY: y,
					toX: Math.max(rect.left + 24, fromX - 220),
					toY: y,
				};
			})()`,
		);
		if (swipeTarget) {
			await dispatchTouchDrag(activeWsUrl, swipeTarget.fromX, swipeTarget.fromY, swipeTarget.toX, swipeTarget.toY);
			await new Promise(resolve => setTimeout(resolve, 100));
			await evaluate(
				activeWsUrl,
				`(() => {
					const app = window.app;
					const state = globalThis.__shikiVerifyEditableSwipe;
					if (!state?.blockId) return null;
					const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
					const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
					state.after = blockLines.map(line => line.scrollLeft);
					const csharpLine = blockLines.find(el => el.textContent?.includes('List<int[]> intervals'));
					state.afterContentLeft = csharpLine?.querySelector('.shiki-editing-token')?.getBoundingClientRect().left ?? null;
					state.rightSplitCollapsedAfter = app.workspace.rightSplit?.collapsed ?? null;
					return state;
				})()`,
			);
			const verticalTarget = await evaluate(
				activeWsUrl,
				`(() => {
					const app = window.app;
					const swipeState = globalThis.__shikiVerifyEditableSwipe;
					if (!swipeState?.blockId) return null;
					const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
					const scroller = editorRoot.querySelector('.cm-scroller');
					const csharpLine = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${swipeState.blockId}"]\`)].find(el =>
						el.textContent?.includes('List<int[]> intervals')
					);
					if (!scroller || !csharpLine) return null;
					scroller.scrollTop = 0;
					const rect = csharpLine.getBoundingClientRect();
					const x = Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75));
					const y = rect.top + Math.min(rect.height / 2, 24);
					globalThis.__shikiVerifyEditableVertical = {
						before: scroller.scrollTop,
						after: null,
						scrollable: scroller.scrollHeight > scroller.clientHeight,
					};
					return { x, fromY: y, toY: Math.max(12, y - 180) };
				})()`,
			);
			if (verticalTarget) {
				await dispatchTouchDrag(activeWsUrl, verticalTarget.x, verticalTarget.fromY, verticalTarget.x, verticalTarget.toY);
				await evaluate(
					activeWsUrl,
					`(() => {
						const app = window.app;
						const state = globalThis.__shikiVerifyEditableVertical;
						if (!state) return null;
						const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
						const scroller = editorRoot.querySelector('.cm-scroller');
						state.after = scroller?.scrollTop ?? null;
						return state;
					})()`,
				);
			}
			const wheelTarget = await evaluate(
				activeWsUrl,
				`(() => {
					const app = window.app;
					const swipeState = globalThis.__shikiVerifyEditableSwipe;
					if (!swipeState?.blockId) return null;
					const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
					const csharpLine = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${swipeState.blockId}"]\`)].find(el =>
						el.textContent?.includes('List<int[]> intervals')
					);
					if (!csharpLine) return null;
					const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${swipeState.blockId}"]\`)];
					for (const line of blockLines) line.scrollLeft = 0;
					const rect = csharpLine.getBoundingClientRect();
					globalThis.__shikiVerifyEditableWheel = {
						blockId: swipeState.blockId,
						before: blockLines.map(line => line.scrollLeft),
						after: null,
						hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
					};
					return {
						x: Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75)),
						y: rect.top + Math.min(rect.height / 2, 24),
					};
				})()`,
			);
			if (wheelTarget) {
				await dispatchHorizontalWheel(activeWsUrl, wheelTarget.x, wheelTarget.y, 180);
				await evaluate(
					activeWsUrl,
					`(() => {
						const app = window.app;
						const state = globalThis.__shikiVerifyEditableWheel;
						if (!state?.blockId) return null;
						const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
						const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
						state.after = blockLines.map(line => line.scrollLeft);
						return state;
					})()`,
				);
			}
		}
	}

	if (mobile) {
		const dragTarget = await evaluate(
			activeWsUrl,
			`(() => {
				const app = window.app;
				const swipeState = globalThis.__shikiVerifyEditableSwipe;
				if (!swipeState?.blockId) return null;
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const csharpLine = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${swipeState.blockId}"]\`)].find(el =>
					el.textContent?.includes('List<int[]> intervals')
				);
				if (!csharpLine) return null;
				const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${swipeState.blockId}"]\`)];
				for (const line of blockLines) line.scrollLeft = 0;
				const rect = csharpLine.getBoundingClientRect();
				const y = rect.top + Math.min(rect.height / 2, 24);
				const fromX = Math.min(rect.right - 24, rect.left + Math.max(120, rect.width * 0.75));
				globalThis.__shikiVerifyEditableDrag = {
					blockId: swipeState.blockId,
					before: blockLines.map(line => line.scrollLeft),
					after: null,
					hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
				};
				return { fromX, fromY: y, toX: Math.max(rect.left + 24, fromX - 220), toY: y };
			})()`,
		);
		if (dragTarget) {
			await dispatchMouseDrag(activeWsUrl, dragTarget.fromX, dragTarget.fromY, dragTarget.toX, dragTarget.toY);
			await evaluate(
				activeWsUrl,
				`(() => {
					const app = window.app;
					const state = globalThis.__shikiVerifyEditableDrag;
					if (!state?.blockId) return null;
					const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
					const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${state.blockId}"]\`)];
					state.after = blockLines.map(line => line.scrollLeft);
					return state;
				})()`,
			);
		}
	}

	if (mobile) {
		await evaluate(
			activeWsUrl,
			`(async () => {
				const app = window.app;
				const plugin = app.plugins.plugins['${PLUGIN_ID}'];
				const file = app.vault.getAbstractFileByPath('feature-test.md');
				const leaf = app.workspace.getLeaf(false);
				await leaf.openFile(file, { state: { mode: 'source', source: true } });
				const view = leaf.view;
				if (view?.setState) await view.setState({ file: file.path, mode: 'source', source: true }, { history: false });
				await new Promise(resolve => setTimeout(resolve, 750));
				if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
				await new Promise(resolve => setTimeout(resolve, 750));
				return {
					isSourceMode: view?.getMode?.() === 'source',
					sourceState: view?.getState?.(),
					editableLines: view?.contentEl?.querySelectorAll('.shiki-editing-codeblock-line')?.length ?? 0,
				};
			})()`,
		);
		await measureEditableGestureSet(activeWsUrl, '__shikiVerifyEditableSource', 'source');
	}

	const sourceModeState = await evaluate(
		activeWsUrl,
		`(async () => {
			const app = window.app;
			const plugin = app.plugins.plugins['shiki-highlighter'];
			const file = app.vault.getAbstractFileByPath('feature-test.md');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'source', source: true } });
			const view = leaf.view;
			if (view?.setState) await view.setState({ file: file.path, mode: 'source', source: true }, { history: false });
			await new Promise(resolve => setTimeout(resolve, 750));
			if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
			await new Promise(resolve => setTimeout(resolve, 750));
			if (!file || !view?.editor) {
				return {
					sourceMode: view?.getMode?.() ?? null,
					editorMissing: true,
					markerWasPresent: false,
					markerInserted: false,
					markerInEditor: false,
					markerOnDisk: false,
				};
			}
			const editor = view.editor;
			const before = editor.getValue?.() ?? '';
			const marker = '${SOURCE_MODE_EDIT_MARKER}';
			const markerWasPresent = before.includes(marker);
			if (!markerWasPresent) {
				const withTrailingNewline = before.endsWith('\\n') || before.length === 0 ? before : before + '\\n';
				editor.setValue(withTrailingNewline + marker);
				await new Promise(resolve => setTimeout(resolve, 700));
				if (typeof view.save === 'function') await view.save();
				else if (app?.vault?.modify && typeof app?.vault?.modify === 'function') await app.vault.modify(file, before + marker);
				await new Promise(resolve => setTimeout(resolve, 700));
			}
			const after = editor.getValue?.() ?? '';
			const onDisk = await app.vault.cachedRead(file);
			return {
				sourceMode: view?.getMode?.() ?? null,
				editorMissing: false,
				markerWasPresent,
				markerInserted: !markerWasPresent,
				markerInEditor: after.includes(marker),
				markerOnDisk: onDisk.includes(marker),
			};
		})()`,
	);

	const finalResult = await evaluate(
		activeWsUrl,
		`(async () => {
			for (let i = 0; i < 300 && !window.app?.plugins; i++) await new Promise(resolve => setTimeout(resolve, 100));
			if (!window.app?.plugins) throw new Error('Obsidian app was not ready');
			const app = window.app;
			const state = globalThis.__shikiVerifyState;
			const editableSwipe = globalThis.__shikiVerifyEditableSwipe ?? null;
			const editableVertical = globalThis.__shikiVerifyEditableVertical ?? null;
			const editableWheel = globalThis.__shikiVerifyEditableWheel ?? null;
			const editableDrag = globalThis.__shikiVerifyEditableDrag ?? null;
			const editableSource = globalThis.__shikiVerifyEditableSource ?? null;
			const monacoHorizontal = globalThis.__shikiVerifyMonacoHorizontal ?? null;
			const mobileNativeTap = globalThis.__shikiVerifyMobileNativeTap ?? null;
			const plugin = app.plugins.plugins['${PLUGIN_ID}'];
			await new Promise(resolve => setTimeout(resolve, 1000));
			if (plugin?.updateCm6Plugin) await plugin.updateCm6Plugin();
			await new Promise(resolve => setTimeout(resolve, 500));
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const editorTokens = [...editorRoot.querySelectorAll('.cm-content [class*="shiki"], .cm-content [style*="color"]')].map(el => ({
				text: el.textContent,
				className: el.className,
				style: el.getAttribute('style'),
			}));
			const fencedEditorTokens = editorTokens.filter(token =>
				['List', 'intervals', 'startIndex', 'Sort'].some(text => token.text?.includes(text))
			);
			const editableCodeBlockLines = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-codeblock-line')].map(el => ({
				text: el.textContent,
				className: el.className,
				style: el.getAttribute('style'),
				blockId: el.getAttribute('data-shiki-editing-block-id'),
				overflowX: getComputedStyle(el).overflowX,
				touchAction: getComputedStyle(el).touchAction,
				clientWidth: el.clientWidth,
				scrollWidth: el.scrollWidth,
			}));
			const csharpLine = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-codeblock-line')].find(el =>
				el.textContent?.includes('List<int[]> intervals')
			);
			let editableScrollSync = null;
			if (csharpLine) {
				const blockId = csharpLine.getAttribute('data-shiki-editing-block-id');
				const blockLines = [...editorRoot.querySelectorAll(\`.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="\${blockId}"]\`)];
				csharpLine.scrollLeft = 96;
				csharpLine.dispatchEvent(new Event('scroll', { bubbles: false }));
				await new Promise(resolve => requestAnimationFrame(resolve));
				editableScrollSync = {
					blockId,
					lineCount: blockLines.length,
					sourceScrollLeft: csharpLine.scrollLeft,
					scrollLefts: blockLines.map(el => el.scrollLeft),
					hasOverflowingLine: blockLines.some(el => el.scrollWidth > el.clientWidth),
					allLinesClipToBlock: blockLines.every(el => el.getBoundingClientRect().right <= el.closest('.cm-content').getBoundingClientRect().right + 1),
				};
			}
			const editableLineNumbers = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-line-number')].map(el => el.textContent);
			const sourceModeMonacoBlocks = editorRoot.querySelectorAll('.cm-content .shiki-monaco-codeblock, .cm-content .shiki-monaco-block').length;
			return {
				...state,
				editorTokens,
				fencedEditorTokens,
				editableCodeBlockLines,
				editableScrollSync,
				editableSwipe,
				editableVertical,
				editableWheel,
				editableDrag,
				editableSource,
				monacoHorizontal,
				mobileNativeTap,
				editableLineNumbers,
				sourceModeMonacoBlocks,
			};
		})()`,
	);
	return {
		...finalResult,
		sourceModeState,
	};
}

function validateResult(label, result, { enforcePluginLoadMs = ENFORCE_PLUGIN_LOAD_MS } = {}) {
	const normalizeText = text => (text ?? '').replace(/\u00a0/g, ' ');
	const uniqueReadingBlocks = new Set(result.codeBlocks.map(block => block.text)).size;
	const uniqueLivePreviewBlocks = new Set(result.livePreviewCodeBlocks.map(block => block.text)).size;
	assert(result.loadError === null, `${label}: plugin load failed`, result.loadError);
	assert(result.pluginLoaded, `${label}: plugin was not loaded`, result);
	assert(result.settingsTabLoaded, `${label}: settings tab was not loaded`, result);
	assert(result.highlighterLoaded, `${label}: highlighter did not lazy-load`, result);
	assert(result.activeFile === 'feature-test.md', `${label}: feature note was not active`, result);
	assert(result.tokenSummary.lines === 1 && result.tokenSummary.firstLineTokens > 0, `${label}: tokenization failed`, result);
	assert(result.renderedText.includes('Perf') && result.renderedText.includes('const z'), `${label}: direct EC render failed`, result);
	assert(result.customLanguageOdinSupported, `${label}: custom language was not available`, result);
	assert(result.disabledLanguageReturns === null, `${label}: disabled language still returned tokens`, result);
	assert(result.themeSelection.light === 'runtime-selected-light-theme', `${label}: light mode did not use saved light theme setting`, result);
	assert(result.themeSelection.dark === 'runtime-selected-dark-theme', `${label}: dark mode did not use saved dark theme setting`, result);
	assert(result.dynamicThemeSelection.light === 'github-light-default', `${label}: dynamic light theme setting was not applied`, result);
	assert(result.dynamicThemeSelection.dark === 'github-dark-default', `${label}: dynamic dark theme setting was not applied`, result);
	if (VERIFY_READING_MODE || result.isMobile) {
		assert(uniqueReadingBlocks >= 4, `${label}: expected rendered reading surfaces for each fenced block`, result);
		assert(
			result.codeBlocks.some(block => block.hasMonacoEditor && block.hasEditorHook && block.viewLines > 0),
			`${label}: Reading mode rendered wrappers without a hydrated Monaco editor`,
			result,
		);
		assert(result.codeBlocks.some(block => normalizeText(block.text).includes('const') && normalizeText(block.text).includes('console.log')), `${label}: TypeScript block missing`, result);
		assert(
			result.codeBlocks.some(block => normalizeText(block.text).includes('old line') && normalizeText(block.text).includes('new line')),
			`${label}: diff block missing`,
			result,
		);
		assert(
			result.codeBlocks.some(block => normalizeText(block.text).includes('package main')),
			`${label}: custom Odin block missing`,
			result,
		);
		assert(
			result.inline.some(text => text.includes('const inlineValue')),
			`${label}: inline highlighting missing`,
			result,
		);
	}
	assert(
		uniqueLivePreviewBlocks >= 1 ||
		result.livePreviewCodeBlocks.some(block => block.text.includes('List<int[]>') && block.text.includes('intervals.Sort')) ||
			result.fencedEditorTokens.some(token => token.text.includes('List')) ||
			result.fencedEditorTokens.some(token => token.text.includes('Sort')),
		`${label}: C# block missing from both live-preview and active editable editor`,
		result,
	);
	assert(
		result.livePreviewCodeBlocks.length === 0 || result.livePreviewCodeBlocks.some(block => block.hasMonacoEditor && block.hasEditorHook && block.viewLines > 0),
		`${label}: Live Preview rendered wrappers without a hydrated Monaco editor`,
		result,
	);
	assert(result.editorTokens.length > 0, `${label}: editor Shiki highlighting missing`, result);
	assert(result.fencedEditorTokens.length >= 4, `${label}: editable fenced code block Shiki tokens missing`, result);
	assert(result.sourceModeMonacoBlocks === 0, `${label}: Source mode mounted Monaco surfaces`, result);
	assert(result.sourceModeState, `${label}: Source mode persistence state was not captured`, result);
	assert(!result.sourceModeState.editorMissing, `${label}: Source mode editor was not available`, result.sourceModeState);
	assert(result.sourceModeState.markerInEditor, `${label}: Source mode marker was not present in editor`, result.sourceModeState);
	assert(result.sourceModeState.markerOnDisk, `${label}: Source mode marker did not persist to disk`, result.sourceModeState);
	if (result.isMobile) {
		assert(result.mobileNativeTap !== null, `${label}: mobile native tap was not measured`, result);
		assert(result.mobileNativeTap.editorHasFocus, `${label}: mobile tap inside Monaco did not keep Obsidian editor focused`, result.mobileNativeTap);
		assert(!result.mobileNativeTap.activeElementInMonaco, `${label}: mobile tap focused Monaco instead of Obsidian editor`, result.mobileNativeTap);
		assert(result.mobileNativeTap.cursor?.line === result.mobileNativeTap.csharpLine, `${label}: mobile tap did not move Obsidian cursor into code block`, result.mobileNativeTap);
		assert(result.monacoHorizontal !== null, `${label}: Monaco horizontal touch scroll was not measured`, result);
		assert(result.monacoHorizontal.before?.hasOverflow, `${label}: Monaco horizontal touch target did not overflow`, result.monacoHorizontal);
		assert(
			result.monacoHorizontal.after?.scrollLeft > result.monacoHorizontal.before?.scrollLeft,
			`${label}: Monaco horizontal touch drag did not scroll code horizontally`,
			result.monacoHorizontal,
		);
		assert(
			result.monacoHorizontal.before?.noteScrollWidth === null || result.monacoHorizontal.before?.noteScrollWidth <= result.monacoHorizontal.before?.noteClientWidth + 1,
			`${label}: Monaco block expanded the note horizontal scroll width`,
			result.monacoHorizontal,
		);
		assert(result.editableVertical !== null, `${label}: editable fenced code block vertical touch scroll was not measured`, result);
		assert(result.editableVertical.scrollable, `${label}: editable fenced code block vertical touch scroll had no scrollable editor`, result);
	}
	if (enforcePluginLoadMs) {
		assert(result.measurements.pluginLoadMs < 50, `${label}: plugin load exceeded 50ms`, result.measurements);
	}
}

async function main() {
	assert(
		existsSync(path.join(PLUGIN_SOURCE_DIR, 'main.js')) && (BRAT_INSTALL || existsSync(path.join(PLUGIN_SOURCE_DIR, 'modern-monaco.js'))),
		'plugin artifacts are missing. Run bun run build first or set OBSIDIAN_VERIFY_PLUGIN_DIR.',
		{ pluginSourceDir: PLUGIN_SOURCE_DIR, bratInstall: BRAT_INSTALL },
	);
	let existingTarget = OBSIDIAN_LAUNCH_MODE === 'reuse' || OBSIDIAN_LAUNCH_MODE === 'fresh' ? await findTarget() : null;
	if (OBSIDIAN_LAUNCH_MODE === 'fresh') {
		await closeOwnedTarget(existingTarget);
		await killOwnedPortProcesses();
		existingTarget = null;
	}
	if (OBSIDIAN_LAUNCH_MODE === 'reuse') {
		await assertOwnedTarget(existingTarget);
	}
	const reuseTarget = OBSIDIAN_LAUNCH_MODE === 'reuse' && existingTarget ? existingTarget : null;
	prepareVault({ resetUserData: !reuseTarget && OBSIDIAN_LAUNCH_MODE !== 'existing' });
	const obsidian = reuseTarget ? null : launchObsidian();
	const output = [];
	obsidian?.stdout.on('data', data => output.push(data.toString()));
	obsidian?.stderr.on('data', data => output.push(data.toString()));
	let target = null;
	let stopped = false;
	const stop = async () => {
		if (!stopped) {
			stopped = true;
			if (OBSIDIAN_LAUNCH_MODE !== 'existing' && OBSIDIAN_LAUNCH_MODE !== 'reuse' && OBSIDIAN_LAUNCH_MODE !== 'fresh') {
				await closeTarget(target);
			}
			if (OBSIDIAN_LAUNCH_MODE !== 'reuse' && OBSIDIAN_LAUNCH_MODE !== 'fresh') {
				obsidian?.kill();
			}
		}
	};
	process.on('exit', () => {
		if (OBSIDIAN_LAUNCH_MODE !== 'reuse' && OBSIDIAN_LAUNCH_MODE !== 'fresh') {
			obsidian?.kill();
		}
	});
	process.on('SIGINT', () => {
		if (OBSIDIAN_LAUNCH_MODE !== 'reuse' && OBSIDIAN_LAUNCH_MODE !== 'fresh') {
			obsidian?.kill();
		}
		process.exit(130);
	});

	try {
		if (OBSIDIAN_LAUNCH_MODE === 'existing') {
			await relaunchExistingTarget();
		}
		target = await waitForAppTarget().catch(error => {
			error.message = `${error.message}\nLaunch mode: ${OBSIDIAN_LAUNCH_MODE}\nLaunch output:\n${output.join('')}`;
			throw error;
		});
		const wsUrl = target.webSocketDebuggerUrl;
		const trust = await trustVault(wsUrl);
		const desktopWsUrl = await setMobileEmulation(wsUrl, false);
		let desktop = null;
		let mobile = null;
		if (VERIFY_TARGET !== 'mobile') {
			desktop = await verifyFeatureSet(desktopWsUrl, false);
			validateResult('desktop', desktop);
		}
		if (VERIFY_TARGET !== 'desktop') {
			mobile = await verifyFeatureSet(desktopWsUrl, true);
			validateResult('mobile-emulation', mobile, { enforcePluginLoadMs: VERIFY_TARGET === 'mobile' ? ENFORCE_PLUGIN_LOAD_MS : false });
		}
		await setMobileEmulation(desktopWsUrl, false);
		console.log(JSON.stringify({ trust, desktop, mobile }, null, 2));
	} finally {
		await stop();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
