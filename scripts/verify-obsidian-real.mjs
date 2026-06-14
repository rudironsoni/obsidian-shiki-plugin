import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9230);
const VAULT = process.env.OBSIDIAN_VERIFY_VAULT ?? '/private/tmp/obsidian-shiki-real-verify-vault';
const USER_DATA = process.env.OBSIDIAN_VERIFY_USER_DATA ?? '/private/tmp/obsidian-shiki-real-verify-user-data';
const PLUGIN_ID = 'shiki-highlighter';
const BRAT_INSTALL = process.env.OBSIDIAN_VERIFY_BRAT_INSTALL === 'true';

function assert(condition, message, detail) {
	if (!condition) {
		const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
		throw new Error(`${message}${suffix}`);
	}
}

function prepareVault() {
	rmSync(VAULT, { recursive: true, force: true });
	rmSync(USER_DATA, { recursive: true, force: true });

	const pluginDir = path.join(VAULT, '.obsidian/plugins', PLUGIN_ID);
	mkdirSync(pluginDir, { recursive: true });
	if (BRAT_INSTALL) {
		for (const file of ['main.js', 'manifest.json', 'styles.css']) {
			cpSync(path.join('dist', file), path.join(pluginDir, file));
		}
	} else {
		cpSync('dist', pluginDir, { recursive: true });
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
				ecDefaultFrame: 'auto',
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
			'List<int[]> intervals = [[1, 3], [2, 6], [8, 10], [15, 18]];',
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
		try {
			const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(response => response.json());
			const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
			if (page) return page.webSocketDebuggerUrl;
		} catch {}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for Obsidian DevTools target.');
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
			throw new Error(`Renderer exception: ${result.exceptionDetails.text}`);
		}
		return result.result.value;
	} finally {
		socket.close();
	}
}

async function trustVault(wsUrl) {
	return evaluate(
		wsUrl,
		`(async () => {
			await new Promise(resolve => setTimeout(resolve, 1000));
			const trust = [...document.querySelectorAll('button')].find(button => button.innerText.includes('Trust author'));
			if (trust) trust.click();
			await new Promise(resolve => setTimeout(resolve, 2000));
			return { clickedTrust: !!trust, hasApp: typeof app, enabled: app ? [...app.plugins.enabledPlugins] : [] };
		})()`,
	);
}

async function verifyFeatureSet(wsUrl, mobile) {
	let activeWsUrl = wsUrl;
	if (mobile) {
		try {
			await evaluate(
				activeWsUrl,
				`(() => {
					app.emulateMobile(true);
					return { called: true };
				})()`,
			);
		} catch (error) {
			if (!String(error?.message ?? error).includes('Execution context was destroyed')) {
				throw error;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 1500));
		activeWsUrl = await waitForTarget();
	}

	return evaluate(
		activeWsUrl,
		`(async () => {
			const measurements = {};
			let loadError = null;
			try {
				if (app.plugins.plugins['${PLUGIN_ID}']) await app.plugins.unloadPlugin('${PLUGIN_ID}');
				const loadStart = performance.now();
				await app.plugins.loadPlugin('${PLUGIN_ID}');
				measurements.pluginLoadMs = performance.now() - loadStart;
			} catch (e) {
				loadError = { name: e.name, message: e.message, stack: e.stack };
			}
			const plugin = app.plugins.plugins['${PLUGIN_ID}'];
			const file = app.vault.getAbstractFileByPath('feature-test.md');
			if (file) await app.workspace.getLeaf(true).openFile(file, { state: { mode: 'preview' } });
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
			const codeBlocks = [...document.querySelectorAll('div.expressive-code')].map(el => ({
				text: el.textContent,
				hasLineNumbers: !!el.querySelector('.ln'),
			}));
			const inline = [...document.querySelectorAll('.shiki-inline')].map(el => el.textContent);
			if (file) await app.workspace.getLeaf(false).openFile(file, { state: { mode: 'source', source: false } });
			await new Promise(resolve => setTimeout(resolve, 5000));
			await plugin.updateCm6Plugin();
			await new Promise(resolve => setTimeout(resolve, 500));
			const editorTokens = [...document.querySelectorAll('.cm-content [class*="shiki"], .cm-content [style*="color"]')].map(el => ({
				text: el.textContent,
				className: el.className,
				style: el.getAttribute('style'),
			}));
			const fencedEditorTokens = editorTokens.filter(token =>
				['List', 'intervals', 'startIndex', 'Sort'].some(text => token.text?.includes(text))
			);
			return {
				isMobile: app.isMobile,
				loadError,
				pluginLoaded: !!plugin,
				settingsTabLoaded: !!app.setting?.pluginTabs?.find?.(tab => tab.id === '${PLUGIN_ID}' || tab.plugin === plugin),
				highlighterLoaded: !!plugin?.highlighter?.highlighter,
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
				measurements,
				codeBlocks,
				inline,
				editorTokens,
				fencedEditorTokens,
			};
		})()`,
	);
}

function validateResult(label, result) {
	assert(result.loadError === null, `${label}: plugin load failed`, result.loadError);
	assert(result.pluginLoaded, `${label}: plugin was not loaded`, result);
	assert(result.settingsTabLoaded, `${label}: settings tab was not loaded`, result);
	assert(result.highlighterLoaded, `${label}: highlighter did not lazy-load`, result);
	assert(
		result.themes.dark !== 'obsidian-theme' && result.themes.light !== 'obsidian-theme',
		`${label}: old Obsidian theme defaults were not migrated`,
		result,
	);
	assert(result.activeFile === 'feature-test.md', `${label}: feature note was not active`, result);
	assert(result.tokenSummary.lines === 1 && result.tokenSummary.firstLineTokens > 0, `${label}: tokenization failed`, result);
	assert(result.renderedText.includes('Perf') && result.renderedText.includes('const z'), `${label}: direct EC render failed`, result);
	assert(result.customLanguageOdinSupported, `${label}: custom language was not available`, result);
	assert(result.disabledLanguageReturns === null, `${label}: disabled language still returned tokens`, result);
	assert(result.codeBlocks.length >= 3, `${label}: expected rendered fenced code blocks`, result);
	assert(
		result.codeBlocks.some(block => block.text.includes('Startup check') && block.hasLineNumbers),
		`${label}: EC metadata did not render`,
		result,
	);
	assert(
		result.codeBlocks.some(block => block.text.includes('old line') && block.text.includes('new line')),
		`${label}: diff block missing`,
		result,
	);
	assert(
		result.codeBlocks.some(block => block.text.includes('package main')),
		`${label}: custom Odin block missing`,
		result,
	);
	assert(
		result.inline.some(text => text.includes('const inlineValue')),
		`${label}: inline highlighting missing`,
		result,
	);
	assert(result.editorTokens.length > 0, `${label}: editor Shiki highlighting missing`, result);
	assert(result.fencedEditorTokens.length > 0, `${label}: fenced C# editor Shiki highlighting missing`, result);
	assert(
		result.fencedEditorTokens.some(token => token.style && !token.style.includes('var(--shiki-code')),
		`${label}: fenced C# editor tokens still use Obsidian color variables`,
		result,
	);
	assert(result.measurements.pluginLoadMs < 50, `${label}: plugin load exceeded 50ms`, result.measurements);
}

async function main() {
	assert(existsSync('dist/main.js') && existsSync('dist/highlighter.js'), 'dist artifacts are missing. Run bun run build first.');
	prepareVault();
	const obsidian = spawn(OBSIDIAN_APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stopped = false;
	const stop = () => {
		if (!stopped) {
			stopped = true;
			obsidian.kill();
		}
	};
	process.on('exit', stop);
	process.on('SIGINT', () => {
		stop();
		process.exit(130);
	});

	try {
		const wsUrl = await waitForTarget();
		const trust = await trustVault(wsUrl);
		const desktop = await verifyFeatureSet(wsUrl, false);
		validateResult('desktop', desktop);
		const mobile = await verifyFeatureSet(wsUrl, true);
		validateResult('mobile-emulation', mobile);
		console.log(JSON.stringify({ trust, desktop, mobile }, null, 2));
	} finally {
		stop();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
