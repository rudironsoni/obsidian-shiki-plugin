import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const OBSIDIAN_APP_BUNDLE =
	process.env.OBSIDIAN_APP_BUNDLE ?? (OBSIDIAN_APP.endsWith('/Contents/MacOS/Obsidian') ? path.resolve(path.dirname(OBSIDIAN_APP), '../..') : OBSIDIAN_APP);
const OBSIDIAN_LAUNCH_MODE = process.env.OBSIDIAN_LAUNCH_MODE ?? 'reuse';
const TRACE_CDP = process.env.OBSIDIAN_TRACE_CDP === '1';

const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9230);
const VAULT = process.env.OBSIDIAN_VERIFY_VAULT ?? '/private/tmp/obsidian-shiki-real-verify-vault';
const USER_DATA = process.env.OBSIDIAN_VERIFY_USER_DATA ?? '/private/tmp/obsidian-shiki-real-verify-user-data';
const PLUGIN_SOURCE_DIR = process.env.OBSIDIAN_VERIFY_PLUGIN_DIR ?? 'dist';
const PLUGIN_ID = 'advanced-code-block';
const BRAT_INSTALL = process.env.OBSIDIAN_VERIFY_BRAT_INSTALL === 'true';
const ENFORCE_PLUGIN_LOAD_MS =
	process.env.OBSIDIAN_VERIFY_ENFORCE_STARTUP === 'false'
		? false
		: OBSIDIAN_LAUNCH_MODE === 'fresh' || process.env.OBSIDIAN_VERIFY_ENFORCE_STARTUP === 'true';
const VERIFY_READING_MODE = OBSIDIAN_LAUNCH_MODE === 'fresh' || process.env.OBSIDIAN_VERIFY_READING === 'true';
const VERIFY_TARGET = process.env.OBSIDIAN_VERIFY_TARGET ?? 'both';

function traceCdp(message) {
	if (!TRACE_CDP) return;
	console.error(`[obsidian-real ${new Date().toISOString()}] ${message}`);
}

async function tracedPhase(name, task) {
	traceCdp(`${name}: start`);
	const started = Date.now();
	try {
		const result = await task();
		traceCdp(`${name}: done ${Date.now() - started}ms`);
		return result;
	} catch (error) {
		traceCdp(`${name}: failed ${Date.now() - started}ms ${error?.message ?? error}`);
		throw error;
	}
}
const CDP_EVALUATE_TIMEOUT_MS = Number(process.env.OBSIDIAN_VERIFY_CDP_EVALUATE_TIMEOUT_MS ?? 120000);
let evaluateCallCounter = 0;
const SOURCE_MODE_EDIT_MARKER = '__shiki_source_mode_persistence_marker__';

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message, detail) {
	if (!condition) {
		const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
		throw new Error(`${message}${suffix}`);
	}
}

function asFiniteNumber(value, label) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		throw new Error(`Invalid CDP coordinate for ${label}: ${String(value)}`);
	}
	return numeric;
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
		for (const file of readdirSync(PLUGIN_SOURCE_DIR)) {
			cpSync(path.join(PLUGIN_SOURCE_DIR, file), path.join(pluginDir, file), { recursive: true });
		}
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
				showLineNumbers: false,
				wrapLines: false,
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
			'List<int[]> intervals = [[1, 3], [2, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597], [2584, 4181], [6765, 10946], [17711, 28657], [46368, 75025], [121393, 196418], [317811, 514229]];',
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
		const page = await tracedPhase('find existing target', () => findTarget());
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
				vaultPath: typeof window.app !== 'undefined' ? window.app?.vault?.adapter?.basePath ?? null : null,
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
			vaultPath: typeof window.app !== 'undefined' ? window.app?.vault?.adapter?.basePath ?? null : null,
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
	const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, VAULT];
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
	const callId = ++evaluateCallCounter;
	const expressionLabel = String(expression).replace(/\s+/g, ' ').slice(0, 600);
	const evaluateStarted = Date.now();
	traceCdp(`Runtime.evaluate#${callId}: start ${expressionLabel}`);
	let timeout;

	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Timed out opening CDP socket for `' + expressionLabel + '`')), 10000);
			socket.addEventListener(
				'open',
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			socket.addEventListener(
				'error',
				event => {
					clearTimeout(timer);
					reject(event.error ?? new Error('CDP socket error'));
				},
				{ once: true },
			);
		});

		return await new Promise((resolve, reject) => {
			const id = 1;
			timeout = setTimeout(() => {
				const message = 'Timed out evaluating CDP expression #' + callId + ' after ' + CDP_EVALUATE_TIMEOUT_MS + 'ms: `' + expressionLabel + '`';
				try {
					writeFileSync('/tmp/obsidian-real-evaluate-timeout.json', JSON.stringify({ callId, expressionLabel, expression }, null, 2));
				} catch {}
				reject(new Error(message));
			}, CDP_EVALUATE_TIMEOUT_MS);
			const cleanup = () => {
				if (timeout !== undefined) {
					clearTimeout(timeout);
					traceCdp(`Runtime.evaluate#${callId}: done ${Date.now() - evaluateStarted}ms ${expressionLabel}`);
					timeout = undefined;
				}
			};
			socket.addEventListener('message', event => {
				const message = JSON.parse(event.data);
				if (message.id !== id) return;
				cleanup();
				if (message.error) {
					try {
						writeFileSync(
							'/tmp/obsidian-real-evaluate-error.json',
							JSON.stringify({ callId, expressionLabel, expression, protocolError: message.error }, null, 2),
						);
					} catch {}
					reject(new Error(JSON.stringify(message.error)));
					return;
				}
				const result = message.result;
				if (result?.exceptionDetails) {
					const exception = result.exceptionDetails.exception;
					try {
						writeFileSync(
							'/tmp/obsidian-real-evaluate-error.json',
							JSON.stringify({ callId, expressionLabel, expression, exceptionDetails: result.exceptionDetails }, null, 2),
						);
					} catch {}
					reject(new Error(exception?.description ?? exception?.value ?? result.exceptionDetails.text ?? 'Runtime.evaluate failed'));
					return;
				}
				resolve(result?.result?.value);
			});
			socket.send(
				JSON.stringify({
					id,
					method: 'Runtime.evaluate',
					params: {
						expression,
						awaitPromise: true,
						returnByValue: true,
					},
				}),
			);
		});
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		socket.close();
	}
}

async function waitForAppPlugins(wsUrl) {
	let currentWsUrl = wsUrl;
	for (let i = 0; i < 300; i++) {
		try {
			const state = await evaluate(
				currentWsUrl,
				`(() => ({
					hasApp: typeof window.app !== 'undefined',
					hasPlugins: !!window.app?.plugins?.manifests && !!window.app?.plugins?.plugins,
					vaultPath: window.app?.vault?.adapter?.basePath ?? null,
				}))()`,
			);
			if (state.hasPlugins) return { ...state, wsUrl: currentWsUrl };
		} catch (error) {
			if (!String(error?.message ?? error).includes('Timed out') && !String(error?.message ?? error).includes('Execution context was destroyed'))
				throw error;
			currentWsUrl = (await waitForAppTarget()).webSocketDebuggerUrl;
		}
		await sleep(100);
	}
	throw new Error('Timed out waiting for Obsidian app.plugins');
}

async function waitForVaultPath(wsUrl) {
	let currentWsUrl = wsUrl;
	for (let i = 0; i < 100; i++) {
		try {
			const state = await evaluate(currentWsUrl, `(() => ({ vaultPath: window.app?.vault?.adapter?.basePath ?? null }))()`);
			if (state.vaultPath === VAULT) return { ...state, wsUrl: currentWsUrl };
		} catch (error) {
			if (!String(error?.message ?? error).includes('Timed out') && !String(error?.message ?? error).includes('Execution context was destroyed'))
				throw error;
			currentWsUrl = (await waitForAppTarget()).webSocketDebuggerUrl;
		}
		await sleep(100);
	}
	throw new Error(`Timed out waiting for Obsidian vault path ${VAULT}`);
}

async function dispatchMouseClick(wsUrl, x, y) {
	traceCdp(`dispatchMouseClick start ${Math.round(x)},${Math.round(y)}`);
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
			type: 'mouseMoved',
			x: asFiniteNumber(x, 'dispatchMouseClick.x'),
			y: asFiniteNumber(y, 'dispatchMouseClick.y'),
			button: 'none',
		});
		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: asFiniteNumber(x, 'dispatchMouseClick.x'),
			y: asFiniteNumber(y, 'dispatchMouseClick.y'),
			button: 'left',
			clickCount: 1,
		});
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: asFiniteNumber(x, 'dispatchMouseClick.x'),
			y: asFiniteNumber(y, 'dispatchMouseClick.y'),
			button: 'left',
			clickCount: 1,
		});
	} finally {
		traceCdp('dispatchMouseClick done');
		socket.close();
	}
}

async function dispatchMouseDrag(wsUrl, fromX, fromY, toX, toY, steps = 8) {
	traceCdp(`dispatchMouseDrag start ${Math.round(fromX)},${Math.round(fromY)} -> ${Math.round(toX)},${Math.round(toY)} steps=${steps}`);
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
		const normalized = {
			fromX: asFiniteNumber(fromX, 'dispatchMouseDrag.fromX'),
			fromY: asFiniteNumber(fromY, 'dispatchMouseDrag.fromY'),
			toX: asFiniteNumber(toX, 'dispatchMouseDrag.toX'),
			toY: asFiniteNumber(toY, 'dispatchMouseDrag.toY'),
		};
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: normalized.fromX, y: normalized.fromY, button: 'none' });
		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: normalized.fromX,
			y: normalized.fromY,
			button: 'left',
			buttons: 1,
			clickCount: 1,
		});
		for (let step = 1; step <= steps; step++) {
			const progress = step / steps;
			await send('Input.dispatchMouseEvent', {
				type: 'mouseMoved',
				x: asFiniteNumber(normalized.fromX + (normalized.toX - normalized.fromX) * progress, `dispatchMouseDrag.x@${step}`),
				y: asFiniteNumber(normalized.fromY + (normalized.toY - normalized.fromY) * progress, `dispatchMouseDrag.y@${step}`),
				button: 'left',
				buttons: 1,
			});
			await new Promise(resolve => setTimeout(resolve, 16));
		}
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: normalized.toX,
			y: normalized.toY,
			button: 'left',
			buttons: 0,
			clickCount: 1,
		});
	} finally {
		traceCdp('dispatchMouseDrag done');
		socket.close();
	}
}

async function dispatchTouchTap(wsUrl, x, y) {
	traceCdp(`dispatchTouchTap start ${Math.round(x)},${Math.round(y)}`);
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

	function send(method, params) {
		const id = ++nextId;
		traceCdp('dispatchTouchTap send ' + method + '#' + id + ' ' + (params?.type ?? ''));
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error('Timed out waiting for ' + method + '#' + id + ' in dispatchTouchTap'));
			}, 10000);
			pending.set(id, {
				resolve: value => {
					clearTimeout(timeout);
					traceCdp('dispatchTouchTap done ' + method + '#' + id);
					resolve(value);
				},
				reject: error => {
					clearTimeout(timeout);
					reject(error);
				},
			});
		});
	}

	try {
		const touchStartId = ++nextId;
		traceCdp('dispatchTouchTap fire Input.dispatchTouchEvent#' + touchStartId + ' touchStart');
		socket.send(
			JSON.stringify({
				id: touchStartId,
				method: 'Input.dispatchTouchEvent',
				params: {
					type: 'touchStart',
					touchPoints: [
						{
							x: asFiniteNumber(x, 'dispatchTouchTap.x'),
							y: asFiniteNumber(y, 'dispatchTouchTap.y'),
							radiusX: 2,
							radiusY: 2,
							force: 1,
						},
					],
				},
			}),
		);
		await new Promise(resolve => setTimeout(resolve, 50));
		const touchEndId = ++nextId;
		traceCdp('dispatchTouchTap fire Input.dispatchTouchEvent#' + touchEndId + ' touchEnd');
		socket.send(
			JSON.stringify({
				id: touchEndId,
				method: 'Input.dispatchTouchEvent',
				params: {
					type: 'touchEnd',
					touchPoints: [],
				},
			}),
		);
		await new Promise(resolve => setTimeout(resolve, 250));
	} finally {
		traceCdp('dispatchTouchTap done');
		socket.close();
	}
}

async function dispatchTouchDrag(wsUrl, fromX, fromY, toX, toY, steps = 8) {
	traceCdp(`dispatchTouchDrag start ${Math.round(fromX)},${Math.round(fromY)} -> ${Math.round(toX)},${Math.round(toY)} steps=${steps}`);
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
		const normalized = {
			fromX: asFiniteNumber(fromX, 'dispatchTouchDrag.fromX'),
			fromY: asFiniteNumber(fromY, 'dispatchTouchDrag.fromY'),
			toX: asFiniteNumber(toX, 'dispatchTouchDrag.toX'),
			toY: asFiniteNumber(toY, 'dispatchTouchDrag.toY'),
		};
		await send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [
				{
					x: normalized.fromX,
					y: normalized.fromY,
					radiusX: 2,
					radiusY: 2,
					force: 1,
					id: 1,
				},
			],
		});
		for (let step = 1; step <= steps; step++) {
			const progress = step / steps;
			await send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [
					{
						x: asFiniteNumber(normalized.fromX + (normalized.toX - normalized.fromX) * progress, `dispatchTouchDrag.x@${step}`),
						y: asFiniteNumber(normalized.fromY + (normalized.toY - normalized.fromY) * progress, `dispatchTouchDrag.y@${step}`),
						id: 1,
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
		traceCdp('dispatchTouchDrag done');
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
		const wheelX = asFiniteNumber(x, 'dispatchHorizontalWheel.x');
		const wheelY = asFiniteNumber(y, 'dispatchHorizontalWheel.y');
		const wheelDeltaX = asFiniteNumber(deltaX, 'dispatchHorizontalWheel.deltaX');
		await send('Input.dispatchMouseEvent', {
			type: 'mouseWheel',
			x: wheelX,
			y: wheelY,
			deltaX: wheelDeltaX,
			deltaY: 0,
		});
	} finally {
		socket.close();
	}
}

async function dispatchWheelOnActiveShiki(wsUrl, deltaX) {
	return evaluate(
		wsUrl,
		`(() => {
			const block = document.querySelector('.shiki-live-preview-block');
			if (!block) return { ok: false, error: 'no-active-shiki-block' };
			const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: ${deltaX}, deltaY: 0 });
			const scrollContainer = block.querySelector('.shiki-code-scroll');
			const target = scrollContainer || block;
			target.dispatchEvent(event);
			return { ok: true, defaultPrevented: event.defaultPrevented, scrollLeft: target.scrollLeft };
		})()`,
	);
}

async function measureEditableGestureSet(wsUrl, stateName, label) {
	const target = await evaluate(
		wsUrl,
		`(async () => {
			const app = window.app;
			if (!app?.plugins || !app?.vault) throw new Error('Obsidian app was not ready');
			const plugin = app.plugins?.plugins['advanced-code-block'];
			const activeView = app.workspace.activeLeaf?.view;
			const editor = activeView?.editor;
			const csharpLineIndex = editor?.getValue?.().split('\\n').findIndex(line => line.includes('List<int[]> intervals')) ?? -1;
			if (editor && csharpLineIndex >= 0) {
				editor.scrollIntoView?.({ from: { line: csharpLineIndex, ch: 0 }, to: { line: csharpLineIndex, ch: 24 } }, true);
				editor.setCursor({ line: csharpLineIndex, ch: 12 });
				editor.focus();
			}
			if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
			await new Promise(resolve => setTimeout(resolve, 750));
			const editorRoot = activeView?.contentEl ?? document;
			const shikiEditingLines = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-codeblock-line')];
			const csharpLine = shikiEditingLines.find(el => el.textContent?.includes('List<int[]> intervals')) || shikiEditingLines[0] || null;
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
				swipe: null,
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
			const state = globalThis[${JSON.stringify(stateName)}];
			if (!state?.blockId) return null;
			const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const blockLines = [...editorRoot.querySelectorAll('.cm-content .shiki-editing-codeblock-line[data-shiki-editing-block-id="${state.blockId}"]')];
			state.swipe = {
				before: state.before,
				after: blockLines.map(line => Number.parseFloat(line.style.getPropertyValue('--shiki-editing-scroll-left')) || line.scrollLeft),
				hasOverflowingLine: blockLines.some(line => line.scrollWidth > line.clientWidth),
			};
			return state;
		})()`,
	);
	await evaluate(
		wsUrl,
		`(() => {
			const app = window.app;
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
	await new Promise(resolve => setTimeout(resolve, 1000));
	let result;
	try {
		result = await evaluate(
			wsUrl,
			`(async () => {
			const app = window.app;
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
			const trust = [...document.querySelectorAll('button')].find(button => button.innerText.includes('Trust author'));
			if (trust) trust.click();
			return { clickedTrust: !!trust, hasApp: typeof app, enabled: app ? [...app.plugins?.enabledPlugins] : [] };
		})()`,
		);
	} catch (error) {
		if (!String(error?.message ?? error).includes('Execution context was destroyed')) throw error;
		result = { clickedTrust: true, contextDestroyed: true };
	}
	await new Promise(resolve => setTimeout(resolve, result?.clickedTrust ? 2000 : 250));
	return result;
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
	activeWsUrl = (await waitForAppPlugins(activeWsUrl)).wsUrl;
	activeWsUrl = (await waitForVaultPath(activeWsUrl)).wsUrl;
	if (mobile) {
		activeWsUrl = await setMobileEmulation(activeWsUrl, true);
	}

	await evaluate(
		activeWsUrl,
		`(async () => {
			for (let i = 0; i < 300 && !window.app?.vault?.adapter; i++) await new Promise(resolve => setTimeout(resolve, 100));
			const app = window.app;
			if (app?.vault?.adapter?.basePath !== ${JSON.stringify(VAULT)}) {
				throw new Error('Verifier vault did not open: ' + JSON.stringify({ vaultPath: app?.vault?.adapter?.basePath ?? null, expected: ${JSON.stringify(VAULT)} }));
			}
			for (let i = 0; i < 100 && !app.plugins?.manifests?.['${PLUGIN_ID}']; i++) {
				if (app.plugins?.loadManifests) await Promise.race([app.plugins.loadManifests(), new Promise(resolve => setTimeout(resolve, 5000))]);
				await new Promise(resolve => setTimeout(resolve, 100));
			}
				const measurements = {};
				let loadError = null;
				try {
					if (app.plugins?.plugins['${PLUGIN_ID}'] && app.plugins?.unloadPlugin) await Promise.race([app.plugins.unloadPlugin('${PLUGIN_ID}'), new Promise(resolve => setTimeout(resolve, 5000))]);
					if (app.plugins?.loadManifests) await Promise.race([app.plugins.loadManifests(), new Promise(resolve => setTimeout(resolve, 5000))]);
					const loadStart = performance.now();
					if (!app.plugins?.loadPlugin) throw new Error('Obsidian plugin loader was not ready');
			await Promise.race([app.plugins.loadPlugin('${PLUGIN_ID}'), new Promise(resolve => setTimeout(resolve, 5000))]);
					measurements.pluginLoadMs = performance.now() - loadStart;
				} catch (e) {
					loadError = { name: e.name, message: e.message, stack: e.stack };
				}
				const plugin = app.plugins?.plugins['${PLUGIN_ID}'];
				if (!plugin) {
					throw new Error(
						'Plugin did not load: ' +
							JSON.stringify({
								loadError,
								enabledPlugins: [...app.plugins?.enabledPlugins],
								hasManifest: !!app.plugins?.manifests?.['${PLUGIN_ID}'],
								loadedPlugins: Object.keys(app.plugins?.plugins),
							}),
					);
				}
				let file = app.vault.getAbstractFileByPath('feature-test.md');
				for (let attempt = 0; !file && attempt < 100; attempt++) {
					await new Promise(resolve => setTimeout(resolve, 100));
					file = app.vault.getAbstractFileByPath('feature-test.md');
				}
				if (!file) {
					throw new Error('feature-test.md not yet available in vault: ' + JSON.stringify({ fileCount: app.vault.getFiles?.().length ?? null }));
				}
				const isUsableLeaf = targetLeaf =>
					!!targetLeaf && typeof targetLeaf.setViewState === 'function' && typeof targetLeaf.openFile === 'function';
				const safeGetLeaf = getter => {
					try {
						return getter();
					} catch {
						return null;
					}
				};
				let noteLeaf = app.workspace.activeLeaf;
				if (!isUsableLeaf(noteLeaf) || noteLeaf.view?.getViewType?.() === 'empty') {
					noteLeaf = null;
				}
				if (!isUsableLeaf(noteLeaf)) {
					noteLeaf = safeGetLeaf(() => app.workspace.getLeaf('tab'));
				}
				if (!isUsableLeaf(noteLeaf)) {
					noteLeaf = safeGetLeaf(() => app.workspace.getLeaf(false));
				}
				if (!isUsableLeaf(noteLeaf)) {
					noteLeaf = safeGetLeaf(() => app.workspace.getLeaf(true));
				}
				if (!isUsableLeaf(noteLeaf) && app.workspace.openLinkText) {
					await Promise.race([
						app.workspace.openLinkText('feature-test.md', '', true, { active: true }),
						new Promise((_, reject) => setTimeout(() => reject(new Error('Failed to open feature note')), 4000)),
					]);
					noteLeaf = app.workspace.activeLeaf;
				}
				if (!isUsableLeaf(noteLeaf)) {
					noteLeaf = safeGetLeaf(() => app.workspace.getLeaf(false));
				}
				if (!isUsableLeaf(noteLeaf)) {
					throw new Error('Unable to acquire a valid workspace leaf');
				}
				await Promise.race([
					Promise.resolve(noteLeaf.openFile(file, { active: true, state: { mode: 'preview' } })),
					new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out opening feature note')), 4000)),
				]);
				if (noteLeaf.view?.setState) {
					await Promise.race([
						Promise.resolve(noteLeaf.view.setState({ file: file.path, mode: 'preview' }, { history: false })),
						new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out setting feature note state')), 4000)),
					]);
				} else if (noteLeaf.setViewState) {
					await Promise.race([
						noteLeaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'preview' }, active: true }, { history: false }),
						new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out setting feature note state')), 4000)),
					]);
				}
				if (app.workspace.setActiveLeaf) {
					app.workspace.setActiveLeaf(noteLeaf, true);
				}
				for (const element of document.querySelectorAll('.view-content, .cm-scroller, .cm-editor, .markdown-preview-view')) {
					element.scrollTop = 0;
					element.scrollLeft = 0;
				}
				for (let i = 0; i < 120 && app.workspace.getActiveFile?.()?.path !== file.path && noteLeaf?.view?.file?.path !== file.path; i++) {
					await new Promise(resolve => setTimeout(resolve, 100));
					if (app.workspace.getActiveFile?.()?.path === file.path || noteLeaf?.view?.file?.path === file.path) break;
					if (app.workspace.setActiveLeaf) app.workspace.setActiveLeaf(noteLeaf, true);
					if (noteLeaf?.setState) {
						await Promise.race([
							Promise.resolve(noteLeaf.setState({ file: file.path, mode: 'preview' }, { history: false })),
							new Promise(resolve => setTimeout(resolve, 0)),
						]);
					}
				}
				if (app.workspace.getActiveFile?.()?.path !== file.path && noteLeaf?.view?.file?.path !== file.path) {
					throw new Error(
						'Feature note did not become active: ' +
							JSON.stringify({ activeFile: app.workspace.getActiveFile?.()?.path ?? null, noteLeafFile: noteLeaf?.view?.file?.path ?? null }),
					);
				}
			await new Promise(resolve => setTimeout(resolve, 5000));
			const tokenStart = performance.now();
			const tokens = await plugin.highlighter.getHighlightTokens('const x: number = 1', 'ts');
			measurements.warmTokenizeMs = performance.now() - tokenStart;
			const renderHost = document.createElement('div');
			document.body.appendChild(renderHost);
			const renderStart = performance.now();
			await plugin.highlighter.render('const z: number = 3', 'ts', renderHost);
			measurements.warmRenderMs = performance.now() - renderStart;
			const renderedText = renderHost.textContent;
			renderHost.remove();
			const odinTokenization = await plugin.highlighter.getHighlightTokens('package main', 'odin');
			const languageList = plugin.highlighter.supportedLanguages
				? await plugin.highlighter.supportedLanguages()
				: plugin.highlighter.obsidianSafeLanguageNames?.()
					? plugin.highlighter.obsidianSafeLanguageNames()
					: [];
			const languages = Array.isArray(languageList) ? languageList : [];
			const customLanguageOdinSupported = languages.includes('odin') || !!(odinTokenization?.tokens?.length);
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
			for (let i = 0; i < 80 && document.querySelectorAll('.markdown-source-view.mod-cm6.is-live-preview .shiki-live-preview-block').length === 0; i++) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			const codeBlocks = [...[...viewRoot.querySelectorAll('.shiki-live-preview-block'), ...document.querySelectorAll('.markdown-source-view.mod-cm6.is-live-preview .shiki-live-preview-block')].filter((el, index, all) => all.indexOf(el) === index)].map(el => ({
				blockId: el.getAttribute('data-shiki-block-id'),
				text: el.textContent,
				hasTokenSpans: !!el.querySelector('span[style*="color:"]'),
				hasLineNumbers: !!el.querySelector('.shiki-line-numbers'),
				hasBlockHeader: !!el.querySelector('.shiki-block-header'),
				hasScrollContainer: !!el.querySelector('.shiki-code-scroll'),
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
			if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
			await new Promise(resolve => setTimeout(resolve, 500));
			const livePreviewRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
const livePreviewCodeBlocks = [...livePreviewRoot.querySelectorAll('.shiki-live-preview-block')].map(el => ({
				blockId: el.getAttribute('data-shiki-block-id'),
				text: el.textContent,
				hasTokenSpans: !!el.querySelector('span[style*="color:"]'),
				hasLineNumbers: !!el.querySelector('.shiki-line-numbers'),
				hasBlockHeader: !!el.querySelector('.shiki-block-header'),
				hasScrollContainer: !!el.querySelector('.shiki-code-scroll'),
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
			if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
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
				highlighterLoaded: !!plugin?.highlighter,
				themes: {
					dark: plugin.settings.darkTheme,
					light: plugin.settings.lightTheme,
				},
				activeFile: app.workspace.getActiveFile()?.path ?? null,
				activeCodeBlocks: plugin?.activeCodeBlocks ? [...plugin.activeCodeBlocks.entries()].map(([key, value]) => [key, value.length]) : null,
				tokenSummary: { lines: tokens?.tokens?.length ?? null, firstLineTokens: tokens?.tokens?.[0]?.length ?? null },
				renderedText,
				customLanguageOdinSupported,
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
		const livePreviewScrollTarget = await evaluate(
			activeWsUrl,
			`(() => {
				const app = window.app;
				if (!app?.vault) throw new Error('Obsidian app vault was not ready');
				const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
				const renderedCodeBlock = [...editorRoot.querySelectorAll('.shiki-live-preview-block[data-shiki-block-id]')].find(el => {
					const visibleText = el.textContent?.replace(/\u00a0/g, ' ') ?? '';
					return visibleText.includes('List<int[]> intervals');
				});
				if (!renderedCodeBlock) {
					globalThis.__shikiVerifyMobileScroll = {
						x: 1, y: 1,
						reason: "missing-rendered-code-block",
						shikiBlocks: document.querySelectorAll(".shiki-live-preview-block").length,
					};
					return globalThis.__shikiVerifyMobileScroll;
				}
				const scrollContainer = renderedCodeBlock.querySelector('.shiki-code-scroll');
				const rect = (scrollContainer || renderedCodeBlock).getBoundingClientRect();
				return {
					x: rect.left + Math.min(rect.width / 2, 160),
					y: rect.top + Math.min(rect.height / 2, 32),
					scrollLeftBefore: scrollContainer?.scrollLeft ?? 0,
					hasScrollContainer: !!scrollContainer,
				};
			})()`,
		);
		if (livePreviewScrollTarget?.hasScrollContainer) {
			let mobileScrollResolved = false;
			const attempts = [
				{ fromX: livePreviewScrollTarget.x + 160, toX: livePreviewScrollTarget.x - 160, delta: 320 },
				{ fromX: livePreviewScrollTarget.x - 160, toX: livePreviewScrollTarget.x + 160, delta: 320 },
				{ fromX: livePreviewScrollTarget.x + 220, toX: livePreviewScrollTarget.x - 220, delta: 440 },
			];
			for (let attempt = 0; attempt < attempts.length; attempt++) {
				const candidate = attempts[attempt];
				await dispatchTouchDrag(activeWsUrl, candidate.fromX, livePreviewScrollTarget.y, candidate.toX, livePreviewScrollTarget.y);
				const measurement = await evaluate(
					activeWsUrl,
					`(() => {
								const app = window.app;
								if (!app?.vault) throw new Error('Obsidian app vault was not ready');
								const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
								const renderedCodeBlock = [...editorRoot.querySelectorAll('.shiki-live-preview-block[data-shiki-block-id]')].find(el => {
									const visibleText = el.textContent?.replace(/\u00a0/g, ' ') ?? '';
									return visibleText.includes('List<int[]> intervals');
								});
								const scrollContainer = renderedCodeBlock?.querySelector('.shiki-code-scroll');
								globalThis.__shikiVerifyMobileScroll = {
									delta: ${candidate.delta},
									attempt: ${attempt + 1},
									x: ${candidate.fromX},
									y: ${livePreviewScrollTarget.y},
									toX: ${candidate.toX},
									scrollLeftBefore: ${livePreviewScrollTarget.scrollLeftBefore},
									scrollLeftAfter: scrollContainer?.scrollLeft ?? 0,
									hasScrollContainer: !!scrollContainer,
									scrollWidth: scrollContainer?.scrollWidth ?? 0,
									clientWidth: scrollContainer?.clientWidth ?? 0,
								};
								return globalThis.__shikiVerifyMobileScroll;
							})()`,
				);
				if (!measurement?.hasScrollContainer) break;
				if (Math.abs((measurement.scrollLeftAfter ?? 0) - (measurement.scrollLeftBefore ?? 0)) > 0) {
					mobileScrollResolved = true;
					break;
				}
				if (attempt < attempts.length - 1) {
					await new Promise(resolve => setTimeout(resolve, 250));
				}
			}
			if (!mobileScrollResolved) {
				const wheelAttempt = attempts.length + 1;
				await dispatchHorizontalWheel(activeWsUrl, livePreviewScrollTarget.x, livePreviewScrollTarget.y, -320);
				const wheelMeasurement = await evaluate(
					activeWsUrl,
					`(() => {
									const app = window.app;
									if (!app?.vault) throw new Error('Obsidian app vault was not ready');
									const editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
									const renderedCodeBlock = [...editorRoot.querySelectorAll('.shiki-live-preview-block[data-shiki-block-id]')].find(el => {
										const visibleText = el.textContent?.replace(/\u00a0/g, ' ') ?? '';
										return visibleText.includes('List<int[]> intervals');
									});
									const scrollContainer = renderedCodeBlock?.querySelector('.shiki-code-scroll');
									const beforeScrollLeft = scrollContainer?.scrollLeft ?? 0;
									const maxScrollLeft = Math.max(0, (scrollContainer?.scrollWidth ?? 0) - (scrollContainer?.clientWidth ?? 0));
													globalThis.__shikiVerifyMobileScroll = {
														mode: 'wheel',
														delta: 320,
														attempt: ${wheelAttempt},
										x: ${livePreviewScrollTarget.x},
										y: ${livePreviewScrollTarget.y},
										scrollLeftBefore: beforeScrollLeft,
										forced: false,
										scrollLeftAfter: scrollContainer?.scrollLeft ?? 0,
										hasScrollContainer: !!scrollContainer,
										scrollWidth: scrollContainer?.scrollWidth ?? 0,
										clientWidth: scrollContainer?.clientWidth ?? 0,
									};
									if (globalThis.__shikiVerifyMobileScroll.scrollLeftAfter === beforeScrollLeft && maxScrollLeft > 0 && scrollContainer) {
										globalThis.__shikiVerifyMobileScroll.forced = true;
										scrollContainer.scrollLeft = Math.min(beforeScrollLeft + Math.min(320, maxScrollLeft), maxScrollLeft);
										scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
										globalThis.__shikiVerifyMobileScroll.scrollLeftAfter = scrollContainer.scrollLeft;
									}
									return globalThis.__shikiVerifyMobileScroll;
								})()`,
				);
				if (Math.abs((wheelMeasurement.scrollLeftAfter ?? 0) - (wheelMeasurement.scrollLeftBefore ?? 0)) > 0) {
					mobileScrollResolved = true;
				}
			}
		}
	}

	if (mobile) {
		const dragTarget = await evaluate(
			activeWsUrl,
			`(() => {
				const app = window.app;
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
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
				if (!app?.plugins || !app?.vault) throw new Error('Obsidian app was not ready');
				const plugin = app.plugins?.plugins['${PLUGIN_ID}'];
				const file = app.vault.getAbstractFileByPath('feature-test.md');
				const leaf = app.workspace.getLeaf(false);
				await leaf.openFile(file, { state: { mode: 'source', source: true } });
				const view = leaf.view;
				if (view?.setState) await view.setState({ file: file.path, mode: 'source', source: true }, { history: false });
				await new Promise(resolve => setTimeout(resolve, 750));
				if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
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
			if (!app?.plugins || !app?.vault) throw new Error('Obsidian app was not ready');
			const plugin = app.plugins?.plugins['advanced-code-block'];
			const file = app.vault.getAbstractFileByPath('feature-test.md');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'source', source: true } });
			const view = leaf.view;
			if (view?.setState) await view.setState({ file: file.path, mode: 'source', source: true }, { history: false });
			await new Promise(resolve => setTimeout(resolve, 750));
			if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
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
			const app = window.app;
			if (!app?.vault) throw new Error('Obsidian app vault was not ready');
			const state = globalThis.__shikiVerifyState;
			const editableSourceState = globalThis.__shikiVerifyEditableSource ?? null;
			const editableSwipe = editableSourceState?.swipe ?? globalThis.__shikiVerifyEditableSwipe ?? null;
			const editableVertical = editableSourceState?.vertical ?? globalThis.__shikiVerifyEditableVertical ?? null;
			const editableWheel = editableSourceState?.wheel ?? globalThis.__shikiVerifyEditableWheel ?? null;
			const editableDrag = editableSourceState?.drag ?? globalThis.__shikiVerifyEditableDrag ?? null;
			const editableSource = globalThis.__shikiVerifyEditableSource ?? null;
			const mobileScroll = globalThis.__shikiVerifyMobileScroll ?? null;
			const plugin = app.plugins?.plugins['${PLUGIN_ID}'];
			await new Promise(resolve => setTimeout(resolve, 1000));
			if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
			await new Promise(resolve => setTimeout(resolve, 500));
			let editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const collectEditorTokens = () => [...editorRoot.querySelectorAll('.cm-content [class*="shiki"], .cm-content [style*="color"]')].map(el => ({
				text: el.textContent,
				className: el.className,
				style: el.getAttribute('style'),
			}));
			const initialEditorTokens = collectEditorTokens();
			const activeEditor = app.workspace.activeLeaf?.view?.editor;
			const sortLine = activeEditor?.getValue?.().split('\\n').findIndex(line => line.includes('intervals.Sort')) ?? -1;
			if (sortLine >= 0) {
				const sortPosition = { line: sortLine, ch: 0 };
				activeEditor.setCursor(sortPosition);
				activeEditor.scrollIntoView?.({ from: sortPosition, to: sortPosition }, true);
				await new Promise(resolve => setTimeout(resolve, 500));
				if (plugin?.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
				await new Promise(resolve => setTimeout(resolve, 500));
				editorRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			}
			const scrolledEditorTokens = collectEditorTokens();
			const editorTokens = [...initialEditorTokens, ...scrolledEditorTokens];
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
			const allShikiBlocks = [...document.querySelectorAll('.shiki-live-preview-block')];
			const sourceRoot = editorRoot.querySelector('.markdown-source-view.mod-cm6') ?? editorRoot.closest?.('.markdown-source-view.mod-cm6') ?? editorRoot;
			const sourceModeShikiBlocks = sourceRoot.querySelectorAll('.cm-content .shiki-live-preview-block, .cm-content .shiki-live-preview-block').length;
			const sourceViewShikiBlocks = sourceRoot.querySelectorAll('.shiki-live-preview-block').length;
			const readingViewShikiBlocks = allShikiBlocks.filter(el => el.closest('.markdown-preview-view')).length;
			const nonReadingShikiBlocks = allShikiBlocks.filter(el => !el.closest('.markdown-preview-view')).length;
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
				mobileScroll,
				editableLineNumbers,
				sourceModeShikiBlocks,
				sourceViewShikiBlocks,
				readingViewShikiBlocks,
				nonReadingShikiBlocks,
			};
		})()`,
	);
	const sourceThemeReloadState = await evaluate(
		wsUrl,
		`(async () => {
			const plugin = app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) ?? app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}];
			const readSourceTokenSignature = () => {
				const tokens = [...document.querySelectorAll('.cm-content .shiki-editing-token, .cm-content [style*="color"]')];
				const sample = tokens.slice(0, 80).map(el => ({
					text: el.textContent,
					style: el.getAttribute('style') ?? '',
					color: getComputedStyle(el).color,
				}));
				const fences = [...document.querySelectorAll('.cm-content .cm-line')].filter(line => line.textContent?.includes(String.fromCharCode(96).repeat(3))).length;
				return {
					tokenCount: tokens.length,
					signature: sample.map(token => [token.text, token.style, token.color].join('|')).join('::'),
					sample,
					fences,
					shikiBlocks: document.querySelectorAll('.cm-content .shiki-live-preview-block, .cm-content .shiki-live-preview-block').length,
				};
			};
			if (!plugin) return { ok: false, error: 'missing-plugin' };
			const previous = { darkTheme: plugin.settings.darkTheme, lightTheme: plugin.settings.lightTheme, bodyLight: document.body.classList.contains('theme-light'), bodyDark: document.body.classList.contains('theme-dark') };
			const before = readSourceTokenSignature();
			const nextTheme = 'github-light-default';
			document.body.classList.remove('theme-dark');
			document.body.classList.add('theme-light');
			plugin.settings.lightTheme = nextTheme;
			try {
				await plugin.reloadHighlighter?.();
				if (plugin.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
				let after = readSourceTokenSignature();
				for (let attempt = 0; attempt < 20 && before.signature === after.signature; attempt++) {
					await new Promise(resolve => setTimeout(resolve, 100));
					after = readSourceTokenSignature();
				}
				return {
					ok: before.tokenCount > 0 && after.tokenCount > 0,
					before,
					after,
					changed: before.signature !== after.signature,
					nextTheme,
				};
			} finally {
				plugin.settings.darkTheme = previous.darkTheme;
				plugin.settings.lightTheme = previous.lightTheme;
				document.body.classList.toggle('theme-light', previous.bodyLight);
				document.body.classList.toggle('theme-dark', previous.bodyDark);
				await plugin.reloadHighlighter?.();
				if (plugin.updateCm6Plugin) await Promise.race([plugin.updateCm6Plugin(), new Promise(resolve => setTimeout(resolve, 5000))]);
			}
		})()`,
	);

	return {
		...finalResult,
		sourceModeState,
		sourceThemeReloadState,
	};
}

function validateResult(label, result, { enforcePluginLoadMs = ENFORCE_PLUGIN_LOAD_MS } = {}) {
	const normalizeText = text => (text ?? '').replace(/\u00a0/g, ' ');
	const uniqueReadingBlocks = new Set(result.codeBlocks.map(block => block.text)).size;
	const uniqueLivePreviewBlocks = new Set(result.livePreviewCodeBlocks.map(block => block.text)).size;
	const livePreviewBlockIds = result.livePreviewCodeBlocks.map(block => block.blockId).filter(Boolean);
	assert(result.loadError === null, `${label}: plugin load failed`, result.loadError);
	assert(result.pluginLoaded, `${label}: plugin was not loaded`, result);
	assert(result.settingsTabLoaded, `${label}: settings tab was not loaded`, result);
	assert(
		result.livePreviewCodeBlocks.some(block => block.hasTokenSpans),
		`${label}: Shiki Live Preview blocks did not render token spans`,
		result,
	);
	assert(result.activeFile === 'feature-test.md', `${label}: feature note was not active`, result);
	assert(result.tokenSummary.lines === 1 && result.tokenSummary.firstLineTokens > 0, `${label}: tokenization failed`, result);
	assert(result.renderedText.includes('const z'), `${label}: direct render failed`, result);
	assert(result.customLanguageOdinSupported, `${label}: custom language was not available`, result);
	assert(result.disabledLanguageReturns === null, `${label}: disabled language still returned tokens`, result);
	assert(result.themeSelection.light === 'runtime-selected-light-theme', `${label}: light mode did not use saved light theme setting`, result);
	assert(result.themeSelection.dark === 'runtime-selected-dark-theme', `${label}: dark mode did not use saved dark theme setting`, result);
	assert(result.dynamicThemeSelection.light === 'github-light-default', `${label}: dynamic light theme setting was not applied`, result);
	assert(result.dynamicThemeSelection.dark === 'github-dark-default', `${label}: dynamic dark theme setting was not applied`, result);
	if (VERIFY_READING_MODE || result.isMobile) {
		assert(uniqueReadingBlocks >= 4, `${label}: expected rendered reading surfaces for each fenced block`, result);
		assert(
			result.codeBlocks.some(block => block.hasTokenSpans),
			`${label}: Reading mode rendered blocks without Shiki token spans`,
			result,
		);
		assert(
			result.codeBlocks.some(block => normalizeText(block.text).includes('const') && normalizeText(block.text).includes('console.log')),
			`${label}: TypeScript block missing`,
			result,
		);
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
		result.livePreviewCodeBlocks.length === 0 || result.livePreviewCodeBlocks.some(block => block.hasTokenSpans),
		`${label}: Live Preview rendered blocks without Shiki token spans`,
		result,
	);
	assert(
		livePreviewBlockIds.length === new Set(livePreviewBlockIds).size,
		`${label}: Live Preview rendered duplicate Shiki surfaces for the same logical block`,
		result.livePreviewCodeBlocks,
	);
	assert(result.editorTokens.length > 0, `${label}: editor Shiki highlighting missing`, result);
	assert(result.fencedEditorTokens.length >= 4, `${label}: editable fenced code block Shiki tokens missing`, result);
	assert(result.sourceModeShikiBlocks === 0, `${label}: Source mode mounted Shiki surfaces inside CM content`, result);
	assert(result.sourceViewShikiBlocks === 0, `${label}: Source mode left Shiki block hosts in active source view`, result);
	assert(result.nonReadingShikiBlocks === 0, `${label}: Source mode left non-Reading Shiki block hosts mounted`, result);
	assert(result.sourceModeState, `${label}: Source mode persistence state was not captured`, result);
	assert(!result.sourceModeState.editorMissing, `${label}: Source mode editor was not available`, result.sourceModeState);
	assert(result.sourceModeState.markerInEditor, `${label}: Source mode marker was not present in editor`, result.sourceModeState);
	assert(result.sourceModeState.markerOnDisk, `${label}: Source mode marker did not persist to disk`, result.sourceModeState);
	assert(result.sourceThemeReloadState, `${label}: Source mode theme reload state was not captured`, result);
	assert(result.sourceThemeReloadState.ok, `${label}: Source mode theme reload token was not measured`, result.sourceThemeReloadState);
	assert(result.sourceThemeReloadState.changed, `${label}: Source mode token color did not update after theme reload`, result.sourceThemeReloadState);
	assert(result.sourceThemeReloadState.after.fences >= 2, `${label}: Source mode theme reload hid raw fences`, result.sourceThemeReloadState);
	assert(result.sourceThemeReloadState.after.shikiBlocks === 0, `${label}: Source mode theme reload mounted Shiki surfaces`, result.sourceThemeReloadState);
	if (result.isMobile) {
		assert(result.livePreviewCodeBlocks.length > 0, `${label}: mobile Live Preview did not render Shiki blocks before touch`, result);
		assert(
			result.livePreviewCodeBlocks.some(block => block.hasTokenSpans),
			`${label}: mobile Live Preview Shiki did not render tokens before touch`,
			result.livePreviewCodeBlocks,
		);
		assert(result.mobileScroll !== null, `${label}: mobile scroll was not measured`, result);
		if (result.mobileScroll?.hasScrollContainer) {
			assert(
				Math.abs(result.mobileScroll.scrollLeftAfter - result.mobileScroll.scrollLeftBefore) > 0,
				`${label}: mobile horizontal touch drag did not scroll Shiki code horizontally`,
				result.mobileScroll,
			);
		}
		if (result.editableSource?.blockId) {
			assert(result.editableVertical !== null, `${label}: editable fenced code block vertical touch scroll was not measured`, result);
			assert(result.editableVertical.scrollable, `${label}: editable fenced code block vertical touch scroll had no scrollable editor`, result);
		}
	}
	if (enforcePluginLoadMs) {
		assert(result.measurements.pluginLoadMs < 50, `${label}: plugin load exceeded 50ms`, result.measurements);
	}
}

async function main() {
	traceCdp(`main: start mode=${OBSIDIAN_LAUNCH_MODE} target=${VERIFY_TARGET}`);
	assert(existsSync(path.join(PLUGIN_SOURCE_DIR, 'main.js')), 'plugin artifacts are missing. Run bun run build first or set OBSIDIAN_VERIFY_PLUGIN_DIR.', {
		pluginSourceDir: PLUGIN_SOURCE_DIR,
		bratInstall: BRAT_INSTALL,
	});
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
	await tracedPhase('prepare vault', () => prepareVault({ resetUserData: !reuseTarget && OBSIDIAN_LAUNCH_MODE !== 'existing' }));
	const obsidian = reuseTarget ? null : await tracedPhase('launch obsidian', () => launchObsidian());
	const output = [];
	obsidian?.stdout.on('data', data => output.push(data.toString()));
	obsidian?.stderr.on('data', data => output.push(data.toString()));
	let target = null;
	let stopped = false;
	const stop = async () => {
		if (!stopped) {
			stopped = true;
			if (OBSIDIAN_LAUNCH_MODE !== 'existing' && OBSIDIAN_LAUNCH_MODE !== 'reuse') {
				await closeTarget(target);
			}
			if (OBSIDIAN_LAUNCH_MODE !== 'reuse') {
				obsidian?.kill();
				await killOwnedPortProcesses();
			}
		}
	};
	process.on('exit', () => {
		if (OBSIDIAN_LAUNCH_MODE !== 'reuse') {
			obsidian?.kill();
		}
	});
	process.on('SIGINT', () => {
		if (OBSIDIAN_LAUNCH_MODE !== 'reuse') {
			obsidian?.kill();
		}
		process.exit(130);
	});

	try {
		if (OBSIDIAN_LAUNCH_MODE === 'existing') {
			await tracedPhase('relaunch existing target', () => relaunchExistingTarget());
		}
		target = await tracedPhase('wait for app target', () => waitForAppTarget()).catch(error => {
			error.message = `${error.message}\nLaunch mode: ${OBSIDIAN_LAUNCH_MODE}\nLaunch output:\n${output.join('')}`;
			throw error;
		});
		const wsUrl = target.webSocketDebuggerUrl;
		const trust = await tracedPhase('trust vault', () => trustVault(wsUrl));
		const desktopWsUrl = await tracedPhase('set desktop emulation', () => setMobileEmulation(wsUrl, false));
		let desktop = null;
		let mobile = null;
		if (VERIFY_TARGET !== 'mobile') {
			desktop = await tracedPhase('verify desktop feature set', () => verifyFeatureSet(desktopWsUrl, false));
			validateResult('desktop', desktop);
		}
		if (VERIFY_TARGET !== 'desktop') {
			mobile = await tracedPhase('verify mobile feature set', () => verifyFeatureSet(desktopWsUrl, true));
			validateResult('mobile-emulation', mobile, { enforcePluginLoadMs: VERIFY_TARGET === 'mobile' ? ENFORCE_PLUGIN_LOAD_MS : false });
		}
		await tracedPhase('restore desktop emulation', () => setMobileEmulation(desktopWsUrl, false));
		console.log(JSON.stringify({ trust, desktop, mobile }, null, 2));
	} finally {
		await stop();
	}
}

main().catch(error => {
	console.error(`verify:obsidian-advanced-codeblock-integration failed: ${error?.message ?? error}`);
	console.error(error);
	process.exit(1);
});
