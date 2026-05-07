/** 去掉首段 YAML 后截取一段 Markdown，供列表内 `MarkdownRenderer.render` 使用（控制体积）。 */
export function previewMarkdownSlice(source: string, maxChars: number): string {
	let s = source.replace(/^\uFEFF/, '');
	const fm = s.match(/^---[\t ]*\r?\n[\s\S]*?\r?\n---(?:[\t ]*)(?:\r?\n|$)/);
	if (fm) s = s.slice(fm[0].length);
	s = s.trimStart();
	if (s.length <= maxChars) return s;
	return `${s.slice(0, maxChars)}\n\n*…*`;
}
