import fs from 'node:fs';
const PORT = 9230;
let id = 0;
async function targetWs() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const target = targets.find(t => t.webSocketDebuggerUrl && /obsidian/i.test(`${t.title} ${t.url}`)) || targets.find(t => t.webSocketDebuggerUrl);
	if (!target) throw new Error('No Obsidian CDP target');
	return target.webSocketDebuggerUrl;
}
function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	const pending = new Map();
	ws.addEventListener('message', e => {
		const msg = JSON.parse(e.data);
		if (msg.id && pending.has(msg.id)) {
			const p = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
		}
	});
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () =>
			resolve({
				send(method, params = {}) {
					const requestId = ++id;
					ws.send(JSON.stringify({ id: requestId, method, params }));
					return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
				},
				close() {
					ws.close();
				},
			}),
		);
		ws.addEventListener('error', reject);
	});
}
async function evaluate(cdp, expression, timeout = 45000) {
	const result = await Promise.race([
		cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`eval timeout: ${expression.slice(0, 120)}`)), timeout)),
	]);
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
	return result.result.value;
}
const note = ['# Source parity', '', '```ts', 'const value = 42;', 'function greet(name: string) {', '  return "hello " + name;', '}', '```', ''].join('\n');
const browserScript = async content => {
	const pluginId = 'shiki-highlighter';
	await app.plugins.disablePlugin(pluginId).catch(() => {});
	await app.plugins.enablePlugin(pluginId);
	const plugin = app.plugins.plugins[pluginId];
	plugin.loadedSettings.darkTheme = 'github-dark';
	plugin.loadedSettings.lightTheme = 'github-light';
	if (plugin.saveSettings) await plugin.saveSettings();
	app.vault.setConfig('livePreview', false);
	const path = 'codex-source-theme-parity.md';
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing) await app.vault.modify(existing, content);
	else await app.vault.create(path, content);
	const leaf = app.workspace.getLeaf('tab');
	await leaf.setViewState({ type: 'markdown', state: { file: path, mode: 'source', source: true }, active: true }, { history: false });
	app.workspace.setActiveLeaf(leaf, { focus: true });
	await new Promise(resolve => setTimeout(resolve, 2500));
	const sourceView = document.querySelector('.markdown-source-view.mod-cm6:not(.is-live-preview)');
	const monacoInSource = sourceView?.querySelectorAll('.monaco-editor').length ?? 0;
	const tokenSpans = [...document.querySelectorAll('.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-content [style*="color"]')]
		.map(el => ({ text: el.textContent, color: getComputedStyle(el).color, style: el.getAttribute('style') }))
		.filter(x => x.text?.trim());
	const sourceConst = tokenSpans.find(x => x.text === 'const') || tokenSpans.find(x => x.text?.includes('const')) || null;
	const fencesVisible = document.querySelector('.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-content')?.textContent?.includes('```ts') ?? false;
	app.vault.setConfig('livePreview', true);
	const leaf2 = app.workspace.getLeaf('tab');
	await leaf2.setViewState({ type: 'markdown', state: { file: path, mode: 'source', source: false }, active: true }, { history: false });
	app.workspace.setActiveLeaf(leaf2, { focus: true });
	await new Promise(resolve => setTimeout(resolve, 3500));
	const monacoConstNode = [...document.querySelectorAll('.monaco-editor .view-line span')].find(el => el.textContent === 'const') || null;
	const monacoConst = monacoConstNode
		? { text: monacoConstNode.textContent, color: getComputedStyle(monacoConstNode).color, style: monacoConstNode.getAttribute('style') }
		: null;
	return {
		pluginThemes: { dark: plugin.loadedSettings.darkTheme, light: plugin.loadedSettings.lightTheme },
		source: { monacoInSource, fencesVisible, sourceConst, tokenSample: tokenSpans.slice(0, 12) },
		monaco: { editorCount: document.querySelectorAll('.monaco-editor').length, monacoConst },
	};
};
const cdp = await connect(await targetWs());
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const expression = `(${browserScript.toString()})(${JSON.stringify(note)})`;
const result = await evaluate(cdp, expression, 60000);
fs.mkdirSync('planning/test-reports/source-theme-parity', { recursive: true });
fs.writeFileSync('planning/test-reports/source-theme-parity/result.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
cdp.close();
