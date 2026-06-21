import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/Constants';
import type ShikiPlugin from 'packages/obsidian/src/main';

export function getActiveTheme(plugin: ShikiPlugin): string {
	const isDark = document.body.classList.contains('theme-dark') || (!document.body.classList.contains('theme-light') && plugin.app.isDarkMode());
	const setting = isDark ? plugin.loadedSettings.darkTheme : plugin.loadedSettings.lightTheme;
	if (setting === OBSIDIAN_THEME_IDENTIFIER) {
		return isDark ? 'github-dark' : 'github-light';
	}
	return setting;
}

export function getConfiguredThemes(plugin: ShikiPlugin): string[] {
	const themes = new Set<string>();
	const resolve = (value: string, mode: 'dark' | 'light'): string => {
		if (value === OBSIDIAN_THEME_IDENTIFIER) {
			return mode === 'dark' ? 'github-dark' : 'github-light';
		}
		return value;
	};
	themes.add(resolve(plugin.loadedSettings.darkTheme, 'dark'));
	themes.add(resolve(plugin.loadedSettings.lightTheme, 'light'));
	return [...themes].filter(Boolean);
}
