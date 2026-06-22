import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OBSIDIAN_APP = process.env.OBSIDIAN_APP ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const PORT = Number(process.env.OBSIDIAN_REMOTE_DEBUGGING_PORT ?? 9231);
const VAULT = process.env.OBSIDIAN_EDITABLE_CODEBLOCK_VAULT ?? '/private/tmp/obsidian-shiki-editable-codeblock-vault';
const USER_DATA = process.env.OBSIDIAN_EDITABLE_CODEBLOCK_USER_DATA ?? '/private/tmp/obsidian-shiki-editable-codeblock-user-data';
const PLUGIN_ID = 'shiki-highlighter';
const NOTE_PATH = 'Editable code block runtime.md';
const LONG_CODE = [
	'import builtins, os, runpy, sys',
	"print('Python %s on %s' % (sys.version, sys.platform))",
	"very_long_runtime_scroll_line = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'",
	'import django',
	"print('Django %s' % django.get_version())",
	"sys.path.extend(['/app/src', '/opt/.pycharm_helpers'])",
	"os.chdir('/app/src')",
	"if 'setup' in dir(django): django.setup()",
	'_original_argv = sys.argv[:]',
	'try:',
	'    sys.argv = [',
	"        'manage.py',",
	"        'shell_plus',",
	"        '--command',",
	'        \'import builtins; builtins.__dict__["__pycharm_marker"] = True\',',
	'    ]',
	"    runpy.run_path('/app/src' + '/manage.py', run_name='__main__')",
	'finally:',
	'    sys.argv = _original_argv',
].join('\n');

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

	for (const file of ['main.js', 'manifest.json', 'styles.css', 'modern-monaco.js']) {
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
		let file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
		for (let attempt = 0; !file && attempt < 50; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
		}
			if (!file) throw new Error('note not found');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file);
			await new Promise(resolve => setTimeout(resolve, 250));
			if (leaf.view?.setState) {
				await leaf.view.setState({ file: file.path, mode: 'source', source: ${livePreview ? 'false' : 'true'} }, { history: false });
			}
			leaf.view?.editor?.setCursor?.({ line: 0, ch: 0 });
			await new Promise(resolve => setTimeout(resolve, 800));
			return true;
		})()`,
	);
}

async function getEditableCodeLine(client) {
	return waitFor(
		client,
		`(() => {
			const container = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock');
			if (!container) return null;
			const editor = container._monacoEditor;
			const model = editor?.getModel?.();
			if (!model) return null;
			const text = model.getValue();
			const match = text.includes('runtimeEditableCodeBlockMarker');
			const targetLine = [...container.querySelectorAll('.view-line')].find(line => line.textContent?.includes('very_long_runtime_scroll_line'))
				?? [...container.querySelectorAll('.view-line')].find(line => line.textContent?.includes('runtimeEditableCodeBlockMarker'))
				?? container;
			const rect = targetLine.getBoundingClientRect();
			return match ? {
				text,
				className: container.className,
				x: Math.floor(rect.left + Math.min(Math.max(24, rect.width * 0.25), Math.max(24, rect.width - 8))),
				y: Math.floor(rect.top + rect.height / 2),
				clientWidth: container.clientWidth,
				scrollWidth: container.clientWidth,
				hasMonaco: true,
				hasEditableDecoration: false,
			} : null;
		})()`,
		'Timed out waiting for visible editable code line',
	);
}

async function clickLine(client, line) {
	const activation = await evaluate(
		client,
		`(() => {
			try {
				const container = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock');
				if (!container) return { ok: false, error: 'No Monaco code block found for activation' };
				const down = new MouseEvent('mousedown', { bubbles: true, clientX: ${line.x}, clientY: ${line.y} });
				const click = new MouseEvent('click', { bubbles: true, clientX: ${line.x}, clientY: ${line.y} });
				container.dispatchEvent(down);
				container.dispatchEvent(click);
				if (typeof container.onmousedown === 'function') container.onmousedown(down);
				if (typeof container.onclick === 'function') container.onclick(click);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error), stack: error?.stack ?? null };
			}
		})()`,
	);
	assert(activation?.ok, 'Live preview activation dispatch failed', activation);
	await delay(600);
	const log = await evaluate(client, `JSON.stringify(window.__shikiMonacoActivationLog ?? [])`);
	console.log('Activation log:', log);
}

async function dispatchTouchDrag(client, fromX, fromY, toX, toY, steps = 8) {
	const touchStart = { x: fromX, y: fromY, radiusX: 1, radiusY: 1, force: 1, id: 1 };
	await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchStart] });
	for (let step = 1; step <= steps; step++) {
		const progress = step / steps;
		await client.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: fromX + (toX - fromX) * progress, y: fromY + (toY - fromY) * progress, radiusX: 1, radiusY: 1, force: 1, id: 1 }],
		});
		await delay(16);
	}
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function dispatchTouchTap(client, x, y) {
	const touch = { x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 };
	await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
	await delay(40);
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function dispatchVerticalWheelAtPoint(client, x, y, deltaY) {
	await client.send('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x,
		y,
		deltaX: 0,
		deltaY,
		pointerType: 'mouse',
	});
}

async function readOutsideNoteWheelPoint(client) {
	return evaluate(
		client,
		`(() => {
			const root = document.querySelector('.markdown-source-view.mod-cm6') ?? document;
			const scroller = root.querySelector('.cm-scroller') ?? document.scrollingElement;
			const outsideLine = [...root.querySelectorAll('.cm-line')].find(line => {
				const text = line.textContent ?? '';
				const rect = line.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && !line.classList.contains('shiki-editing-codeblock-line') && text.includes('PyCharm Django Console fixes');
			});
			const rect = outsideLine?.getBoundingClientRect?.();
			return {
				x: rect ? Math.floor(rect.left + Math.min(120, rect.width / 2)) : 160,
				y: rect ? Math.floor(rect.top + rect.height / 2) : 160,
				noteScrollTop: scroller?.scrollTop ?? 0,
			};
		})()`,
	);
}

async function dispatchHorizontalWheel(client, x, y, deltaX) {
	await client.send('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x,
		y,
		deltaX,
		deltaY: 0,
		pointerType: 'mouse',
	});
}

async function dispatchWheelOnMonacoHost(client, deltaX, deltaY = 0) {
	return evaluate(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active')
				?? document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock');
			if (!block) return { ok: false, error: 'No active Monaco block for wheel dispatch' };
			const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: ${deltaX}, deltaY: ${deltaY} });
			block.dispatchEvent(event);
			return { ok: true, defaultPrevented: event.defaultPrevented };
		})()`,
	);
}

async function dispatchTouchDragOnMonacoHost(client, fromX, fromY, toX, toY) {
	return evaluate(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active')
				?? document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock');
			if (!block) return { ok: false, error: 'No active Monaco block for touch dispatch' };
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

async function readNoteAndMonacoScrollState(client) {
	return evaluate(
		client,
		`(() => {
			const root = document.querySelector('.markdown-source-view.mod-cm6') ?? document;
			const scroller = root.querySelector('.cm-scroller') ?? document.scrollingElement;
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active')
				?? document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock');
			const editor = block?._monacoEditor;
			return {
				noteScrollTop: scroller?.scrollTop ?? 0,
				monacoScrollLeft: editor?.getScrollLeft?.() ?? 0,
			};
		})()`,
	);
}

async function readMonacoScrollState(client) {
	return evaluate(
		client,
		`(() => {
			const block = document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active')
				?? document.querySelector('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock');
			const editor = block?._monacoEditor;
			if (!block || !editor) return null;
			const line = block.querySelector('.view-line');
			return {
				scrollLeft: editor.getScrollLeft?.() ?? 0,
				hasOverflow: (editor.getScrollWidth?.() ?? block.scrollWidth) > block.clientWidth,
				contentLeft: line?.getBoundingClientRect?.().left ?? null,
				width: block.clientWidth,
				scrollWidth: editor.getScrollWidth?.() ?? block.scrollWidth,
			};
		})()`,
	);
}

async function typeText(client, text) {
	await evaluate(
		client,
		`(() => {
			const container = document.querySelector('.shiki-monaco-codeblock.shiki-monaco-active');
			if (!container) throw new Error('No active Monaco code block found');
			const editor = container._monacoEditor;
			const model = editor?.getModel?.();
			if (!editor || !model) throw new Error('Monaco editor/model missing');
			model.setValue(${JSON.stringify(text)} + model.getValue());
			return model.getValue();
		})()`,
	);
}

async function waitForMonaco(client, modeName, activeOnly = true) {
	const expression = `(() => {
			const block = document.querySelector(${JSON.stringify(activeOnly ? '.markdown-source-view.mod-cm6 .shiki-monaco-codeblock.shiki-monaco-active' : '.markdown-source-view.mod-cm6 .shiki-monaco-codeblock')});
			const editor = document.querySelector('.markdown-source-view.mod-cm6 .cm-editor');
			const detail = {
				editorClass: editor?.className ?? null,
				monacoBlocks: document.querySelectorAll('.markdown-source-view.mod-cm6 .shiki-monaco-codeblock').length,
				editableLines: document.querySelectorAll('.markdown-source-view.mod-cm6 .shiki-editing-codeblock-line').length,
				codeTextVisible: [...document.querySelectorAll('.markdown-source-view.mod-cm6 .cm-line, .markdown-source-view.mod-cm6 .shiki-editing-codeblock-line')]
					.some(line => line.textContent.includes('runtimeEditableCodeBlockMarker')),
				visibleFenceLines: (() => {
					const backtickFence = String.fromCharCode(96).repeat(3);
					return [...document.querySelectorAll('.markdown-source-view.mod-cm6 .cm-line')].flatMap(line => {
						const rect = line.getBoundingClientRect();
						const style = getComputedStyle(line);
						if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return [];
						const text = line.innerText ?? '';
						if (!text.includes(backtickFence) && !text.includes('~~~')) return [];
						return [{ text, className: line.className, width: rect.width, height: rect.height, top: rect.top, left: rect.left }];
					});
				})(),
			};
			detail.fenceTextVisible = detail.visibleFenceLines.length > 0;
			if (!block) return { ready: false, ...detail };
			const rect = block.getBoundingClientRect();
			const viewLines = block.querySelectorAll('.view-line').length;
			const text = block.textContent ?? '';
			const fallback = block.querySelector('.shiki-monaco-codeblock-fallback');
			const fallbackStyle = fallback ? getComputedStyle(fallback) : null;
			const fallbackRect = fallback?.getBoundingClientRect();
			return {
				ready: true,
				...detail,
				className: block.className,
				width: rect.width,
				height: rect.height,
				viewLines,
				text,
				hasEditorHook: Boolean(block.querySelector('.monaco-editor')),
				fallbackVisible: Boolean(fallback && fallbackStyle?.display !== 'none' && fallbackStyle?.visibility !== 'hidden'),
				fallbackBoxHeight: fallbackRect?.height ?? 0,
				fallbackBoxWidth: fallbackRect?.width ?? 0,
				activeElementClass: document.activeElement?.className?.toString?.() ?? '',
			};
		})()`;
	const deadline = Date.now() + 20_000;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await evaluate(client, expression);
		if (lastValue?.ready) return lastValue;
		await delay(250);
	}
	throw new Error(`${modeName}: Monaco editor did not mount\nLast value:\n${JSON.stringify(lastValue, null, 2)}`);
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

async function captureScreenshot(client, modeName) {
	if (!process.env.OBSIDIAN_CAPTURE_SCREENSHOTS) return null;
	await mkdir(process.env.OBSIDIAN_CAPTURE_SCREENSHOTS, { recursive: true });
	const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
	const filename = `${modeName.replaceAll(' ', '-')}.png`;
	const filePath = path.join(process.env.OBSIDIAN_CAPTURE_SCREENSHOTS, filename);
	await writeFile(filePath, Buffer.from(result.data, 'base64'));
	return filePath;
}

async function verifyMode(client, modeName, livePreview, marker) {
	await openNote(client, livePreview);
	await delay(2000);
	const diag = await evaluate(client, `JSON.stringify(window.__shikiDiag ?? { missing: true })`);
	console.log(`${modeName} diag:`, diag);
	const debugDom = await evaluate(
		client,
		`JSON.stringify({
		allMonacoBlocks: document.querySelectorAll('.shiki-monaco-codeblock').length,
		allActiveMonacoBlocks: document.querySelectorAll('.shiki-monaco-codeblock.shiki-monaco-active').length,
		allEditableLines: document.querySelectorAll('.shiki-editing-codeblock-line').length,
		allCmContent: document.querySelector('.cm-content')?.innerHTML?.substring(0, 200) ?? 'none',
	})`,
	);
	console.log(`${modeName} debug:`, debugDom);
	if (!livePreview) {
		const sourceState = await waitFor(
			client,
			`(() => {
				const editorRoot = document.querySelector('.markdown-source-view.mod-cm6');
				if (!editorRoot) return null;
				const monacoBlocks = editorRoot.querySelectorAll('.cm-content .shiki-monaco-codeblock').length;
				const fence = String.fromCharCode(96).repeat(3);
				const fenceLines = [...editorRoot.querySelectorAll('.cm-line')].filter(line => {
					const text = line.textContent ?? '';
					return text.includes(fence + 'python showLineNumbers') || text === fence;
				});
				const styledTokens = [...editorRoot.querySelectorAll('.cm-line [style*="color"]')].map(el => el.textContent).filter(Boolean);
				return {
					monacoBlocks,
					fenceCount: fenceLines.length,
					styledTokensCount: styledTokens.length,
					styledTokens,
				};
			})()`,
			`${modeName}: source mode did not render`,
		);
		assert(sourceState.monacoBlocks === 0, `${modeName}: source mode mounted Monaco`, sourceState);
		assert(sourceState.fenceCount >= 2, `${modeName}: source mode fences are not visible`, sourceState);
		assert(sourceState.styledTokensCount > 0, `${modeName}: source mode token styling missing`, sourceState);
		await captureScreenshot(client, modeName);
		return;
	}
	const line = await getEditableCodeLine(client);
	assert(line.text.includes('runtimeEditableCodeBlockMarker'), `${modeName}: visible code line text is wrong`, line);
	assert(line.clientWidth > 0, `${modeName}: code line has no visible width`, line);

	const outsideBefore = await readOutsideNoteWheelPoint(client);
	await dispatchVerticalWheelAtPoint(client, outsideBefore.x, outsideBefore.y, 220);
	await delay(100);
	const outsideAfter = await readOutsideNoteWheelPoint(client);
	assert(outsideAfter.noteScrollTop > outsideBefore.noteScrollTop, `${modeName}: vertical wheel outside Monaco did not scroll the Obsidian note`, {
		outsideBefore,
		outsideAfter,
	});

	const isMobileMode = modeName.includes('mobile');
	await clickLine(client, line);
	const monaco = await waitForMonaco(client, modeName, !isMobileMode);
	assert(monaco.width > 0 && monaco.height > 0, `${modeName}: Monaco mounted without visible dimensions`, monaco);
	assert(monaco.viewLines > 0, `${modeName}: Monaco mounted but rendered no visible editor lines`, monaco);
	assert(monaco.hasEditorHook, `${modeName}: Monaco mounted without editor instance hook`, monaco);
	assert(!monaco.fallbackVisible, `${modeName}: Monaco fallback is still visible over the editor`, monaco);
	assert(monaco.fallbackBoxHeight === 0 && monaco.fallbackBoxWidth === 0, `${modeName}: Monaco fallback still occupies layout`, monaco);
	assert(!monaco.fenceTextVisible, `${modeName}: raw fenced code block is still visible outside Monaco`, monaco);
	if (!isMobileMode) {
		const cursorPlacement = await evaluate(
			client,
			`(() => {
				const block = document.querySelector('.shiki-monaco-codeblock.shiki-monaco-active');
				const editor = block?._monacoEditor;
				return { position: editor?.getPosition?.() ?? null, selection: editor?.getSelection?.() ?? null };
			})()`,
		);
		assert(cursorPlacement.position?.lineNumber > 1, `${modeName}: activation click did not place Monaco cursor in clicked code region`, cursorPlacement);
	}

	if (isMobileMode) {
		assert(!monaco.className.includes('shiki-monaco-active'), `${modeName}: mobile tap activated editable Monaco`, monaco);
		await dispatchTouchTap(client, line.x, line.y);
		await delay(120);
		const nativeTap = await evaluate(
			client,
			`(() => {
				const activeView = app.workspace.activeLeaf?.view;
				const editor = activeView?.editor;
				const cursor = editor?.getCursor?.() ?? null;
				const lines = editor?.getValue?.().split('\\n') ?? [];
				const markerLine = lines.findIndex(line => line.includes('runtimeEditableCodeBlockMarker'));
				const fence = String.fromCharCode(96).repeat(3);
				const fenceLine = lines.findIndex(line => line.includes(fence + 'python showLineNumbers'));
				const activeElement = document.activeElement;
				return {
					cursor,
					markerLine,
					fenceLine,
					editorHasFocus: editor?.hasFocus?.() ?? false,
					activeElementClass: activeElement?.className?.toString?.() ?? null,
					activeElementInMonaco: !!activeElement?.closest?.('.monaco-editor'),
				};
			})()`,
		);
		assert(nativeTap.markerLine >= 0, `${modeName}: marker line was not found in native editor`, nativeTap);
		assert(nativeTap.fenceLine >= 0, `${modeName}: fence line was not found in native editor`, nativeTap);
		assert(
			nativeTap.cursor?.line > nativeTap.fenceLine && nativeTap.cursor?.line <= nativeTap.markerLine,
			`${modeName}: mobile tap did not move native cursor inside code block`,
			nativeTap,
		);
		assert(nativeTap.editorHasFocus, `${modeName}: mobile tap did not focus native Obsidian editor`, nativeTap);
		assert(!nativeTap.activeElementInMonaco, `${modeName}: mobile tap focused Monaco instead of Obsidian editor`, nativeTap);
	} else {
		await evaluate(
			client,
			`(() => {
			const container = document.querySelector('.shiki-monaco-codeblock.shiki-monaco-active');
			if (container && container._monacoEditor) container._monacoEditor.focus();
		})()`,
		);
		await typeText(client, marker);
		const content = await assertFileContains(client, marker);
		assert(content.includes(marker), `${modeName}: inserted text did not persist`, { marker, content });
	}

	const beforeScroll = await readMonacoScrollState(client);
	assert(beforeScroll?.hasOverflow, `${modeName}: Monaco block does not expose horizontal overflow`, beforeScroll);
	const beforeVerticalWheel = await readNoteAndMonacoScrollState(client);
	const verticalWheelDispatch = await dispatchWheelOnMonacoHost(client, 0, 220);
	assert(verticalWheelDispatch?.ok, `${modeName}: vertical wheel dispatch failed`, verticalWheelDispatch);
	assert(!verticalWheelDispatch.defaultPrevented, `${modeName}: vertical wheel was prevented inside Monaco`, verticalWheelDispatch);
	await delay(100);
	const afterVerticalWheel = await readNoteAndMonacoScrollState(client);
	assert(afterVerticalWheel.noteScrollTop > beforeVerticalWheel.noteScrollTop, `${modeName}: vertical wheel inside Monaco did not scroll the Obsidian note`, {
		beforeVerticalWheel,
		afterVerticalWheel,
	});
	assert(afterVerticalWheel.monacoScrollLeft === beforeVerticalWheel.monacoScrollLeft, `${modeName}: vertical wheel changed Monaco horizontal scroll`, {
		beforeVerticalWheel,
		afterVerticalWheel,
	});

	const beforeHorizontalWheel = await readNoteAndMonacoScrollState(client);
	const wheelDispatch = await dispatchWheelOnMonacoHost(client, 180, 0);
	assert(wheelDispatch?.ok, `${modeName}: horizontal wheel dispatch failed`, wheelDispatch);
	assert(wheelDispatch.defaultPrevented, `${modeName}: horizontal wheel was not prevented inside Monaco`, wheelDispatch);
	await delay(100);
	const afterWheelScroll = await readNoteAndMonacoScrollState(client);
	assert(afterWheelScroll.monacoScrollLeft > beforeHorizontalWheel.monacoScrollLeft, `${modeName}: horizontal wheel did not scroll Monaco`, {
		beforeHorizontalWheel,
		afterWheelScroll,
	});
	assert(afterWheelScroll.noteScrollTop === beforeHorizontalWheel.noteScrollTop, `${modeName}: horizontal wheel scrolled the Obsidian note`, {
		beforeHorizontalWheel,
		afterWheelScroll,
	});

	if (isMobileMode) {
		await evaluate(
			client,
			`(() => { const block = document.querySelector('.shiki-monaco-codeblock.shiki-monaco-active') ?? document.querySelector('.shiki-monaco-codeblock'); block?._monacoEditor?.setScrollLeft?.(0); return true; })()`,
		);
		const resetScroll = await readMonacoScrollState(client);
		const touchDispatch = await dispatchTouchDragOnMonacoHost(client, line.x + 140, line.y, Math.max(line.x + 20, line.x - 100), line.y);
		assert(touchDispatch?.ok, `${modeName}: touch drag dispatch failed`, touchDispatch);
		await delay(150);
		const afterTouchScroll = await readMonacoScrollState(client);
		assert(afterTouchScroll.scrollLeft > resetScroll.scrollLeft, `${modeName}: horizontal touch drag did not scroll Monaco`, {
			resetScroll,
			afterTouchScroll,
		});
	}

	const afterMonaco = await waitForMonaco(client, modeName, !isMobileMode);
	assert(afterMonaco.viewLines > 0, `${modeName}: Monaco lost rendered lines after editing`, afterMonaco);
	assert(!afterMonaco.fenceTextVisible, `${modeName}: raw fenced code block became visible after editing`, afterMonaco);
	await captureScreenshot(client, modeName);
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
				if (!app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) && typeof app.plugins.loadPlugin === 'function') {
					await app.plugins.loadPlugin(${JSON.stringify(PLUGIN_ID)});
				}
				await window.app.plugins.setEnable?.(true);
				await new Promise(resolve => setTimeout(resolve, 1500));
				if (!app.plugins.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)})) {
					await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
				}
				const plugin = app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) ?? app.plugins.plugins?.[${JSON.stringify(PLUGIN_ID)}];
				await plugin?.registerCm6Plugin?.();
				return app.plugins.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)}) ?? false;
			})()`,
		);
		await waitFor(client, `Boolean(app.plugins?.enabledPlugins?.has(${JSON.stringify(PLUGIN_ID)}))`, 'Plugin did not enable');
		const pluginState = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.getPlugin?.(${JSON.stringify(PLUGIN_ID)}) ?? app.plugins.plugins?.[${JSON.stringify(PLUGIN_ID)}];
				return {
					hasPlugin: Boolean(plugin),
					keys: plugin ? Object.keys(plugin).sort() : [],
					cm6PluginRegistered: Boolean(plugin?.cm6PluginRegistered),
					hasRegisterCm6Plugin: typeof plugin?.registerCm6Plugin === 'function',
					pluginManagerKeys: Object.keys(app.plugins ?? {}).sort(),
					pluginManagerMethods: Object.keys(Object.getPrototypeOf(app.plugins ?? {}) ?? {}).sort(),
					enabledPlugins: [...(app.plugins.enabledPlugins ?? [])],
					manifests: Object.keys(app.plugins.manifests ?? {}),
				};
			})()`,
		);
		assert(pluginState.cm6PluginRegistered, 'Plugin did not register CM6 editor extension', pluginState);
		await verifyMode(client, 'live preview', true, 'LIVE_PREVIEW_EDIT_');
		try {
			await evaluate(
				client,
				`(async () => {
					window.app?.emulateMobile?.(true);
					window.dispatchEvent(new Event('resize'));
					document.body.classList.toggle('shiki-mobile-transition-probe');
					document.body.classList.toggle('shiki-mobile-transition-probe');
					await new Promise(resolve => setTimeout(resolve, 1200));
					return Boolean(document.body.classList.contains('is-phone') || app.isMobile);
				})()`,
			);
		} catch (error) {
			if (!String(error).includes('Execution context was destroyed')) throw error;
			client.close();
			client = await waitForAppClient();
		}
		await waitFor(client, `Boolean(document.body.classList.contains('is-phone') || app.isMobile)`, 'Mobile emulation did not activate');
		await verifyMode(client, 'mobile live preview', true, 'MOBILE_LIVE_PREVIEW_EDIT_');

		const finalContent = await readFile(path.join(VAULT, NOTE_PATH), 'utf8');
		assert(finalContent.includes('LIVE_PREVIEW_EDIT_'), 'Live preview edit marker missing from disk', { finalContent });
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
