import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9231);
const VAULT = process.env.OBSIDIAN_MONACO_EDIT_VAULT ?? '/private/tmp/obsidian-shiki-monaco-edit-vault';
const USER_DATA = process.env.OBSIDIAN_MONACO_EDIT_USER_DATA ?? '/private/tmp/obsidian-shiki-monaco-edit-user-data';
const PLUGIN_ID = 'shiki-highlighter';
const NOTE_PATH = 'monaco-edit.md';
const MARKER = '/* monaco edit ok */';

function assert(condition, message, detail) {
	if (!condition) {
		const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
		throw new Error(`${message}${suffix}`);
	}
}

function setupVault() {
	rmSync(VAULT, { recursive: true, force: true });
	rmSync(USER_DATA, { recursive: true, force: true });
	mkdirSync(path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID), { recursive: true });
	mkdirSync(USER_DATA, { recursive: true });

	for (const file of ['main.js', 'manifest.json', 'styles.css', 'highlighter.js', 'highlighter.css', 'monaco-editor.js', 'monaco-editor.css']) {
		const source = path.join(ROOT, 'dist', file);
		if (existsSync(source)) {
			cpSync(source, path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID, file));
		}
	}
	writeFileSync(
		path.join(VAULT, '.obsidian', 'plugins', PLUGIN_ID, 'data.json'),
		JSON.stringify(
			{
				customLanguageFolder: 'customLanguages',
				customThemeFolder: 'customThemes',
				theme: 'obsidian-theme',
				disabledLanguages: [],
				inlineHighlighting: true,
				ecDefaultShowLineNumbers: false,
			},
			null,
			'\t',
		),
	);

	writeFileSync(path.join(VAULT, '.obsidian', 'community-plugins.json'), JSON.stringify([PLUGIN_ID], null, '\t'));
	writeFileSync(path.join(VAULT, '.obsidian', 'app.json'), JSON.stringify({ legacyEditor: false, livePreview: true }, null, '\t'));
	writeFileSync(path.join(VAULT, NOTE_PATH), ['# Monaco edit smoke', '', '```ts', 'const before = 1;', 'console.log(before);', '```', ''].join('\n'));
	writeFileSync(
		path.join(USER_DATA, 'obsidian.json'),
		JSON.stringify(
			{
				vaults: {
					'codex-shiki-monaco-edit': {
						path: VAULT,
						ts: Date.now(),
						open: true,
					},
				},
			},
			null,
			'\t',
		),
	);
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
	return response.json();
}

async function waitForAppTarget() {
	const deadline = Date.now() + 45_000;
	let lastTargets = [];
	while (Date.now() < deadline) {
		try {
			lastTargets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
			for (const target of lastTargets.filter(item => item.type === 'page' && item.webSocketDebuggerUrl)) {
				const client = await createCdpClient(target.webSocketDebuggerUrl);
				try {
					await client.send('Runtime.enable');
					const hasApp = await evaluate(client, 'Boolean(window.app?.workspace && window.app?.vault)');
					if (hasApp) return { target, client };
				} finally {
					client.close();
				}
			}
		} catch {
			// Obsidian is still starting.
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for Obsidian CDP target on ${PORT}: ${JSON.stringify(lastTargets)}`);
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

	return new Promise((resolve, reject) => {
		socket.addEventListener('open', () => {
			resolve({
				send(method, params = {}) {
					const id = nextId++;
					socket.send(JSON.stringify({ id, method, params }));
					return new Promise((requestResolve, requestReject) => {
						pending.set(id, { resolve: requestResolve, reject: requestReject });
					});
				},
				close() {
					socket.close();
				},
			});
		});
		socket.addEventListener('error', reject);
	});
}

async function evaluate(client, expression, awaitPromise = true) {
	const result = await client.send('Runtime.evaluate', {
		expression,
		awaitPromise,
		returnByValue: true,
	});
	if (result.exceptionDetails) {
		throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
	}
	return result.result.value;
}

async function waitFor(client, expression, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	while (Date.now() < deadline) {
		value = await evaluate(client, expression);
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for ${expression}: ${JSON.stringify(value)}`);
}

async function click(client, x, y) {
	await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function typeText(client, text) {
	for (const char of text) {
		if (char === '\n') {
			await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
			await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
		} else {
			await client.send('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char, key: char });
		}
	}
}

async function main() {
	setupVault();
	const obsidian = spawn(OBSIDIAN_APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, VAULT], { stdio: ['ignore', 'pipe', 'pipe'] });
	let launchOutput = '';
	obsidian.stdout.on('data', data => {
		launchOutput += data.toString();
	});
	obsidian.stderr.on('data', data => {
		launchOutput += data.toString();
	});

	let client;
	try {
		const appTarget = await waitForAppTarget();
		client = await createCdpClient(appTarget.target.webSocketDebuggerUrl);
		await client.send('Runtime.enable');
		await client.send('Page.enable');

		const opened = await evaluate(
			client,
			`(async () => {
				try {
					await new Promise(resolve => window.app.workspace.onLayoutReady(resolve));
					let file = window.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
					if (!file) {
						file = await window.app.vault.create(
							${JSON.stringify(NOTE_PATH)},
							${JSON.stringify(['# Monaco edit smoke', '', '```ts', 'const before = 1;', 'console.log(before);', '```', ''].join('\n'))},
						);
					}
					window.app.plugins.setEnable(true);
					await window.app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
					const leaf = window.app.workspace.getLeaf(false);
					await leaf.openFile(file);
					await leaf.view?.setState?.({ file: file.path, mode: 'source', source: false }, { history: false });
					leaf.view?.editor?.scrollIntoView?.({ from: { line: 3, ch: 0 }, to: { line: 4, ch: 20 } }, true);
					leaf.view?.editor?.setCursor?.({ line: 3, ch: 12 });
					await new Promise(resolve => setTimeout(resolve, 1500));
					return {
						ok: true,
						pluginLoaded: Boolean(window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]),
						pluginState: {
							unloaded: window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.unloaded,
							cm6PluginRegistered: window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.cm6PluginRegistered,
							codeBlockProcessorsRegistered:
								window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.codeBlockProcessorsRegistered,
						},
						filePath: file?.path,
					};
				} catch (error) {
					return {
						ok: false,
						message: String(error?.message ?? error),
						stack: String(error?.stack ?? ''),
						pluginLoaded: Boolean(window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]),
						pluginState: {
							unloaded: window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.unloaded,
							cm6PluginRegistered: window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.cm6PluginRegistered,
							codeBlockProcessorsRegistered:
								window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.codeBlockProcessorsRegistered,
						},
					};
				}
			})()`,
		);
		assert(opened.ok, 'Failed to open Monaco edit smoke note', opened);
		assert(opened.pluginLoaded, 'Plugin did not load in Monaco edit smoke', opened);

		const editableTarget = await waitFor(
			client,
			`(() => {
				try {
					const monaco = document.querySelector('.shiki-monaco-codeblock');
					if (monaco) return { kind: 'monaco' };
					const block = document.querySelector('.cm-preview-code-block') || document.querySelector('.HyperMD-codeblock');
					if (!block) return null;
					const rect = block.getBoundingClientRect();
					return { kind: 'preview', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
				} catch {
					return null;
				}
			})()`,
		);
		if (editableTarget.kind === 'preview') {
			await click(client, editableTarget.x, editableTarget.y);
		}
		await evaluate(client, `window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.updateCm6Plugin?.()`);
		await evaluate(
			client,
			`(() => {
				const block = document.querySelector('.cm-preview-code-block');
				const rect = block.getBoundingClientRect();
				block.dispatchEvent(new MouseEvent('mousedown', {
					bubbles: true,
					cancelable: true,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				}));
				return true;
			})()`,
		);
		await new Promise(resolve => setTimeout(resolve, 750));

		let monaco;
		try {
			monaco = await waitFor(
				client,
				`(() => {
					const block = document.querySelector('.shiki-monaco-codeblock:not(.shiki-monaco-codeblock-loading)');
					if (!block) return null;
					const rect = block.getBoundingClientRect();
					return { x: rect.left + Math.max(4, rect.width / 2), y: rect.top + Math.max(4, rect.height / 2) };
				})()`,
			);
		} catch (error) {
			const diagnostics = await evaluate(
				client,
				`(() => ({
					pluginLoaded: Boolean(window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]),
					pluginState: {
						unloaded: window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.unloaded,
						cm6PluginRegistered: window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.cm6PluginRegistered,
						codeBlockProcessorsRegistered:
							window.app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.codeBlockProcessorsRegistered,
					},
					activeFile: window.app.workspace.getActiveFile()?.path,
					workspaceMode: window.app.workspace.activeLeaf?.view?.getState?.(),
					editorValue: window.app.workspace.activeLeaf?.view?.editor?.getValue?.(),
					cursor: window.app.workspace.activeLeaf?.view?.editor?.getCursor?.(),
					bodyText: document.body.innerText.slice(0, 1000),
					cmContent: Boolean(document.querySelector('.cm-content')),
					activeEditableCodeBlock: document.querySelector('.cm-editor')?.dataset?.shikiActiveEditableCodeBlock,
					editableDecorationRange: document.querySelector('.cm-editor')?.dataset?.shikiEditableDecorationRange,
					activeMonacoFieldRange: document.querySelector('.cm-editor')?.dataset?.shikiActiveMonacoFieldRange,
					monacoWidgetToDom: document.body.dataset.shikiMonacoWidgetToDom,
					monacoDispatchCount: document.body.dataset.shikiMonacoDispatchCount,
					monacoDispatchRange: document.body.dataset.shikiMonacoDispatchRange,
					cmLines: [...document.querySelectorAll('.cm-line')].slice(0, 12).map(line => ({
						text: line.textContent,
						className: String(line.className),
					})),
					monacoBlocks: document.querySelectorAll('.shiki-monaco-codeblock').length,
					regularCodeBlocks: document.querySelectorAll('.HyperMD-codeblock, .cm-line.HyperMD-codeblock').length,
					preBlocks: [...document.querySelectorAll('pre, code')].slice(0, 12).map(el => ({
						tag: el.tagName,
						text: el.textContent,
						className: String(el.className),
					})),
					codeRelated: [...document.querySelectorAll('[class*="code"], [class*="Code"], [class*="cm-"]')]
						.slice(0, 40)
						.map(el => ({
							tag: el.tagName,
							text: el.textContent?.slice(0, 120),
							className: String(el.className),
						})),
				}))()`,
			);
			error.message = `${error.message}\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}`;
			throw error;
		}

		await click(client, monaco.x, monaco.y);
		await evaluate(
			client,
			`(() => {
				const editor = window.__shikiLastMonacoEditor;
				if (!editor) return { ok: false };
				editor.focus();
				editor.getModel()?.setValue(editor.getValue() + ${JSON.stringify(`\n${MARKER}`)});
				return { ok: true, value: editor.getValue() };
			})()`,
		);
		await new Promise(resolve => setTimeout(resolve, 750));

		const result = await evaluate(
			client,
			`(async () => {
				const file = window.app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
				const content = await window.app.vault.cachedRead(file);
				return {
					hasMonaco: Boolean(document.querySelector('.shiki-monaco-codeblock')),
					activeElement: String(document.activeElement?.className ?? ""),
					monacoValue: window.__shikiLastMonacoEditor?.getValue?.(),
					monacoDispatchCount: document.body.dataset.shikiMonacoDispatchCount,
					monacoDispatchRange: document.body.dataset.shikiMonacoDispatchRange,
					editorValue: window.app.workspace.activeLeaf?.view?.editor?.getValue?.(),
					content,
				};
			})()`,
		);
		assert(result.hasMonaco, 'Monaco code block did not render', result);
		assert(result.editorValue?.includes(MARKER) || result.content.includes(MARKER), 'Typing into Monaco did not update the markdown document', result);
		console.log('Monaco edit smoke passed.');
	} catch (error) {
		error.message = `${error.message}\nLaunch output:\n${launchOutput}`;
		throw error;
	} finally {
		client?.close();
		obsidian.kill();
	}
}

await main();
