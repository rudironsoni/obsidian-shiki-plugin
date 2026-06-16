import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9231);
const VAULT = process.env.OBSIDIAN_EDITABLE_CODEBLOCK_VAULT ?? '/private/tmp/obsidian-shiki-editable-codeblock-vault';
const USER_DATA = process.env.OBSIDIAN_EDITABLE_CODEBLOCK_USER_DATA ?? '/private/tmp/obsidian-shiki-editable-codeblock-user-data';
const PLUGIN_ID = 'shiki-highlighter';
const NOTE_PATH = 'Editable code block runtime.md';
const LONG_CODE = "const runtimeEditableCodeBlockMarker = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789';";

let launchOutput = '';

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

	for (const file of ['main.js', 'manifest.json', 'styles.css', 'highlighter.js', 'highlighter.css', 'monaco-editor.js', 'monaco-editor.css']) {
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
		['# Editable code block runtime', '', '```ts showLineNumbers', LONG_CODE, 'console.log(runtimeEditableCodeBlockMarker);', '```', ''].join('\n'),
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

async function waitForTarget() {
	const deadline = Date.now() + 45_000;
	let lastTargets = [];
	while (Date.now() < deadline) {
		try {
			lastTargets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
			const target = lastTargets.find(candidate => candidate.webSocketDebuggerUrl && candidate.type === 'page');
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
		try {
			lastTargets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
			for (const target of lastTargets) {
				if (!target.webSocketDebuggerUrl || target.type !== 'page') continue;
				const client = createCdpClient(target.webSocketDebuggerUrl);
				try {
					await client.ready;
					await client.send('Runtime.enable');
					await client.send('Page.enable');
					const hasApp = await evaluate(client, `Boolean(window.app?.workspace)`);
					if (hasApp) return client;
				} catch {
					// Keep scanning; Electron can expose transient page targets while opening.
				}
				client.close();
			}
		} catch {
			// Obsidian is still starting.
		}
		await delay(250);
	}
	throw new Error(`Timed out waiting for Obsidian app target.\nLaunch output:\n${launchOutput}\nTargets:\n${JSON.stringify(lastTargets, null, 2)}`);
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
		throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
	}
	return result.result.value;
}

async function waitFor(client, expression, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await evaluate(client, expression);
		if (lastValue) return lastValue;
		await delay(250);
	}
	throw new Error(`${message}\nLast value:\n${JSON.stringify(lastValue, null, 2)}`);
}

async function openNote(client, livePreview) {
	await evaluate(
		client,
		`(async () => {
			app.vault.setConfig('livePreview', ${livePreview ? 'true' : 'false'});
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
			if (!file) throw new Error('note not found');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'source', source: true } });
			await new Promise(resolve => setTimeout(resolve, 800));
			return true;
		})()`,
	);
}

async function getEditableCodeLine(client) {
	return waitFor(
		client,
		`(() => {
			const lines = [...document.querySelectorAll('.markdown-source-view.mod-cm6 .cm-content .cm-line, .markdown-source-view.mod-cm6 .cm-content .shiki-editing-codeblock-line')];
			const line = lines.find(candidate => candidate.textContent.includes('runtimeEditableCodeBlockMarker'));
			if (!line) return null;
			const rect = line.getBoundingClientRect();
			return {
				text: line.textContent,
				className: line.className,
				x: Math.floor(rect.left + Math.min(24, Math.max(4, rect.width / 4))),
				y: Math.floor(rect.top + rect.height / 2),
				clientWidth: line.clientWidth,
				scrollWidth: line.scrollWidth,
				hasMonaco: Boolean(document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock')),
				hasEditableDecoration: line.classList.contains('shiki-editing-codeblock-line'),
			};
		})()`,
		'Timed out waiting for visible editable code line',
	);
}

async function clickAndType(client, line, text) {
	await client.send('Input.dispatchMouseEvent', {
		type: 'mousePressed',
		x: line.x,
		y: line.y,
		button: 'left',
		clickCount: 1,
	});
	await client.send('Input.dispatchMouseEvent', {
		type: 'mouseReleased',
		x: line.x,
		y: line.y,
		button: 'left',
		clickCount: 1,
	});
	await delay(200);
	await client.send('Input.insertText', { text });
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

async function verifyMode(client, modeName, livePreview, marker) {
	await openNote(client, livePreview);
	const line = await getEditableCodeLine(client);
	assert(!line.hasMonaco, `${modeName}: editable source view must not mount Monaco replacement widget`, line);
	assert(line.text.includes('runtimeEditableCodeBlockMarker'), `${modeName}: visible code line text is wrong`, line);
	assert(line.clientWidth > 0, `${modeName}: code line has no visible width`, line);

	await clickAndType(client, line, marker);
	const content = await assertFileContains(client, marker);
	assert(content.includes(marker), `${modeName}: inserted text did not persist`, { marker, content });

	const afterLine = await getEditableCodeLine(client);
	assert(!afterLine.hasMonaco, `${modeName}: Monaco widget appeared after editing`, afterLine);
}

async function main() {
	await prepareVault();

	const obsidian = spawn(OBSIDIAN_APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, VAULT], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	obsidian.stdout.on('data', chunk => {
		launchOutput += chunk.toString();
	});
	obsidian.stderr.on('data', chunk => {
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
				if (!app.plugins.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)})) {
					await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
				}
				return app.plugins.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)}) ?? false;
			})()`,
		);
		await waitFor(client, `Boolean(app.plugins?.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)}))`, 'Plugin did not enable');
		await verifyMode(client, 'live preview', true, 'LIVE_PREVIEW_EDIT_');
		await verifyMode(client, 'source mode', false, 'SOURCE_MODE_EDIT_');

		const finalContent = await readFile(path.join(VAULT, NOTE_PATH), 'utf8');
		assert(finalContent.includes('LIVE_PREVIEW_EDIT_'), 'Live preview edit marker missing from disk', { finalContent });
		assert(finalContent.includes('SOURCE_MODE_EDIT_'), 'Source mode edit marker missing from disk', { finalContent });
	} finally {
		client?.close();
		obsidian.kill();
	}
}

main().catch(error => {
	error.message = `${error.message}\nLaunch output:\n${launchOutput}`;
	console.error(error);
	process.exit(1);
});
