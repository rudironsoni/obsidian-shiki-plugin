import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, writeFileSync as writeFile } from 'node:fs';
import path from 'node:path';

const PORT = 9230;
const VAULT = '/tmp/obsidian-shiki-visual-test';
const USER_DATA = '/tmp/obsidian-shiki-visual-test-user-data';
const PLUGIN_ID = 'shiki-highlighter';

function prepareVault() {
	// Only create vault once; wipe only plugin files on subsequent runs
	if (!existsSync(VAULT)) {
		rmSync(USER_DATA, { recursive: true, force: true });

		const pluginDir = path.join(VAULT, '.obsidian/plugins', PLUGIN_ID);
		mkdirSync(pluginDir, { recursive: true });
		cpSync('dist/main.js', path.join(pluginDir, 'main.js'));
		cpSync('dist/modern-monaco.js', path.join(pluginDir, 'modern-monaco.js'));
		cpSync('dist/styles.css', path.join(pluginDir, 'styles.css'));
		cpSync('dist/manifest.json', path.join(pluginDir, 'manifest.json'));

		writeFileSync(path.join(VAULT, '.obsidian/community-plugins.json'), JSON.stringify([], null, '\t'));
		writeFileSync(path.join(VAULT, '.obsidian/app.json'), JSON.stringify({ safeMode: false }, null, '\t'));

		writeFileSync(
			path.join(pluginDir, 'data.json'),
			JSON.stringify(
				{
					inlineHighlighting: true,
					ecDefaultShowLineNumbers: true,
					ecDefaultWrap: false,
					darkTheme: 'github-dark',
					lightTheme: 'github-light',
					preferThemeColors: true,
					disabledLanguages: [],
				},
				null,
				'\t',
			),
		);

		writeFileSync(
			path.join(VAULT, 'test-visual.md'),
			[
				'# Visual Test',
				'',
				'Inline code `{ts} const inlineValue: number = 2` should render.',
				'',
				'```typescript',
				'const x: number = 1;',
				'console.log(x);',
				'function hello(name: string): string {',
				'  return `Hello, ${name}!`;',
				'}',
				'```',
				'',
				'```python',
				'def hello():',
				'    return "world"',
				'```',
				'',
				'```csharp',
				'public class Program {',
				'    public static void Main() {',
				'        Console.WriteLine("Hello World");',
				'    }',
				'}',
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
						'shiki-visual': {
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
	} else {
		// Vault exists: just refresh plugin files
		const pluginDir = path.join(VAULT, '.obsidian/plugins', PLUGIN_ID);
		cpSync('dist/main.js', path.join(pluginDir, 'main.js'));
		cpSync('dist/modern-monaco.js', path.join(pluginDir, 'modern-monaco.js'));
		cpSync('dist/styles.css', path.join(pluginDir, 'styles.css'));
		cpSync('dist/manifest.json', path.join(pluginDir, 'manifest.json'));
	}
}

async function isObsidianRunning() {
	try {
		const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
		return targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
	} catch {
		return null;
	}
}

async function waitForTarget() {
	const started = Date.now();
	while (Date.now() - started < 30000) {
		const page = await isObsidianRunning();
		if (page) return page;
		await new Promise(r => setTimeout(r, 250));
	}
	throw new Error('Timed out waiting for Obsidian');
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
			const cb = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) cb.reject(message.error);
			else cb.resolve(message.result);
		}
	});
	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}
	try {
		await send('Runtime.enable');
		const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result.value;
	} finally {
		socket.close();
	}
}

async function screenshot(wsUrl, path) {
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
			const cb = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) cb.reject(message.error);
			else cb.resolve(message.result);
		}
	});
	function send(method, params = {}) {
		const id = ++nextId;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	}
	try {
		await send('Page.enable');
		const result = await send('Page.captureScreenshot', { format: 'png', fullPage: true });
		writeFileSync(path, Buffer.from(result.data, 'base64'));
		console.log(`Screenshot saved to ${path}`);
	} finally {
		socket.close();
	}
}

async function main() {
	prepareVault();

	let target = await isObsidianRunning();
	let child = null;

	if (!target) {
		console.log('Launching Obsidian...');
		child = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();

		console.log('Waiting for Obsidian...');
		target = await waitForTarget();
		console.log('Obsidian ready:', target.url);

		// Trust vault
		await evaluate(
			target.webSocketDebuggerUrl,
			`
			(async () => {
				await new Promise(r => setTimeout(r, 2000));
				const trust = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Trust author'));
				if (trust) trust.click();
				await new Promise(r => setTimeout(r, 2000));
				return { trusted: !!trust };
			})()
		`,
		);
	} else {
		console.log('Reusing existing Obsidian instance');
	}

	// Load plugin
	await evaluate(
		target.webSocketDebuggerUrl,
		`
		(async () => {
			window._shikiErrors = [];
			const origError = console.error;
			console.error = (...args) => {
				window._shikiErrors.push(args.map(a => String(a)).join(' '));
				origError.apply(console, args);
			};
			const app = window.app;
			for (let i = 0; i < 300 && !app?.plugins; i++) await new Promise(r => setTimeout(r, 100));
			if (app.plugins.plugins['${PLUGIN_ID}']) await app.plugins.unloadPlugin('${PLUGIN_ID}');
			await app.plugins.loadManifests();
			await app.plugins.loadPlugin('${PLUGIN_ID}');
			await new Promise(r => setTimeout(r, 3000));
			return { loaded: true };
		})()
	`,
	);

	// Open test file in reading mode
	await evaluate(
		target.webSocketDebuggerUrl,
		`
		(async () => {
			const app = window.app;
			const file = app.vault.getAbstractFileByPath('test-visual.md');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			await new Promise(r => setTimeout(r, 5000));
			return { activeFile: app.workspace.getActiveFile()?.path ?? null };
		})()
	`,
	);

	// Screenshot reading mode
	await screenshot(target.webSocketDebuggerUrl, 'planning/test-reports/reading-mode.png');

	// Check visual state
	const visualCheck = await evaluate(
		target.webSocketDebuggerUrl,
		`
		(() => {
			const viewRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			const editors = [...viewRoot.querySelectorAll('.monaco-editor')];
			const firstEditor = editors[0];
			const tokens = firstEditor ? [...firstEditor.querySelectorAll('.mtk1, .mtk2, .mtk3, .mtk4, .mtk5, .mtk6, .mtk7, .mtk8, .mtk9, .mtk10')].map(t => ({
				text: t.textContent?.slice(0, 20),
				color: t.style.color || getComputedStyle(t).color,
				classes: t.className,
			})) : [];
			const lineNumbers = firstEditor ? [...firstEditor.querySelectorAll('.line-numbers')].map(ln => ln.textContent) : [];
			const hasVerticalScrollbar = firstEditor ? firstEditor.querySelector('.monaco-scrollable-element > .scrollbar.vertical') !== null : false;
			const editorHeight = firstEditor ? firstEditor.getBoundingClientRect().height : 0;
			return {
				monacoBlocks: [...viewRoot.querySelectorAll('.shiki-monaco-block')].length,
				monacoEditors: editors.length,
				tokenCount: tokens.length,
				tokenSamples: tokens.slice(0, 8),
				lineNumbers: lineNumbers.slice(0, 5),
				hasVerticalScrollbar,
				editorHeight,
				errors: window._shikiErrors.slice(-10),
			};
		})()
	`,
	);
	console.log('\nVisual check:', JSON.stringify(visualCheck, null, 2));

	// Switch to live preview
	await evaluate(
		target.webSocketDebuggerUrl,
		`
		(async () => {
			const app = window.app;
			const file = app.vault.getAbstractFileByPath('test-visual.md');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'source', source: false } });
			await new Promise(r => setTimeout(r, 5000));
			return { mode: 'live-preview' };
		})()
	`,
	);

	// Screenshot live preview
	await screenshot(target.webSocketDebuggerUrl, 'planning/test-reports/live-preview.png');

	// Check live preview state
	const livePreviewCheck = await evaluate(
		target.webSocketDebuggerUrl,
		`
		(() => {
			const viewRoot = app.workspace.activeLeaf?.view?.contentEl ?? document;
			return {
				monacoBlocksInPreview: [...viewRoot.querySelectorAll('.cm-preview-code-block .shiki-monaco-block')].length,
				monacoEditors: [...viewRoot.querySelectorAll('.monaco-editor')].length,
				inline: [...viewRoot.querySelectorAll('.shiki-inline')].length,
				errors: window._shikiErrors.slice(-10),
			};
		})()
	`,
	);
	console.log('\nLive preview check:', JSON.stringify(livePreviewCheck, null, 2));

	console.log('\nScreenshots saved to planning/test-reports/');
	if (child) {
		console.log('Obsidian is still running. Reuse it by running this script again.');
	}
	process.exit(0);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
