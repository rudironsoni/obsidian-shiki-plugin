import { createRequire } from 'node:module';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

const emulateMobile = process.env.OBSIDIAN_EMULATE_MOBILE === 'true';

HTMLElement.prototype.findAll = function findAll(selector) {
	return Array.from(this.querySelectorAll(selector));
};

HTMLElement.prototype.empty = function empty() {
	this.textContent = '';
};

HTMLElement.prototype.createEl = function createEl(tag, options = {}) {
	const el = document.createElement(tag);
	if (options.text) el.textContent = options.text;
	this.appendChild(el);
	return el;
};

class MockPlugin {
	constructor() {
		this.manifest = { id: 'shiki-highlighter', name: 'Shiki Highlighter', version: '0.0.0' };
		this.app = {
			isMobile: emulateMobile,
			emulateMobile: value => {
				this.app.isMobile = value;
			},
			isDarkMode: () => true,
			vault: {
				adapter: {
					exists: async () => false,
					list: async () => ({ files: [], folders: [] }),
					read: async () => '',
				},
				on: () => ({}),
			},
			workspace: {
				containerEl: document.createElement('div'),
				on: () => ({}),
				updateOptions: () => {},
			},
			openWithDefaultApp: () => {},
		};
	}

	async loadData() {
		return null;
	}

	async saveData() {}

	addSettingTab() {}
	registerMarkdownPostProcessor() {}
	registerMarkdownCodeBlockProcessor() {}
	registerEditorExtension() {}
	register(registerable) {
		return registerable;
	}

	registerInterval(id) {
		return id;
	}

	registerEvent() {}
	addCommand() {}
}

class MockMarkdownRenderChild {
	constructor(containerEl) {
		this.containerEl = containerEl;
	}

	onload() {}
	onunload() {}
}

class MockSetting {
	constructor(containerEl) {
		this.containerEl = containerEl;
	}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	setHeading() {
		return this;
	}
	addButton() {
		return this;
	}
	addToggle() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addText() {
		return this;
	}
	addExtraButton() {
		return this;
	}
}

const obsidianMock = {
	debounce: fn => fn,
	loadPrism: async () => ({
		util: {
			currentScript: () => null,
			getLanguage: () => '',
		},
		plugins: {},
		hooks: { add: () => {} },
	}),
	Plugin: MockPlugin,
	TFile: class {},
	normalizePath: path => path,
	Notice: class {},
	editorLivePreviewField: {},
	MarkdownRenderChild: MockMarkdownRenderChild,
	PluginSettingTab: class {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = document.createElement('div');
		}
	},
	Setting: MockSetting,
	Platform: {
		isDesktopApp: !emulateMobile,
		isDesktop: !emulateMobile,
		isMobile: emulateMobile,
		isIosApp: false,
		isAndroidApp: emulateMobile,
	},
	FuzzySuggestModal: class {
		constructor(app) {
			this.app = app;
		}
		open() {}
	},
};

window.setTimeout = () => 0;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => {
	if (request === 'obsidian') return obsidianMock;
	return originalLoad(request, parent, isMain);
};

const startedAt = performance.now();
const mod = require('../../dist/main.js');
const loadedAt = performance.now();
const PluginClass = mod.default;
const plugin = new PluginClass();
if (emulateMobile) {
	plugin.app.emulateMobile(true);
}
await plugin.onload();
const loadedPluginAt = performance.now();

const result = {
	mode: emulateMobile ? 'mobile-emulation' : 'desktop',
	requireMs: loadedAt - startedAt,
	onloadMs: loadedPluginAt - loadedAt,
	totalMs: loadedPluginAt - startedAt,
};

console.log(JSON.stringify(result));

if (result.totalMs > 200) {
	process.exitCode = 1;
}
