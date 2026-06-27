const PORT = 9230;
let id = 0;
async function targetWs() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	return (targets.find(t => t.webSocketDebuggerUrl && /obsidian/i.test(`${t.title} ${t.url}`)) || targets.find(t => t.webSocketDebuggerUrl))
		.webSocketDebuggerUrl;
}
function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	const pending = new Map();
	ws.addEventListener('message', e => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) {
			const p = pending.get(m.id);
			pending.delete(m.id);
			m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
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
async function evalStep(cdp, name, expression, timeout = 15000) {
	console.log('STEP', name);
	const result = await Promise.race([
		cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${name}`)), timeout)),
	]);
	if (result.exceptionDetails) throw new Error(`${name}: ${result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)}`);
	console.log('RESULT', name, JSON.stringify(result.result.value));
	return result.result.value;
}
const note = ['# Source parity', '', '```ts', 'const value = 42;', 'function greet(name: string) {', '  return "hello " + name;', '}', '```', ''].join('\n');
const cdp = await connect(await targetWs());
await cdp.send('Runtime.enable');
try {
	await evalStep(cdp, 'ready', '({ready:!!app, leaves:app.workspace.getLeavesOfType("markdown").length, file:app.workspace.getActiveFile()?.path ?? null})');
	await evalStep(
		cdp,
		'plugin-settings',
		`(() => { const plugin=app.plugins.plugins['shiki-highlighter']; plugin.loadedSettings.darkTheme='github-dark'; plugin.loadedSettings.lightTheme='github-light'; return {plugin:!!plugin, dark:plugin.loadedSettings.darkTheme, light:plugin.loadedSettings.lightTheme}; })()`,
	);
	await evalStep(
		cdp,
		'write-note',
		`(async()=>{ const path='codex-source-theme-parity.md'; const content=${JSON.stringify(note)}; const existing=app.vault.getAbstractFileByPath(path); if(existing) await app.vault.modify(existing, content); else await app.vault.create(path, content); return {exists:!!app.vault.getAbstractFileByPath(path)}; })()`,
	);
	await evalStep(
		cdp,
		'open-source',
		`(async()=>{ app.vault.setConfig('livePreview', false); const leaf=app.workspace.getLeaf('tab'); await leaf.setViewState({type:'markdown', state:{file:'codex-source-theme-parity.md', mode:'source', source:true}, active:true}, {history:false}); app.workspace.setActiveLeaf(leaf,{focus:true}); return {view:leaf.view?.getViewType?.(), mode:leaf.view?.getMode?.(), file:leaf.view?.file?.path}; })()`,
		20000,
	);
	await evalStep(
		cdp,
		'source-dom',
		`(async()=>{ await new Promise(r=>setTimeout(r,2000)); const source=document.querySelector('.markdown-source-view.mod-cm6:not(.is-live-preview)'); return {source:!!source, monacoInSource:source?.querySelectorAll('.monaco-editor').length??0, text:document.querySelector('.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-content')?.textContent?.slice(0,120)??null, tokenCount:document.querySelectorAll('.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-content [style*="color"]').length}; })()`,
		10000,
	);
	await evalStep(
		cdp,
		'open-live-preview',
		`(async()=>{ app.vault.setConfig('livePreview', true); const leaf=app.workspace.getLeaf('tab'); await leaf.setViewState({type:'markdown', state:{file:'codex-source-theme-parity.md', mode:'source', source:false}, active:true}, {history:false}); app.workspace.setActiveLeaf(leaf,{focus:true}); return {view:leaf.view?.getViewType?.(), mode:leaf.view?.getMode?.(), file:leaf.view?.file?.path}; })()`,
		20000,
	);
	await evalStep(
		cdp,
		'live-dom',
		`(async()=>{ await new Promise(r=>setTimeout(r,3000)); return {editors:document.querySelectorAll('.monaco-editor').length, hosts:document.querySelectorAll('.shiki-monaco-block,.shiki-monaco-codeblock').length, roots:document.querySelectorAll('.shiki-monaco-overlay-root').length}; })()`,
		10000,
	);
} finally {
	cdp.close();
}
