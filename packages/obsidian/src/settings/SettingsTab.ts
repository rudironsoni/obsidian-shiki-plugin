import { PluginSettingTab, Setting, Platform, Notice, normalizePath } from 'obsidian';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { StringSelectModal } from 'packages/obsidian/src/settings/StringSelectModal';
import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/Constants';
import { BUNDLED_THEMES_INFO } from 'packages/obsidian/src/settings/BundledThemeInfo';

export class ShikiSettingsTab extends PluginSettingTab {
	plugin: ShikiPlugin;

	constructor(plugin: ShikiPlugin) {
		super(plugin.app, plugin);

		this.plugin = plugin;
	}

	display(): void {
		this.containerEl.empty();

		const builtInThemes = Object.fromEntries(BUNDLED_THEMES_INFO.map(theme => [theme.id, `${theme.displayName} (${theme.type})`]));
		const themes = {
			[OBSIDIAN_THEME_IDENTIFIER]: 'Obsidian built-in (both)',
			...builtInThemes,
		};

		new Setting(this.containerEl)
			.setName('Inline Syntax Highlighting')
			.setDesc('Enables syntax highlighting for inline code blocks via `{lang} code`.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.inlineHighlighting).onChange(async value => {
					this.plugin.settings.inlineHighlighting = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		new Setting(this.containerEl).setName('EC defaults').setHeading();

		new Setting(this.containerEl)
			.setName('Show line numbers')
			.setDesc('Controls whether line numbers are shown by default.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.showLineNumbers).onChange(async value => {
					this.plugin.settings.showLineNumbers = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		new Setting(this.containerEl)
			.setName('Wrap lines')
			.setDesc('Controls whether code block lines wrap by default.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.wrapLines).onChange(async value => {
					this.plugin.settings.wrapLines = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		new Setting(this.containerEl)
			.setName('Use editor font size')
			.setDesc(
				"When enabled, code blocks in Live Preview and Reading mode use the same font size as the editor. When disabled, they use Obsidian's smaller code block font size.",
			)
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.useEditorFontSize).onChange(async value => {
					this.plugin.settings.useEditorFontSize = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		new Setting(this.containerEl).setName('Theme').setHeading();

		new Setting(this.containerEl)
			.setName('Dark theme')
			.setDesc("The theme for code blocks when Obsidian's base color scheme is dark.")
			.addDropdown(dropdown => {
				dropdown.addOptions(themes);
				dropdown.setValue(this.plugin.settings.darkTheme).onChange(async value => {
					this.plugin.settings.darkTheme = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		new Setting(this.containerEl)
			.setName('Light theme')
			.setDesc("The theme for code blocks when Obsidian's base color scheme is light.")
			.addDropdown(dropdown => {
				dropdown.addOptions(themes);
				dropdown.setValue(this.plugin.settings.lightTheme).onChange(async value => {
					this.plugin.settings.lightTheme = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		const customThemeFolderSetting = new Setting(this.containerEl)
			.setName('Custom themes folder location')
			.setDesc('Folder relative to your Vault where custom JSON theme files are located.')
			.addText(textbox => {
				textbox
					.setValue(this.plugin.settings.customThemeFolder)
					.onChange(async value => {
						this.plugin.settings.customThemeFolder = value;
						await this.plugin.saveSettingsAndReloadHighlighter();
					})
					.then(textbox => {
						textbox.inputEl.addClass('shiki-custom-theme-folder');
					});
			});

		new Setting(this.containerEl)
			.setName('Prefer theme colors')
			.setDesc('When enabled the plugin will prefer theme colors over CSS variables for things like the code block background.')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.preferThemeColors).onChange(async value => {
					this.plugin.settings.preferThemeColors = value;
					await this.plugin.saveSettingsAndReloadHighlighter();
				});
			});

		new Setting(this.containerEl).setHeading().setName('Languages');

		const customLanguageFolderSetting = new Setting(this.containerEl)
			.setName('Custom languages folder location')
			.setDesc('Folder relative to your Vault where custom JSON language files are located.')
			.addText(textbox => {
				textbox
					.setValue(this.plugin.settings.customLanguageFolder)
					.onChange(async value => {
						this.plugin.settings.customLanguageFolder = value;
						await this.plugin.saveSettingsAndReloadHighlighter();
					})
					.then(textbox => {
						textbox.inputEl.addClass('shiki-custom-language-folder');
					});
			});

		new Setting(this.containerEl)
			.setName('Excluded Languages')
			.setDesc('Configure language to exclude.')
			.addButton(button => {
				button.setButtonText('Add Language Rule').onClick(async () => {
					button.setDisabled(true);
					const languages = this.plugin.highlighter.obsidianSafeLanguageNames();
					button.setDisabled(false);

					const modal = new StringSelectModal(this.plugin, languages, language => {
						this.plugin.settings.disabledLanguages.push(language);
						void this.plugin.saveSettingsAndReloadHighlighter();
						this.display();
					});
					modal.open();
				});
			});

		for (const language of this.plugin.settings.disabledLanguages) {
			new Setting(this.containerEl).setName(language).addButton(button => {
				button
					.setIcon('trash')
					.setWarning()
					.onClick(() => {
						this.plugin.settings.disabledLanguages = this.plugin.settings.disabledLanguages.filter(x => x !== language);
						void this.plugin.saveSettingsAndReloadHighlighter();
						this.display();
					});
			});
		}

		if (Platform.isDesktopApp) {
			customThemeFolderSetting.addExtraButton(button => {
				button
					.setIcon('folder-open')
					.setTooltip('Open custom themes folder')
					.onClick(async () => {
						const themeFolder = normalizePath(this.plugin.settings.customThemeFolder);
						if (await this.app.vault.adapter.exists(themeFolder)) {
							this.plugin.app.openWithDefaultApp(themeFolder);
						} else {
							new Notice(`Unable to open custom themes folder: ${themeFolder}`, 5000);
						}
					});
			});

			customLanguageFolderSetting.addExtraButton(button => {
				button
					.setIcon('folder-open')
					.setTooltip('Open custom languages folder')
					.onClick(async () => {
						const languageFolder = normalizePath(this.plugin.settings.customLanguageFolder);
						if (await this.app.vault.adapter.exists(languageFolder)) {
							this.plugin.app.openWithDefaultApp(languageFolder);
						} else {
							new Notice(`Unable to open custom languages folder: ${languageFolder}`, 5000);
						}
					});
			});
		}
	}
}
