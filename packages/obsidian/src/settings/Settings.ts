import { DEFAULT_DARK_SHIKI_THEME, DEFAULT_LIGHT_SHIKI_THEME } from 'packages/obsidian/src/Constants';

export enum FrameType {
	Code = 'code',
	Terminal = 'terminal',
	None = 'none',
	Auto = 'auto',
}

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
	ecDefaultShowLineNumbers: boolean;
	ecDefaultWrap: boolean;
	ecDefaultFrame: FrameType;
}

export const DEFAULT_SETTINGS: Settings = {
	disabledLanguages: [],
	customThemeFolder: '',
	customLanguageFolder: '',
	theme: undefined,
	darkTheme: DEFAULT_DARK_SHIKI_THEME,
	lightTheme: DEFAULT_LIGHT_SHIKI_THEME,
	preferThemeColors: true,
	inlineHighlighting: true,
	ecDefaultShowLineNumbers: false,
	ecDefaultWrap: false,
	ecDefaultFrame: FrameType.Auto,
};
