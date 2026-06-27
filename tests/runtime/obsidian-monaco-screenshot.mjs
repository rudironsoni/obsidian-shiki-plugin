import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';

const PLUGIN_ID = 'shiki-highlighter';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9310);
const OBSIDIAN_BIN = process.env.OBSIDIAN_BIN ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const VAULT = process.env.OBSIDIAN_SCREENSHOT_VAULT ?? '/private/tmp/obsidian-shiki-monaco-screenshot-vault';
const USER_DATA = process.env.OBSIDIAN_SCREENSHOT_USER_DATA ?? '/private/tmp/obsidian-shiki-monaco-screenshot-user-data';
const PLUGIN_SOURCE_DIR = process.env.OBSIDIAN_VERIFY_PLUGIN_DIR ?? 'dist';
const OUT_DIR = process.env.OBSIDIAN_SCREENSHOT_DIR ?? 'planning/test-reports';
const NOTE_PATH = 'PyCharm Django Console fixes.md';
const LONG_CODE = [
	'import builtins, os, runpy, sys',
	"print('Python %s on %s' % (sys.version, sys.platform))",
	'import django',
	"print('Django %s' % django.get_version())",
	"sys.path.extend(['/app/src', '/opt/.pycharm_helpers/pycharm', '/opt/.pycharm_helpers/pydev'])",
	"os.chdir('/app/src')",
	"if 'setup' in dir(django): django.setup()",
	'_original_argv = sys.argv[:]',
	'try:',
	'    sys.argv = [',
	"        'manage.py',",
	"        'shell_plus',",
	"        '--command',",
	'        \'import builtins; builtins.__dict__["__pycharm_shell_plus_namespace__"] = dict(locals())\',',
	'    ]',
	"    runpy.run_path('/app/src' + '/manage.py', run_name='__main__')",
	"    globals().update(builtins.__dict__.pop('__pycharm_shell_plus_namespace__'))",
	'finally:',
	'    sys.argv = _original_argv',
].join('\n');

let launchOutput = '';

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function prepareVault() {
	await rm(VAULT, { recursive: true, force: true });
	await rm(USER_DATA, { recursive: true, force: true });
	await mkdir(path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID), { recursive: true });
	await mkdir(USER_DATA, { recursive: true });
	await mkdir(OUT_DIR, { recursive: true });

	for (const file of ['main.js', 'manifest.json', 'styles.css', 'modern-monaco.js']) {
		await cp(path.join(PLUGIN_SOURCE_DIR, file), path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID, file));
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
					'shiki-monaco-screenshot': {
						path: VAULT,
						ts: Date.now(),
						open: true,
					},
				},
			},
			null,
			2,
		),
	);
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
	return response.json();
}

async function waitForTarget() {
	const deadline = Date.now() + 45_000;
	let lastTargets = [];
	while (Date.now() < deadline) {
		try {
			lastTargets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
			const target =
				lastTargets.find(candidate => candidate.webSocketDebuggerUrl && candidate.url?.startsWith('app://obsidian.md/')) ??
				lastTargets.find(candidate => candidate.webSocketDebuggerUrl && candidate.title?.includes('Obsidian'));
			if (target) return target;
		} catch {
			// Obsidian is still starting.
		}
		await delay(250);
	}
	throw new Error(`Timed out waiting for Obsidian CDP target.\n${launchOutput}\n${JSON.stringify(lastTargets, null, 2)}`);
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
		if (message.error) request.reject(new Error(JSON.stringify(message.error)));
		else request.resolve(message.result);
	});
	return {
		ready: new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		}),
		send(method, params = {}) {
			const id = nextId++;
			socket.send(JSON.stringify({ id, method, params }));
			return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
		},
		close() {
			socket.close();
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
		await writeFile('/private/tmp/monaco-screenshot-exception.json', JSON.stringify(result.exceptionDetails, null, 2));
		throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
	}
	return result.result.value;
}

async function waitFor(client, expression, label, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await evaluate(client, expression);
		if (lastValue?.ok) return lastValue;
		await delay(250);
	}
	throw new Error(`${label} timed out: ${JSON.stringify(lastValue, null, 2)}`);
}

async function openMode(client, sourceMode) {
	await evaluate(
		client,
		`(async () => {
			app.vault.setConfig('livePreview', ${sourceMode ? 'false' : 'true'});
			let file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			for (let attempt = 0; !file && attempt < 50; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 100));
				file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			}
			if (!file) throw new Error('note not found');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'source', source: true } });
			const view = leaf.view;
			if (view?.setState) await view.setState({ file: file.path, mode: 'source', source: ${sourceMode ? 'true' : 'false'} }, { history: false });
			app.workspace.setActiveLeaf(leaf, { focus: true });
			return true;
		})()`,
	);
	await delay(1200);
}

async function waitForMonaco(client, label) {
	return waitFor(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
			const backtickFence = String.fromCharCode(96).repeat(3);
			const visibleFenceLines = [...document.querySelectorAll('.markdown-source-view.mod-cm6 .cm-line')].flatMap(line => {
				const rect = line.getBoundingClientRect();
				const style = getComputedStyle(line);
				if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return [];
				const text = line.innerText ?? '';
				if (!text.includes(backtickFence) && !text.includes('~~~')) return [];
				return [{ text, className: line.className, width: rect.width, height: rect.height, top: rect.top, left: rect.left }];
			});
			if (!block) return { ok: false, reason: 'missing-monaco', visibleFenceLines };
			const rect = block.getBoundingClientRect();
			const fallback = block.querySelector('.shiki-monaco-codeblock-fallback, .shiki-monaco-block-fallback');
			const fallbackRect = fallback?.getBoundingClientRect();
			const fallbackStyle = fallback ? getComputedStyle(fallback) : null;
			return {
				ok: rect.width > 0 && rect.height > 0 && block.querySelectorAll('.view-line').length > 0 && visibleFenceLines.length === 0,
				monacoBlocks: document.querySelectorAll('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block').length,
				width: rect.width,
				height: rect.height,
				viewLines: block.querySelectorAll('.view-line').length,
				visibleFenceLines,
				fallbackVisible: Boolean(fallback && fallbackStyle?.display !== 'none' && fallbackStyle?.visibility !== 'hidden'),
				fallbackBoxHeight: fallbackRect?.height ?? 0,
				fallbackBoxWidth: fallbackRect?.width ?? 0,
			};
		})()`,
		label,
	);
}

async function clickMonacoAndType(client, marker) {
	const box = await evaluate(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock, .markdown-source-view.mod-cm6 .shiki-monaco-block');
			const rect = block.getBoundingClientRect();
			return { x: rect.left + Math.min(80, rect.width / 2), y: rect.top + Math.min(60, rect.height / 2) };
		})()`,
	);
	await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
	await delay(300);
	await evaluate(client, `window.__shikiLastMonacoEditor?.focus?.()`);
	await client.send('Input.insertText', { text: marker });
	await delay(800);
	const content = await evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			return app.vault.read(file);
		})()`,
	);
	if (!content.includes(marker)) throw new Error(`Inserted marker ${marker} did not persist`);
}

async function captureScreenshot(client, filename) {
	const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
	await writeFile(path.join(OUT_DIR, filename), Buffer.from(result.data, 'base64'));
	return path.join(OUT_DIR, filename);
}

async function main() {
	await prepareVault();
	const child = spawn(OBSIDIAN_BIN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, VAULT], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout.on('data', chunk => {
		launchOutput += chunk.toString();
	});
	child.stderr.on('data', chunk => {
		launchOutput += chunk.toString();
	});
	let client;
	try {
		const target = await waitForTarget();
		client = createCdpClient(target.webSocketDebuggerUrl);
		await client.ready;
		await client.send('Page.enable');
		await client.send('Runtime.enable');
		await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
		await waitFor(client, `(() => ({ ok: Boolean(app?.plugins?.enabledPlugins?.has('${PLUGIN_ID}')) }))()`, 'plugin enabled');

		await openMode(client, true);
		const sourceState = await waitForMonaco(client, 'source mode Monaco');
		await clickMonacoAndType(client, 'SCREENSHOT_SOURCE_MODE_EDIT_');
		const sourceScreenshot = await captureScreenshot(client, 'monaco-source-mode.png');

		await openMode(client, false);
		const livePreviewState = await waitForMonaco(client, 'live preview Monaco');
		await clickMonacoAndType(client, 'SCREENSHOT_LIVE_PREVIEW_EDIT_');
		const livePreviewScreenshot = await captureScreenshot(client, 'monaco-live-preview-edit.png');

		const content = await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
				return app.vault.read(file);
			})()`,
		);
		if (!content.includes('SCREENSHOT_SOURCE_MODE_EDIT_') || !content.includes('SCREENSHOT_LIVE_PREVIEW_EDIT_')) {
			throw new Error('Screenshot verifier edits did not persist in both modes');
		}

		console.log(
			JSON.stringify(
				{
					sourceState,
					livePreviewState,
					sourceScreenshot,
					livePreviewScreenshot,
				},
				null,
				2,
			),
		);
	} finally {
		client?.close();
		child.kill();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
