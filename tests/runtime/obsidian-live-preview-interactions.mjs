#!/usr/bin/env node

const DEFAULT_PORT = 9230;
const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT ?? DEFAULT_PORT);

async function delay(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return response.json();
}

async function connectToExistingObsidian(port) {
	const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
	const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
	if (!page) {
		throw new Error(`No Obsidian page target is listening on CDP port ${port}`);
	}

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();

	ws.onmessage = event => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) {
			return;
		}
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) {
			reject(new Error(JSON.stringify(message.error)));
		} else {
			resolve(message.result);
		}
	};

	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	return {
		async send(method, params = {}) {
			const messageId = ++id;
			ws.send(JSON.stringify({ id: messageId, method, params }));
			return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
		},
		close() {
			ws.close();
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
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails));
	}
	return result.result.value;
}

function assert(condition, message, details) {
	if (!condition) {
		const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
		throw new Error(`${message}${suffix}`);
	}
}

function findNoteScrollerScript() {
	return `
		const fallbackScroller =
			document.querySelector('.workspace-leaf.mod-active .markdown-source-view .cm-scroller') ??
			document.querySelector('.workspace-leaf.mod-active .markdown-reading-view .markdown-preview-view') ??
			document.querySelector('.workspace-leaf.mod-active .cm-scroller') ??
			document.querySelector('.cm-scroller, .markdown-preview-view');
		let scroller = block?.parentElement ?? null;
		while (scroller && scroller !== document.body) {
			if (scroller.scrollHeight > scroller.clientHeight + 1 && !scroller.classList.contains('monaco-scrollable-element')) {
				break;
			}
			scroller = scroller.parentElement;
		}
		if (!scroller || scroller === document.body) {
			scroller = fallbackScroller;
		}
	`;
}

async function openProbeNote(client) {
	const longSegment = 'abcdefghijklmnopqrstuvwxyz0123456789_'.repeat(8);
	const content = [
		'# Live Preview Interaction Probe',
		'',
		'above '.repeat(90),
		'',
		'```ts',
		`const alpha = ${JSON.stringify(longSegment)};`,
		`const beta = ${JSON.stringify(longSegment)};`,
		`const gamma = ${JSON.stringify(longSegment)};`,
		'```',
		'',
		'below '.repeat(160),
	].join('\n');

	return evaluate(
		client,
		`(async () => {
			if (!window.app?.vault || !window.app?.workspace) {
				throw new Error('Obsidian app is not ready');
			}
			const path = 'codex-live-preview-interactions.md';
			const content = ${JSON.stringify(content)};
			let file = app.vault.getAbstractFileByPath(path);
			if (!file) {
				file = await app.vault.create(path, content);
			} else {
				await app.vault.modify(file, content);
			}
			const leaf = app.workspace.getLeaf(false);
			await leaf.setViewState({
				type: 'markdown',
				state: { file: path, mode: 'source', source: false },
				active: true,
			});
			await new Promise(resolve => setTimeout(resolve, 2500));
			return {
				activeFile: app.workspace.getActiveFile()?.path ?? null,
				mode: leaf.view.getState?.()?.mode ?? null,
				source: leaf.view.getState?.()?.source ?? null,
				monacoBlocks: document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock').length,
				monacoEditors: document.querySelectorAll('.monaco-editor').length,
			};
		})()`,
	);
}

async function applyPluginSettings(client, settings) {
	await evaluate(
		client,
		`(async () => {
			const plugin = window.app?.plugins?.plugins?.['shiki-highlighter'];
			if (!plugin) throw new Error('shiki-highlighter is not loaded');
			if (${JSON.stringify(Object.hasOwn(settings, 'wrap'))}) {
				plugin.settings.ecDefaultWrap = ${JSON.stringify(settings.wrap)};
			}
			if (${JSON.stringify(Object.hasOwn(settings, 'lineNumbers'))}) {
				plugin.settings.ecDefaultShowLineNumbers = ${JSON.stringify(settings.lineNumbers)};
			}
			plugin.loadedSettings = structuredClone(plugin.settings);
			await plugin.saveData(plugin.settings);
			return true;
		})()`,
	);
}

async function normalizeDesktopViewport(client) {
	await evaluate(client, `globalThis.app?.emulateMobile?.(false); true`);
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: 1200,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await delay(500);
}

async function normalizeMobileViewport(client) {
	await client.send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 3,
		mobile: true,
	});
	await evaluate(client, `globalThis.app?.emulateMobile?.(true); true`);
	await delay(900);
}

async function getInteractionState(client) {
	return evaluate(
		client,
		`(() => {
			const block = [...document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock')]
				.find(candidate => candidate._monacoEditor);
			const editor = block?._monacoEditor;
			${findNoteScrollerScript()}
			const rect = block?.getBoundingClientRect?.();
			return {
				hasBlock: !!block,
				hasEditor: !!editor,
				monacoBlocks: document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock').length,
				monacoEditors: document.querySelectorAll('.monaco-editor').length,
				rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
				noteScrollTop: scroller?.scrollTop ?? null,
				codeScrollLeft: editor?.getScrollLeft?.() ?? null,
				codeScrollTop: editor?.getScrollTop?.() ?? null,
				position: editor?.getPosition?.() ?? null,
				focused: editor?.hasTextFocus?.() ?? null,
				activeElement: {
					tag: document.activeElement?.tagName ?? null,
					className: String(document.activeElement?.className ?? ''),
				},
			};
		})()`,
	);
}

async function dispatchWheel(client, x, y, deltaX, deltaY) {
	await client.send('Input.dispatchMouseEvent', {
		type: 'mouseWheel',
		x,
		y,
		deltaX,
		deltaY,
	});
	await delay(250);
}

async function setNoteScrollTop(client, scrollTop) {
	await evaluate(
		client,
		`(() => {
			const block = [...document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock')]
				.find(candidate => candidate._monacoEditor);
			${findNoteScrollerScript()}
			if (!scroller || scroller === document.body) {
				throw new Error('No active note scroller found');
			}
			scroller.scrollTop = ${JSON.stringify(scrollTop)};
		})()`,
	);
	await delay(250);
}

async function click(client, x, y) {
	await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
	await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
	await delay(600);
}

async function longPress(client, x, y) {
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
	});
	await delay(700);
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await delay(500);
}

async function getSelectionToolbarState(client) {
	return evaluate(
		client,
		`(() => {
			const block = [...document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock')]
				.find(candidate => candidate._monacoEditor);
			const editor = block?._monacoEditor;
			const selection = editor?.getSelection?.();
			const model = editor?.getModel?.();
			const selectedText = selection && model ? model.getValueInRange(selection) : '';
			const toolbar = document.querySelector('.shiki-monaco-selection-toolbar');
			return {
				toolbarVisible: !!toolbar && !toolbar.hasAttribute('hidden'),
				buttons: [...document.querySelectorAll('.shiki-monaco-selection-toolbar button')].map(button => button.textContent ?? ''),
				handles: document.querySelectorAll('.shiki-monaco-selection-handle:not([hidden])').length,
				selectedText,
				modelText: model?.getValue?.() ?? '',
				selection,
			};
		})()`,
	);
}

async function installClipboardProbe(client) {
	await evaluate(
		client,
		`(() => {
			window.__codexSelectionClipboardText = null;
			const capture = text => {
				window.__codexSelectionClipboardText = String(text ?? '');
			};
			try {
				const clipboard = navigator.clipboard ?? {};
				Object.defineProperty(clipboard, 'writeText', {
					configurable: true,
					value: async text => capture(text),
				});
				Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
			} catch {
				// Some embedded browser builds expose navigator.clipboard as non-configurable.
			}
			const originalExecCommand = document.execCommand?.bind(document);
			document.execCommand = command => {
				if (command === 'copy') {
					const block = [...document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock')]
						.find(candidate => candidate._monacoEditor);
					const editor = block?._monacoEditor;
					const selection = editor?.getSelection?.();
					const model = editor?.getModel?.();
					capture(selection && model ? model.getValueInRange(selection) : '');
					return true;
				}
				return originalExecCommand?.(command) ?? false;
			};
		})()`,
	);
}

async function getClipboardProbeText(client) {
	return evaluate(client, `(() => window.__codexSelectionClipboardText ?? '')()`);
}

async function clickSelectionToolbarButton(client, label) {
	await evaluate(
		client,
		`(() => {
			const button = [...document.querySelectorAll('.shiki-monaco-selection-toolbar button')]
				.find(candidate => candidate.textContent === ${JSON.stringify(label)});
			if (!button) {
				throw new Error('Selection toolbar button not found: ' + ${JSON.stringify(label)});
			}
			button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
			button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		})()`,
	);
	await delay(300);
}

async function waitForUsableInteractionState(client) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const state = await getInteractionState(client);
		if (state.hasBlock && state.hasEditor && state.rect && state.rect.width > 80 && state.rect.height > 40) {
			return state;
		}
		await delay(250);
	}
	return getInteractionState(client);
}

async function assertStableLivePreviewSurfaceAfterRerenders(client) {
	const before = await getInteractionState(client);
	assert(before.monacoBlocks === 1 && before.monacoEditors === 1, 'Live Preview stability setup has duplicate Monaco surfaces', before);
	const stability = await evaluate(
		client,
		`(async () => {
			const block = document.querySelector('.shiki-monaco-block, .shiki-monaco-codeblock');
			const editor = document.querySelector('.monaco-editor');
			if (!block || !editor) return { missing: true };
			block.dataset.stabilityProbe = 'stable-block';
			editor.dataset.stabilityProbe = 'stable-editor';
			for (let i = 0; i < 5; i++) {
				window.dispatchEvent(new Event('resize'));
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			}
			return {
				monacoBlocks: document.querySelectorAll('.shiki-monaco-block, .shiki-monaco-codeblock').length,
				monacoEditors: document.querySelectorAll('.monaco-editor').length,
				stableBlock: document.querySelector('[data-stability-probe="stable-block"]') !== null,
				stableEditor: document.querySelector('[data-stability-probe="stable-editor"]') !== null,
			};
		})()`,
	);
	assert(stability.monacoBlocks === 1 && stability.monacoEditors === 1, 'Live Preview rerenders grew duplicate Monaco surfaces', stability);
	assert(stability.stableBlock && stability.stableEditor, 'Live Preview rerenders replaced the stable Monaco surface', stability);
}

async function main() {
	const client = await connectToExistingObsidian(PORT);
	try {
		await client.send('Runtime.enable');
		await client.send('Page.enable');
		await client.send('Input.setIgnoreInputEvents', { ignore: false });

		const setup = await openProbeNote(client);
		assert(setup.activeFile === 'codex-live-preview-interactions.md', 'Probe note did not become active', setup);
		assert(setup.monacoEditors === 1, 'Probe note should create exactly one Monaco editor', setup);

		await normalizeDesktopViewport(client);
		await setNoteScrollTop(client, 0);

		let before = await waitForUsableInteractionState(client);
		assert(before.hasBlock && before.hasEditor && before.rect, 'Monaco surface did not hydrate for probe note', before);
		assert(before.monacoBlocks === 1 && before.monacoEditors === 1, 'Probe note mounted duplicate Monaco surfaces', before);

		await assertStableLivePreviewSurfaceAfterRerenders(client);
		before = await waitForUsableInteractionState(client);
		assert(before.rect && before.rect.width > 80, 'Monaco surface did not have a usable layout rectangle after rerender stability probe', before);

		let insideX = Math.round(before.rect.left + Math.min(before.rect.width - 20, 230));
		let insideY = Math.round(before.rect.top + Math.min(before.rect.height - 8, 30));

		await click(client, insideX, insideY);
		const afterClick = await getInteractionState(client);
		assert(afterClick.focused === true, 'Click inside editable Live Preview Monaco did not focus the editor', {
			before,
			afterClick,
		});
		assert(afterClick.position?.lineNumber >= 1 && afterClick.position?.column > 1, 'Click did not place a Monaco cursor', {
			before,
			afterClick,
		});

		await normalizeMobileViewport(client);
		const mobileSetup = await openProbeNote(client);
		assert(mobileSetup.activeFile === 'codex-live-preview-interactions.md', 'Mobile probe note did not become active', mobileSetup);
		before = await waitForUsableInteractionState(client);
		assert(before.rect && before.rect.width > 80, 'Mobile Monaco surface did not have usable layout rectangle', before);
		insideX = Math.round(before.rect.left + Math.min(before.rect.width - 20, 120));
		insideY = Math.round(before.rect.top + Math.min(before.rect.height - 8, 30));

		await longPress(client, insideX, insideY);
		const afterLongPress = await getSelectionToolbarState(client);
		assert(afterLongPress.toolbarVisible, 'Long press did not show the mobile selection toolbar', { afterLongPress });
		assert(afterLongPress.handles === 2, 'Long press did not show both mobile selection handles', { afterLongPress });
		assert(afterLongPress.selectedText.length > 0, 'Long press did not select text', { afterLongPress });
		for (const label of ['Copy', 'Select All', 'Clear']) {
			assert(afterLongPress.buttons.includes(label), 'Selection toolbar is missing an expected action', { label, afterLongPress });
		}

		await clickSelectionToolbarButton(client, 'Select All');
		const afterSelectAll = await getSelectionToolbarState(client);
		assert(afterSelectAll.selectedText === afterSelectAll.modelText, 'Select All did not select the full Monaco model', {
			afterSelectAll,
		});

		await clickSelectionToolbarButton(client, 'Clear');
		const afterClear = await getSelectionToolbarState(client);
		assert(afterClear.selectedText === '', 'Clear did not collapse the Monaco selection', { afterClear });
		assert(afterClear.handles === 0, 'Clear did not hide mobile selection handles', { afterClear });

		await longPress(client, insideX, insideY);
		const beforeCopy = await getSelectionToolbarState(client);
		assert(beforeCopy.selectedText.length > 0, 'Second long press did not select text before Copy', { beforeCopy });
		await installClipboardProbe(client);
		await clickSelectionToolbarButton(client, 'Copy');
		const copiedText = await getClipboardProbeText(client);
		assert(copiedText.length > 0 && copiedText.includes('abcdefghijklmnopqrstuvwxyz'), 'Copy did not write selected Monaco text content', {
			copiedText,
			beforeCopy,
		});

		await normalizeDesktopViewport(client);
		await applyPluginSettings(client, { wrap: false, lineNumbers: false });
		const scrollSetup = await openProbeNote(client);
		assert(scrollSetup.activeFile === 'codex-live-preview-interactions.md', 'Desktop scroll probe note did not become active', scrollSetup);
		await setNoteScrollTop(client, 0);
		before = await waitForUsableInteractionState(client);
		assert(before.rect && before.rect.width > 80, 'Desktop scroll Monaco surface did not have usable layout rectangle', before);
		insideX = Math.round(before.rect.left + Math.min(before.rect.width - 20, 230));
		insideY = Math.round(before.rect.top + Math.min(before.rect.height - 8, 30));

		await dispatchWheel(client, insideX, insideY, 900, 0);
		const afterHorizontal = await getInteractionState(client);
		assert(afterHorizontal.codeScrollLeft > before.codeScrollLeft, 'Horizontal wheel inside the code block did not scroll Monaco horizontally', {
			before,
			afterHorizontal,
		});
		assert(afterHorizontal.codeScrollTop === 0, 'Horizontal wheel changed Monaco vertical scroll', {
			before,
			afterHorizontal,
		});

		await dispatchWheel(client, insideX, insideY, 0, 600);
		const afterVerticalInside = await getInteractionState(client);
		assert(afterVerticalInside.noteScrollTop > afterHorizontal.noteScrollTop, 'Vertical wheel inside code did not scroll note', {
			afterHorizontal,
			afterVerticalInside,
		});
		assert(afterVerticalInside.codeScrollTop === 0, 'Vertical wheel inside code changed Monaco vertical scroll', {
			afterHorizontal,
			afterVerticalInside,
		});

		await setNoteScrollTop(client, 0);
		const beforeOutside = await getInteractionState(client);
		assert(beforeOutside.rect, 'Monaco surface rect disappeared before outside-scroll check', beforeOutside);

		const outsideX = Math.round(beforeOutside.rect.left + 30);
		const outsideY = Math.max(120, Math.round(beforeOutside.rect.top - 80));
		await dispatchWheel(client, outsideX, outsideY, 0, 600);
		const afterOutside = await getInteractionState(client);
		assert(afterOutside.noteScrollTop > beforeOutside.noteScrollTop, 'Vertical wheel outside code did not scroll note', {
			beforeOutside,
			afterOutside,
		});
		assert(afterOutside.monacoBlocks === 1 && afterOutside.monacoEditors === 1, 'Editor count grew during interaction flow', {
			before,
			afterOutside,
		});

		console.log(
			JSON.stringify({
				port: PORT,
				cursor: afterClick.position,
				scroll: {
					beforeNote: before.noteScrollTop,
					afterHorizontalCodeLeft: afterHorizontal.codeScrollLeft,
					afterInsideNote: afterVerticalInside.noteScrollTop,
					afterOutsideNote: afterOutside.noteScrollTop,
					codeScrollTop: afterOutside.codeScrollTop,
				},
				editors: afterOutside.monacoEditors,
			}),
		);
	} finally {
		await normalizeDesktopViewport(client).catch(() => undefined);
		client.close();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
