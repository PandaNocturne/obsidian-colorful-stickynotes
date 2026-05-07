/**
 * 判断便笺 Markdown 是否视为「空白」：全文空白，或仅含 YAML frontmatter 且正文为空。
 */
export function isBlankStickyMarkdown(source: string): boolean {
	const s = source.replace(/^\uFEFF/, '').trimStart();
	if (s === '') return true;
	if (!s.startsWith('---')) return false;
	const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!m) return false;
	const rest = s.slice(m[0].length).trim();
	return rest === '';
}
