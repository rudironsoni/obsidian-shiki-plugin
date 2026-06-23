import fs from 'node:fs';
import path from 'node:path';
const PORT = 9230;
const OUT = 'planning/test-reports/duplicate-monaco-scroll';
let id = 0;
async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}
async function targetWs() {
  const targets = await json(`http://127.0.0.1:${PORT}/json`);
  const target = targets.find(t => t.webSocketDebuggerUrl && /obsidian/i.test(`${t.title} ${t.url}`)) || targets.find(t => t.webSocketDebuggerUrl);
  if (!target) throw new Error(`No CDP target: ${JSON.stringify(targets)}`);
  return target.webSocketDebuggerUrl;
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const thisId = ++id;
        ws.send(JSON.stringify({ id: thisId, method, params }));
        return new Promise((resolve, reject) => pending.set(thisId, { resolve, reject }));
      },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', reject);
  });
}
async function evalExpr(cdp, expression, timeout = 30000) {
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout eval: ${expression.slice(0, 80)}`)), timeout));
  const result = await Promise.race([cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), timer]);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function shot(cdp, name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(res.data, 'base64'));
}
const cdp = await connect(await targetWs());
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const noteContent = "# Merge Intervals\n\n```csharp\nusing System;\nusing System.Collections.Generic;\n\npublic sealed class Solution {\n    public int[][] Merge(int[][] intervals) {\n        Array.Sort(intervals, (a, b) => a[0].CompareTo(b[0])); // LONG-LINE ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n        var merged = new List<int[]>();\n        foreach (var interval in intervals) {\n            if (merged.Count == 0 || merged[merged.Count - 1][1] < interval[0]) merged.Add(interval);\n            else merged[merged.Count - 1][1] = Math.Max(merged[merged.Count - 1][1], interval[1]);\n        }\n        return merged.ToArray();\n    }\n}\n```\n\nAfter block.";
const setup = await evalExpr(cdp, `(async()=>{
  const pluginId='shiki-highlighter';
  await app.plugins.disablePlugin(pluginId).catch(()=>{});
  await app.plugins.enablePlugin(pluginId);
  app.vault.setConfig('livePreview', true);
  app.vault.setConfig('readableLineLength', false);
  document.body.classList.add('is-mobile');
  const notePath='codex-duplicate-monaco.md';
  const content = ${JSON.stringify(noteContent)};
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing) await app.vault.modify(existing, content); else await app.vault.create(notePath, content);
  const leaf = app.workspace.getLeaf('tab');
  await leaf.setViewState({type:'markdown', state:{file: notePath, mode:'source', source:false}, active:true}, {history:false});
  app.workspace.setActiveLeaf(leaf, {focus:true});
  return {plugin: !!app.plugins.plugins[pluginId], leaves: app.workspace.getLeavesOfType('markdown').length};
})()`, 60000);
console.log('setup', JSON.stringify(setup));
await new Promise(r => setTimeout(r, 2500));
const snapshotExpr = `(() => ({
  overlayRoots: document.querySelectorAll('.shiki-monaco-overlay-root').length,
  hostCount: document.querySelectorAll('.shiki-monaco-block,.shiki-monaco-codeblock').length,
  editorCount: document.querySelectorAll('.monaco-editor').length,
  hosts: [...document.querySelectorAll('.shiki-monaco-block,.shiki-monaco-codeblock')].map(el => ({id:el.getAttribute('data-shiki-block-id'), anchor:el.getAttribute('data-shiki-live-anchor'), cls:el.className, text:el.textContent.slice(0,70), rect:(()=>{const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})(), scrollLeft: el.querySelector('.monaco-scrollable-element')?.scrollLeft ?? null})),
  uniqueAnchors: new Set([...document.querySelectorAll('.shiki-monaco-block,.shiki-monaco-codeblock')].map(el => el.getAttribute('data-shiki-live-anchor'))).size,
  cmScrollerTop: document.querySelector('.cm-scroller')?.scrollTop ?? null,
  bodyClass: document.body.className
}))()`;
const before = await evalExpr(cdp, snapshotExpr);
console.log('before', JSON.stringify(before, null, 2));
await shot(cdp, '01-before-scroll.png');
await evalExpr(cdp, `(() => {
  const host = document.querySelector('.shiki-monaco-block,.shiki-monaco-codeblock');
  const scroller = document.querySelector('.cm-scroller');
  if (!host || !scroller) return {ok:false, reason:'missing host/scroller'};
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new WheelEvent('wheel', {deltaX: 240, deltaY: 0, bubbles:true, cancelable:true, clientX:r.left+120, clientY:r.top+50}));
  scroller.scrollTop += 180;
  window.dispatchEvent(new Event('resize'));
  return {ok:true, scrollTop: scroller.scrollTop};
})()`);
await new Promise(r => setTimeout(r, 1600));
const after = await evalExpr(cdp, snapshotExpr);
console.log('after', JSON.stringify(after, null, 2));
await shot(cdp, '02-after-scroll.png');
cdp.close();
