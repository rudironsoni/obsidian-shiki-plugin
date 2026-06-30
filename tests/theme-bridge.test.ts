import { describe, expect, test } from 'bun:test';
import type { default as ShikiPlugin } from 'packages/obsidian/src/main';
import { getActiveTheme } from 'packages/obsidian/src/runtime/ThemeBridge';

const makePlugin = (isDarkMode: boolean): ShikiPlugin =>
	({
		app: {
			isDarkMode: () => isDarkMode,
		},
		loadedSettings: {
			darkTheme: 'obsidian-theme',
			lightTheme: 'obsidian-theme',
		},
	}) as ShikiPlugin;

describe('ThemeBridge', () => {
	test('prefers dark mode when the dark class is present', () => {
		document.body.classList.add('theme-dark');
		document.body.classList.remove('theme-light');

		const theme = getActiveTheme(makePlugin(false));
		expect(theme).toBe('github-dark');
		document.body.classList.remove('theme-dark');
	});

	test('falls back to app theme when body classes are absent', () => {
		document.body.className = '';

		const darkTheme = getActiveTheme(makePlugin(true));
		const lightTheme = getActiveTheme(makePlugin(false));
		expect(darkTheme).toBe('github-dark');
		expect(lightTheme).toBe('github-light');
	});

	test('uses app dark mode when body has conflicting dark and light classes', () => {
		document.body.classList.add('theme-dark');
		document.body.classList.add('theme-light');

		const darkTheme = getActiveTheme(makePlugin(false));
		expect(darkTheme).toBe('github-dark');
		document.body.className = '';
	});
});
