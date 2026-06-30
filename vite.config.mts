import path from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig, type UserConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import banner from 'vite-plugin-banner';
import { getBuildBanner } from '@lemons_dev/lemons-obsidian-plugin-automation';
import manifest from './manifest.json' with { type: 'json' };

const externalNodeBuiltins = builtinModules;

const entryFile = 'packages/obsidian/src/main.ts';

function getBuildEntryFile(): string {
	return entryFile;
}

export default defineConfig(({ mode }) => {
	const prod = mode === 'production';
	const outDir = prod ? 'dist/' : `exampleVault/.obsidian/plugins/${manifest.id}/`;
	const buildEntry = 'main';

	const external = [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...externalNodeBuiltins,
	];

	return {
		plugins: [
			banner({
				outDir,
				content: getBuildBanner(prod ? 'Release Build' : 'Dev Build', version => version),
			}),
			...(true
				? [
						viteStaticCopy({
							targets: [{ src: 'manifest.json', dest: '' }],
						}),
					]
				: []),
		],
		resolve: {
			alias: {
				packages: path.resolve(__dirname, './packages'),
			},
		},
		build: {
			lib: {
				entry: path.resolve(__dirname, getBuildEntryFile()),
				name: 'main',
				fileName: () => `${buildEntry}.js`,
				formats: ['cjs'],
			},
			minify: prod,
			target: 'es2022',
			sourcemap: prod ? false : 'inline',
			cssCodeSplit: false,
			emptyOutDir: false,
			outDir,
			rolldownOptions: {
				checks: {
					pluginTimings: false,
				},
				output: {
					dir: outDir,
					entryFileNames: 'main.js',
					assetFileNames: 'styles.css',
					codeSplitting: false,
					exports: 'named',
				},
				external,
			},
		},
	} as UserConfig;
});
