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
	test('only MonacoCodeBlockSurface creates Monaco editors', () => {
		const sourceFiles = [
			'packages/obsidian/src/LazyHighlighter.ts',
			'packages/obsidian/src/codemirror/Cm6_ViewPlugin.ts',
			'packages/obsidian/src/main.ts',
			'packages/obsidian/src/modes/LivePreviewAdapter.ts',
			'packages/obsidian/src/modes/ReadingViewAdapter.ts',
			'packages/obsidian/src/modes/SourceModeAdapter.ts',
			'packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts',
			'packages/obsidian/src/monaco/MonacoSurfaceRegistry.ts',
		];
		const creators = sourceFiles.filter(path => readSource(path).includes('monaco.editor.create'));

		expect(creators.map(path => relative(repoRoot.pathname, new URL(path, repoRoot).pathname))).toEqual([
			'packages/obsidian/src/monaco/MonacoCodeBlockSurface.ts',
		]);
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

	test('cheap language listing does not import or load modern Monaco runtime', () => {
		const runtimeSource = readSource('packages/obsidian/src/monaco/LazyMonacoRuntime.ts');
		const obsidianSafeLanguageNames = extractBlock(runtimeSource, 'async obsidianSafeLanguageNames');

		expect(obsidianSafeLanguageNames).toContain('getObsidianSafeLanguageNames()');
		expect(obsidianSafeLanguageNames).not.toContain('ModernMonacoLoader');
		expect(obsidianSafeLanguageNames).not.toContain('loadModernMonacoRuntime');
		expect(obsidianSafeLanguageNames).not.toContain('this.load');
	});

	test('surface registry creates cheap persistent surfaces without hydrating Monaco', () => {
		const registrySource = readSource('packages/obsidian/src/monaco/MonacoSurfaceRegistry.ts');
		const getOrCreate = extractBlock(registrySource, 'getOrCreate(block');

		expect(getOrCreate).toContain('new MonacoCodeBlockSurface');
		expect(getOrCreate).not.toContain('hydrateReadonly');
		expect(getOrCreate).not.toContain('activateEditable');
		expect(getOrCreate).not.toContain('loadModernMonacoRuntime');
		expect(getOrCreate).not.toContain('.load(');
	});

	test('runtime reload clears the modern Monaco module promise before reloading', () => {
		const loaderSource = readSource('packages/obsidian/src/ModernMonacoLoader.ts');
		const runtimeSource = readSource('packages/obsidian/src/monaco/LazyMonacoRuntime.ts');
		const unload = extractBlock(runtimeSource, 'async unload');
		const reload = extractBlock(runtimeSource, 'async reload');

		expect(loaderSource).toContain('export function resetModernMonacoModule');
		expect(unload).toContain('resetModernMonacoModule()');
		expect(unload).toContain('this.runtime = undefined');
		expect(unload).toContain('this.loading = undefined');
		expect(reload).toContain('await this.unload()');
	});

	test('Source mode adapter owns CodeMirror decorations only', () => {
		const sourceMode = readSource('packages/obsidian/src/modes/SourceModeAdapter.ts');

		expect(sourceMode).toContain('Decoration');
		expect(sourceMode).toContain('RangeSetBuilder');
		expect(sourceMode).not.toContain('MonacoCodeBlockSurface');
		expect(sourceMode).not.toContain('MonacoSurfaceRegistry');
		expect(sourceMode).not.toContain('monaco.editor.create');
		expect(sourceMode).toContain('removeMonacoArtifacts');
		expect(sourceMode).toContain('.shiki-monaco-block, .shiki-monaco-codeblock');
	});
	test('production source has no console spam or unguarded debug globals', () => {
		const matches = readProductionSources().flatMap(({ path, source }) => {
			const disallowed = [...source.matchAll(/console\.(?:log|debug|info)\s*\(|(?:globalThis|window)\.__shiki[A-Za-z0-9_]*|debugger\b/g)];
			return disallowed.map(match => ({ path, match: match[0] }));
		});

		expect(matches).toEqual([]);
	});

	test('Monaco CSS does not globally hide editable mobile input or selection internals', () => {
		const styles = readSource('packages/obsidian/src/styles.css');

		expect(styles).not.toContain('textarea');
		expect(styles).not.toContain('inputarea');
		expect(styles).not.toContain('body.is-mobile .shiki-monaco-selection-toolbar');
		expect(styles).not.toContain('body.is-mobile .shiki-monaco-selection-handle');
		expect(styles).not.toContain('pointer-events:none!important;resize:none');
		expect(styles).toContain('.shiki-editing-codeblock-line-hidden');
		expect(styles).toContain('pointer-events: none !important');
	});
});
