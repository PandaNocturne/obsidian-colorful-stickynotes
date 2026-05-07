import { moment } from 'obsidian';

/**
 * 与「核心插件 → 日记」一致：
 * - **整段字符串**作为 [Moment 格式](https://momentjs.com/docs/#/displaying/format/)（如 `YYYY/YYYY-MM-DD`）；
 * - 格式中的 `/` 表示相对「便笺文件夹」的子目录；
 * - 若仍使用旧版 `{{date:格式}}` 片段，也会替换为对应日期。
 */
export function formatStickyNoteRelativePath(template: string): string {
	const t = template.trim();
	if (t.length === 0) return 'note';
	try {
		if (/\{\{\s*date:/.test(t)) {
			return t.replace(/\{\{\s*date:([^}]+)\}\}/g, (_, inner: string) =>
				moment().format(inner.trim())
			);
		}
		return moment().format(t);
	} catch {
		return 'invalid-format';
	}
}

/** @deprecated 使用 {@link formatStickyNoteRelativePath} */
export const resolveStickyFilenameTemplate = formatStickyNoteRelativePath;
