import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';

const repoRoot = new URL('..', import.meta.url);

function readSource(path: string): string {
	return readFileSync(new URL(path, repoRoot), 'utf8');
}

function productionSourceFiles(dir = new URL('packages/obsidian/src/', repoRoot)): URL[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const child = new URL(entry.name, dir);
		if (entry.isDirectory()) {
			return productionSourceFiles(new URL(entry.name + '/', dir));
		}
		if (!entry.isFile() || !/\.(ts|css)$/.test(entry.name)) {
			return [];
		}
		return [child];
	});
}

function readProductionSources(): Array<{ path: string; source: string }> {
	return productionSourceFiles().map(file => ({
		path: relative(repoRoot.pathname, file.pathname),
		source: readFileSync(file, 'utf8'),
	}));
}

function extractBlock(source: string, needle: string): string {
	const start = source.indexOf(needle);
	expect(start).toBeGreaterThanOrEqual(0);

	const firstBrace = source.indexOf('{', start);
	expect(firstBrace).toBeGreaterThanOrEqual(0);

	let depth = 0;
	for (let index = firstBrace; index < source.length; index++) {
		const char = source[index];
		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				return source.slice(start, index + 1);
			}
		}
	}

	throw new Error(`Unable to extract block for ${needle}`);
}

describe('architecture boundaries', () => {
	test('no Monaco files exist in production source', () => {
		const sources = readProductionSources();
		const monacoFiles = sources.filter(({ path }) => path.includes('monaco') || path.includes('Monaco'));
		expect(monacoFiles).toEqual([]);
	});

	test('code block processor registration uses static language metadata', () => {
		const mainSource = readSource('packages/obsidian/src/main.ts');
		const registerProcessors = extractBlock(mainSource, 'async registerCodeBlockProcessors');

		expect(registerProcessors).toContain('getObsidianSafeLanguageNames()');
		expect(registerProcessors).not.toContain('highlighter.obsidianSafeLanguageNames');
		expect(registerProcessors).not.toContain('monacoRuntime.obsidianSafeLanguageNames');
		expect(registerProcessors).not.toContain('ModernMonacoLoader');
		expect(registerProcessors).not.toContain('loadModernMonacoRuntime');
	});

	test('ShikiHighlighter is the only highlighter and does not depend on Monaco', () => {
		const highlighterSource = readSource('packages/obsidian/src/ShikiHighlighter.ts');
		expect(highlighterSource).toContain('createHighlighter');
		expect(highlighterSource).not.toContain('monaco');
		expect(highlighterSource).not.toContain('Monaco');
		expect(highlighterSource).not.toContain('modern-monaco');
	});

	test('Source mode adapter owns CodeMirror decorations only', () => {
		const sourceMode = readSource('packages/obsidian/src/modes/SourceModeAdapter.ts');

		expect(sourceMode).toContain('Decoration');
		expect(sourceMode).toContain('RangeSetBuilder');
		expect(sourceMode).not.toContain('MonacoCodeBlockSurface');
		expect(sourceMode).not.toContain('MonacoSurfaceRegistry');
		expect(sourceMode).not.toContain('monaco.editor.create');
		expect(sourceMode).not.toContain('removeMonacoArtifacts');
		expect(sourceMode).not.toContain('.shiki-monaco-block, .shiki-monaco-codeblock');
	});

	test('production source has no console spam or unguarded debug globals', () => {
		const matches = readProductionSources().flatMap(({ path, source }) => {
			const disallowed = [...source.matchAll(/console\.(?:log|debug|info)\s*\(|(?:globalThis|window)\.__shiki[A-Za-z0-9_]*|debugger\b/g)];
			return disallowed.map(match => ({ path, match: match[0] }));
		});

		expect(matches).toEqual([]);
	});

	test('styles do not contain Monaco-specific selectors', () => {
		const styles = readSource('packages/obsidian/src/styles.css');

		expect(styles).not.toContain('.shiki-monaco-block');
		expect(styles).not.toContain('.shiki-monaco-editor');
		expect(styles).not.toContain('.shiki-monaco-live-widget');
		expect(styles).not.toContain('.shiki-monaco-codeblock');
		expect(styles).not.toContain('.shiki-monaco-overlay-root');
		expect(styles).not.toContain('.shiki-monaco-selection-toolbar');
		expect(styles).not.toContain('.shiki-monaco-selection-handle');
		expect(styles).not.toContain('monaco-editor');
		expect(styles).not.toContain('monaco-scrollable-element');
	});
});
