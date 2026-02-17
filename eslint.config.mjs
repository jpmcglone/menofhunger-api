import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import eslintConfigPrettier from 'eslint-config-prettier'

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    // Ignore generated/build output everywhere.
    ignores: ['**/dist/**', '**/node_modules/**', '**/prisma/migrations/**'],
    linterOptions: {
      // This repo contains a few intentionally disabled rules; don't fail/warn on unused disables.
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: ['**/*.ts'],
    ignores: ['**/dist/**', '**/node_modules/**', '**/prisma/migrations/**'],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...(tsPlugin.configs.recommended?.rules ?? {}),
      ...(eslintConfigPrettier?.rules ?? {}),
      // Keep lint lightweight; TypeScript already provides most safety here.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ignores: ['**/dist/**', '**/node_modules/**', '**/prisma/migrations/**'],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      // Some built JS files may contain eslint-disable directives for TS rules; registering the plugin avoids
      // "Definition for rule ... was not found" if those files are ever linted.
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...(eslintConfigPrettier?.rules ?? {}),
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]

