import { describe, expect, test } from 'bun:test';
import { SourceModeTokenizationCache } from 'packages/obsidian/src/runtime/SourceModeTokenizationCache';

type CacheInput = Parameters<SourceModeTokenizationCache['get']>[0];
type CacheValue = NonNullable<Parameters<SourceModeTokenizationCache['set']>[1]>;

const baseInput = (): CacheInput => ({
	sourcePath: 'vault/note.md',
	language: 'ts',
	theme: 'github-dark',
	contentHash: 'hash-a',
	settingsSignature: 'wrap-off|font-default',
});

const tokenized = (label: string): CacheValue => ({
	tokens: [[{ content: label, color: '#123456', offset: 0 }]],
});

describe('SourceModeTokenizationCache', () => {
	test('keys tokenization by source path, language, theme, content hash, and settings signature', () => {
		const cache = new SourceModeTokenizationCache();
		const input = baseInput();
		const value = tokenized('const');
		cache.set(input, value);

		expect(cache.get(input)).toBe(value);
		for (const changed of [
			{ sourcePath: 'vault/other.md' },
			{ language: 'tsx' },
			{ theme: 'github-light' },
			{ contentHash: 'hash-b' },
			{ settingsSignature: 'wrap-on|font-default' },
		]) {
			expect(cache.get({ ...input, ...changed })).toBeUndefined();
		}
	});

	test('clear invalidates cached source mode tokenization', () => {
		const cache = new SourceModeTokenizationCache();
		const input = baseInput();
		cache.set(input, tokenized('let'));

		expect(cache.get(input)).toBeDefined();
		cache.clear();
		expect(cache.get(input)).toBeUndefined();
	});
});

test('plugin reload clears source mode tokenization cache before CM6 refresh', async () => {
	const { default: ShikiHighlighterPlugin } = await import('../packages/obsidian/src/main');
	const cacheClearCalls: string[] = [];
	const rerenderCalls: string[] = [];
	const updateCalls: string[] = [];
	const reloadCalls: string[] = [];
	type ReloadHarness = {
		reloadHighlighter: () => Promise<void>;
		sourceModeTokenizationCache: { clear: () => void };
		highlighter: { reload: () => Promise<void> };
		activeCodeBlocks: Map<string, Array<{ forceRerender: () => Promise<void> }>>;
		updateCm6Plugin: () => Promise<void>;
		ensureSettingsLoaded: () => Promise<void>;
		settings: Record<string, never>;
		loadedSettings: Record<string, never>;
	};
	const plugin = Object.create(ShikiHighlighterPlugin.prototype) as ReloadHarness;

	plugin.settings = {};
	plugin.loadedSettings = {};
	plugin.ensureSettingsLoaded = async () => undefined;
	plugin.sourceModeTokenizationCache = {
		clear: () => {
			cacheClearCalls.push('clear');
		},
	};
	plugin.highlighter = {
		reload: async () => {
			reloadCalls.push('reload');
		},
	};
	plugin.activeCodeBlocks = new Map([
		[
			'note.md',
			[
				{
					forceRerender: async () => {
						rerenderCalls.push('rerender');
					},
				},
			],
		],
	]);
	plugin.updateCm6Plugin = async () => {
		updateCalls.push('update-cm6');
	};

	await plugin.reloadHighlighter();

	expect(cacheClearCalls).toEqual(['clear']);
	expect(reloadCalls).toEqual(['reload']);
	expect(rerenderCalls).toEqual(['rerender']);
	expect(updateCalls).toEqual(['update-cm6']);
});
