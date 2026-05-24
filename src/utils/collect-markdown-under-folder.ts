import { TFile, TFolder } from 'obsidian';

/** 递归收集文件夹下的 Markdown 文件（不枚举整个 vault）。 */
export function collectMarkdownUnderFolder(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') out.push(child);
		else if (child instanceof TFolder) out.push(...collectMarkdownUnderFolder(child));
	}
	return out;
}
