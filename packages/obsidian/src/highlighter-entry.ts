import { CodeHighlighter } from 'packages/obsidian/src/Highlighter';
import { CodeBlock } from 'packages/obsidian/src/CodeBlock';
import { InlineCodeBlock } from 'packages/obsidian/src/InlineCodeBlock';
import { createCm6Plugin } from 'packages/obsidian/src/codemirror/Cm6_ViewPlugin';
import { filterHighlightAllPlugin } from 'packages/obsidian/src/PrismPlugin';
import { loadCustomThemeOptions } from 'packages/obsidian/src/settings/CustomThemeOptions';
import { ShikiSettingsTab } from 'packages/obsidian/src/settings/SettingsTab';

export { CodeBlock, CodeHighlighter, createCm6Plugin, filterHighlightAllPlugin, InlineCodeBlock, loadCustomThemeOptions, ShikiSettingsTab };

export interface HighlighterEntryModule {
	CodeBlock: typeof CodeBlock;
	CodeHighlighter: typeof CodeHighlighter;
	createCm6Plugin: typeof createCm6Plugin;
	filterHighlightAllPlugin: typeof filterHighlightAllPlugin;
	InlineCodeBlock: typeof InlineCodeBlock;
	loadCustomThemeOptions: typeof loadCustomThemeOptions;
	ShikiSettingsTab: typeof ShikiSettingsTab;
}
