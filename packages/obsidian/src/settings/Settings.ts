import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/Constants';

export interface Settings {
	disabledLanguages: string[];
	customThemeFolder: string;
	customLanguageFolder: string;
	/**
	 * Old theme setting, from before we had separate light/dark theme settings. Will me migrated on load.
	 */
	theme: string | undefined;
	darkTheme: string;
	lightTheme: string;
	preferThemeColors: boolean;
	inlineHighlighting: boolean;
	showLineNumbers: boolean;
	wrapLines: boolean;
	useEditorFontSize: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	disabledLanguages: [],
	customThemeFolder: '',
	customLanguageFolder: '',
	theme: undefined,
	darkTheme: OBSIDIAN_THEME_IDENTIFIER,
	lightTheme: OBSIDIAN_THEME_IDENTIFIER,
	preferThemeColors: true,
	inlineHighlighting: true,
	showLineNumbers: true,
	wrapLines: false,
	useEditorFontSize: true,
};
