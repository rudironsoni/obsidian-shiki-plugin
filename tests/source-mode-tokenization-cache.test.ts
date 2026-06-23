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
