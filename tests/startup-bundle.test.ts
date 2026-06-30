import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';

describe('startup bundle', () => {
	test('startup JavaScript stays small enough for fast Obsidian activation', () => {
		const bytes = statSync(new URL('../dist/main.js', import.meta.url)).size;

		// Shiki is lazy-loaded from sidecars; startup should stay far below the old all-in-one bundle.
		expect(bytes).toBeLessThanOrEqual(128 * 1024);
	});

	test('startup JavaScript is the real Obsidian plugin entrypoint', () => {
		const startupBundle = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8');

		expect(startupBundle).toMatch(/extends [a-zA-Z_$][\w$]*\.Plugin/);
		expect(startupBundle).toContain('exports.default=');
		expect(startupBundle).not.toContain('exports.default=require');
		expect(startupBundle).not.toContain('exports.default=e.default');
	});

	test('startup bundle defers Shiki and excludes Monaco', () => {
		const startupBundle = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8');
		const manifest = readFileSync(new URL('../dist/manifest.json', import.meta.url), 'utf8');

		expect(startupBundle).not.toContain('function createHighlighter');
		expect(startupBundle).not.toContain('createHighlighterCore');
		expect(startupBundle).not.toContain('monaco.editor.create');
		expect(startupBundle).not.toContain('modern-monaco');
		expect(manifest).not.toContain('shikiModernMonacoFallback');
	});

	test('Shiki is packaged in generated JavaScript sidecars', () => {
		const sidecars = ['../dist/dist.js', '../dist/typescript.js', '../dist/github-dark.js'];

		for (const sidecar of sidecars) {
			expect(existsSync(new URL(sidecar, import.meta.url))).toBe(true);
		}

		const shikiSidecar = readFileSync(new URL('../dist/dist.js', import.meta.url), 'utf8');
		expect(shikiSidecar).toContain('createHighlighter');
	});

	test('Shiki code block CSS owns horizontal scroll inside blocks', () => {
		const styles = readFileSync(new URL('../dist/styles.css', import.meta.url), 'utf8');

		expect(styles).toContain('.shiki-reading-block');
		expect(styles).toContain('.shiki-live-preview-block');
		expect(styles).toContain('overflow-x:auto');
	});

	test('release workflow uploads every generated JavaScript sidecar', () => {
		const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

		expect(workflow).toContain('dist/*.js');
		expect(workflow).toContain('dist/*.css');
		expect(workflow).not.toContain('dist/main.js');
	});

	test('release workflow marks every SemVer prerelease tag as prerelease', () => {
		const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

		expect(workflow).toContain('github.ref_name');
		expect(workflow).toContain('== *-*');
	});

	test('beta workflow publishes typed branches with computed SemVer tags', () => {
		const workflow = readFileSync(new URL('../.github/workflows/beta-release.yml', import.meta.url), 'utf8');

		expect(workflow).toContain("'feature/**'");
		expect(workflow).toContain("'feature-*'");
		expect(workflow).toContain("'fix/**'");
		expect(workflow).toContain("'bug/**'");
		expect(workflow).toContain("'chore/**'");
		expect(workflow).toContain("'deps/**'");
		expect(workflow).toContain('git fetch --tags --force');
		expect(workflow).toContain('git tag --list');
		expect(workflow).toContain('-beta\\.(\\d+)');
		expect(workflow).toContain('latest.beta + 1');
		expect(workflow).toContain('Apply beta version to plugin manifests');
		expect(workflow).toContain('BETA_VERSION: ${{ steps.beta-version.outputs.new_tag }}');
		expect(workflow).toContain('Commit beta version for BRAT');
		expect(workflow).toContain('git add package.json manifest.json manifest-beta.json versions.json');
		expect(workflow).toContain('[skip ci]');
		expect(workflow).toContain('tag_name: ${{ steps.beta-version.outputs.new_tag }}');
		expect(workflow).toContain('prerelease: true');
		expect(workflow).toContain('target_commitish: ${{ github.ref_name }}');
		expect(workflow).toContain('dist/*.js');
		expect(workflow).toContain('dist/*.css');
	});
});
