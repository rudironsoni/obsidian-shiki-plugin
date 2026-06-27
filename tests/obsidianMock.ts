import { mock } from 'bun:test';
import Moment from 'moment';

mock.module('virtual:ec-styles.css', () => ({}));

mock.module('obsidian', () => ({
	debounce(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
		return fn;
	},
	loadPrism: async () => ({
		util: {
			currentScript: () => null,
			getLanguage: () => '',
		},
		plugins: {},
		hooks: { add: () => {} },
	}),
	Plugin: class {
		manifest = { id: 'shiki-highlighter', name: 'Shiki Highlighter', version: '0.0.0', dir: '.obsidian/plugins/shiki-highlighter' };
		app = {
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
				on: () => ({}),
				updateOptions: () => {},
			},
			openWithDefaultApp: () => {},
		};
		settingTabs: unknown[] = [];
		markdownPostProcessors: unknown[] = [];
		markdownCodeBlockProcessors: unknown[] = [];
		commands: unknown[] = [];
		events: unknown[] = [];
		editorExtensions: unknown[] = [];

		async loadData(): Promise<unknown> {
			return null;
		}

		async saveData(): Promise<void> {}

		addSettingTab(tab: unknown): void {
			this.settingTabs.push(tab);
		}

		registerMarkdownPostProcessor(processor: unknown): void {
			this.markdownPostProcessors.push(processor);
		}

		registerMarkdownCodeBlockProcessor(language: unknown, processor: unknown, sortOrder: unknown): void {
			this.markdownCodeBlockProcessors.push({ language, processor, sortOrder });
		}

		registerEditorExtension(extension: unknown): void {
			this.editorExtensions.push(extension);
		}

		register<T>(registerable: T): T {
			return registerable;
		}

		registerInterval(id: number): number {
			return id;
		}

		registerEvent(event: unknown): void {
			this.events.push(event);
		}

		addCommand(command: unknown): void {
			this.commands.push(command);
		}
	},
	TFile: class {},
	normalizePath(path: string): string {
		return path;
	},
	Notice: class {},
	editorLivePreviewField: {},
	MarkdownRenderChild: class {
		containerEl: HTMLElement;

		constructor(containerEl: HTMLElement) {
			this.containerEl = containerEl;
		}

		onload(): void {}
		onunload(): void {}
	},
	PluginSettingTab: class {
		app: unknown;
		plugin: unknown;
		containerEl = document.createElement('div');

		constructor(app: unknown, plugin: unknown) {
			this.app = app;
			this.plugin = plugin;
		}
	},
	Setting: class {
		constructor(_containerEl: HTMLElement) {}
		setName(): this {
			return this;
		}
		setDesc(): this {
			return this;
		}
		setHeading(): this {
			return this;
		}
		addButton(): this {
			return this;
		}
		addToggle(): this {
			return this;
		}
		addDropdown(): this {
			return this;
		}
		addText(): this {
			return this;
		}
		addExtraButton(): this {
			return this;
		}
	},
	Platform: {
		isDesktopApp: true,
		isDesktop: true,
		isMobile: false,
		isIosApp: false,
		isAndroidApp: false,
	},
	FuzzySuggestModal: class {
		app: unknown;

		constructor(app: unknown) {
			this.app = app;
		}
		open(): void {}
	},
	setIcon(iconEl: HTMLElement, iconName: string): void {
		// do nothing
	},
	moment: Moment,
}));
