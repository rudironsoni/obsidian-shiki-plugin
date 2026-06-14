import { afterEach, describe, expect, test } from 'bun:test';
import { ThemeMapper } from 'packages/obsidian/src/themes/ThemeMapper';

function createMapper(isDarkMode: boolean): ThemeMapper {
	return new ThemeMapper({
		app: {
			isDarkMode: () => isDarkMode,
		},
		loadedSettings: {
			darkTheme: 'selected-dark-theme',
			lightTheme: 'selected-light-theme',
		},
	} as never);
}

describe('theme mapper', () => {
	afterEach(() => {
		document.body.classList.remove('theme-dark', 'theme-light');
	});

	test('uses the rendered light theme class before app.isDarkMode fallback', () => {
		document.body.classList.add('theme-light');

		expect(createMapper(true).getThemeIdentifier()).toBe('selected-light-theme');
	});

	test('uses the rendered dark theme class before app.isDarkMode fallback', () => {
		document.body.classList.add('theme-dark');

		expect(createMapper(false).getThemeIdentifier()).toBe('selected-dark-theme');
	});

	test('falls back to app.isDarkMode when no theme class is present', () => {
		expect(createMapper(true).getThemeIdentifier()).toBe('selected-dark-theme');
		expect(createMapper(false).getThemeIdentifier()).toBe('selected-light-theme');
	});
});
