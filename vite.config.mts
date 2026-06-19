import path from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig, type UserConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import banner from 'vite-plugin-banner';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { getBuildBanner } from '@lemons_dev/lemons-obsidian-plugin-automation';
import manifest from './manifest.json' with { type: 'json' };

const polyfilledNodeBuiltins = new Set(['fs', 'path', 'url']);
const externalNodeBuiltins = builtinModules.filter(moduleName => !polyfilledNodeBuiltins.has(moduleName.replace(/^node:/, '')));

const entryFile = 'packages/obsidian/src/main.ts';
const modernMonacoEntryFile = 'packages/obsidian/src/modern-monaco-entry.ts';

function getBuildEntryFile(buildEntry: string): string {
	if (buildEntry === 'modern-monaco') return modernMonacoEntryFile;
	return entryFile;
}

export default defineConfig(({ mode }) => {
	const prod = mode === 'production';
	const outDir = prod ? 'dist/' : `exampleVault/.obsidian/plugins/${manifest.id}/`;
	const buildEntry =
		process.env.SHIKI_BUILD_ENTRY === 'modern-monaco' ? 'modern-monaco' : 'main';

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
			nodePolyfills({
				include: ['fs', 'path', 'url'],
				protocolImports: true,
			}),
			banner({
				outDir,
				content: getBuildBanner(prod ? 'Release Build' : 'Dev Build', version => version),
			}),
			...(buildEntry === 'main'
				? [
						viteStaticCopy({
							targets: [{ src: 'manifest.json', dest: outDir }],
						}),
					]
				: []),
		],
		resolve: {
			alias: {
				packages: path.resolve(__dirname, './packages'),
				'shiki-wasm': path.resolve(__dirname, './node_modules/modern-monaco/dist/shiki-wasm.mjs'),
			},
		},
		build: {
			lib: {
				entry: path.resolve(__dirname, getBuildEntryFile(buildEntry)),
				name: buildEntry,
				fileName: () => `${buildEntry}.js`,
				formats: ['cjs'],
			},
			minify: prod,
			target: 'es2022',
			sourcemap: prod ? false : 'inline',
			cssCodeSplit: false,
			emptyOutDir: false,
			outDir: '',
			rolldownOptions: {
				output: {
					dir: outDir,
					entryFileNames: `${buildEntry}.js`,
					assetFileNames: 'styles.css',
					codeSplitting: false,
				},
				external,
			},
		},
	} as UserConfig;
});
