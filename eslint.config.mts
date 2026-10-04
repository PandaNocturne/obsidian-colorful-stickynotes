import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'eslint.config.mts',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			/* CSS 尺寸占位符（如 160px）会被误判为 UI 文案 */
			'obsidianmd/ui/sentence-case': 'off',
			/* 声明式 settings API 需较大重构，暂保留命令式 Setting */
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		".history",
		".tmp",
		"tmp",
		"esbuild.config.mjs",
		"eslint.config.js",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
