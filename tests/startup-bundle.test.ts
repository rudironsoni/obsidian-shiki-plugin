import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';

describe('startup bundle', () => {
	test('startup JavaScript stays small enough for fast Obsidian activation', () => {
		const bytes = statSync(new URL('../dist/main.js', import.meta.url)).size;

		expect(bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
	});

	test('startup JavaScript is a standalone Obsidian plugin entrypoint', () => {
		const startupBundle = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8');

		expect(startupBundle).not.toContain('require(`./');
		expect(startupBundle).not.toContain("require('./");
		expect(startupBundle).not.toContain('require("./');
	});

	test('heavy renderer is emitted as an explicit mobile-sync artifact', () => {
		expect(existsSync(new URL('../dist/modern-monaco.js', import.meta.url))).toBe(true);
	});

	test('startup bundle carries the renderer sidecar without bloating startup CSS', () => {
		const startupBundle = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8');
		const styles = readFileSync(new URL('../dist/styles.css', import.meta.url), 'utf8');

		// main.js now includes the inlined modern-monaco runtime (~4.8MB)
		// This is necessary for mobile compatibility where separate files aren't synced
		expect(startupBundle.length).toBeLessThan(6 * 1024 * 1024);
		expect(styles).not.toContain('shiki-highlighter-fallback:');
	});

	test('Monaco code block CSS owns horizontal mobile pan gestures', () => {
		const styles = readFileSync(new URL('../dist/styles.css', import.meta.url), 'utf8');

		expect(styles).toContain('.shiki-monaco-block');
		expect(styles).toContain('.shiki-monaco-editor');
		expect(styles).toContain('.markdown-preview-sizer');
		expect(styles).toContain('.markdown-preview-section');
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
		expect(workflow).toContain('uses: anothrNick/github-tag-action@1.75.0');
		expect(workflow).toContain('DRY_RUN: true');
		expect(workflow).toContain('PRERELEASE: true');
		expect(workflow).toContain('DEFAULT_BUMP: ${{ (startsWith(github.ref_name,');
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
