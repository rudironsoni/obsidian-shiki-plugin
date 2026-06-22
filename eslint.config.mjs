// @ts-check

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { importX } from 'eslint-plugin-import-x';
import no_relative_import_paths from 'eslint-plugin-no-relative-import-paths';

export default defineConfig(
	{
		ignores: ['npm/', 'node_modules/', 'exampleVault/', 'automation/', 'main.js', '*.svelte'],
	},
	{
		files: ['packages/**/*.ts'],
		extends: [
			eslint.configs.recommended,
			...tseslint.configs.recommended,
			...tseslint.configs.recommendedTypeChecked,
			...tseslint.configs.stylisticTypeChecked,
		],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: true,
			},
		},
		plugins: {
			'no-relative-import-paths': no_relative_import_paths,
			import: importX,
		},
		rules: {
			'@typescript-eslint/no-explicit-any': ['error'],

			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],

			'@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
			'@typescript-eslint/restrict-template-expressions': 'off',

			'no-relative-import-paths/no-relative-import-paths': ['error', { allowSameFolder: false }],

			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/no-inferrable-types': 'off',
			'@typescript-eslint/explicit-function-return-type': ['error'],
			'@typescript-eslint/require-await': 'off',
		},
	},
);
