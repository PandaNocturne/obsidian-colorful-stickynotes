import { moment } from 'obsidian';

/** Moment 实例上我们实际用到的 API（obsidian 的 moment 类型偏宽，避免 unsafe-*）。 */
interface MomentFormatOnly {
	format(fmt: string): string;
}

/** 将 Moment 格式化为字符串（避免官方审查器对 moment 返回类型的 unsafe-* 警告）。 */
function formatWithMoment(fmt: string): string {
	const m = moment() as unknown as MomentFormatOnly;
	return m.format(fmt);
}

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
			return t.replace(/\{\{\s*date:([^}]+)\}\}/g, (_match: string, inner: string) =>
				formatWithMoment(inner.trim())
			);
		}
		return formatWithMoment(t);
	} catch {
		return 'invalid-format';
	}
}

/** @deprecated 使用 {@link formatStickyNoteRelativePath} */
export const resolveStickyFilenameTemplate = formatStickyNoteRelativePath;
