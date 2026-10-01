import { type App, type TFile } from 'obsidian';

/** 统一为小写、带 `#` 前缀的 Obsidian 标签形式。 */
export function normalizeStickyTag(raw: string): string {
	const s = raw.trim().toLowerCase();
	if (!s) return '';
	return s.startsWith('#') ? s : `#${s}`;
}

/** 展示用：去掉前导 `#`。 */
export function displayStickyTag(tag: string): string {
	const n = normalizeStickyTag(tag);
	return n.startsWith('#') ? n.slice(1) : n;
}

function pushFrontmatterTags(out: Set<string>, value: unknown): void {
	if (typeof value === 'string') {
		for (const part of value.split(/[,\s]+/)) {
			const n = normalizeStickyTag(part);
			if (n) out.add(n);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') {
				const n = normalizeStickyTag(item);
				if (n) out.add(n);
			}
		}
	}
}

/** 从 metadataCache 读取便笺标签（正文 `#tag` + frontmatter `tags`）。 */
export function getStickyTagsForFile(app: App, file: TFile): string[] {
	const cache = app.metadataCache.getFileCache(file);
	const out = new Set<string>();
	if (cache?.tags) {
		for (const entry of cache.tags) {
			const n = normalizeStickyTag(entry.tag);
			if (n) out.add(n);
		}
	}
	pushFrontmatterTags(out, cache?.frontmatter?.tags);
	pushFrontmatterTags(out, cache?.frontmatter?.tag);
	return [...out];
}

export interface StickyTagCount {
	tag: string;
	count: number;
}

/** 统计文件集合中的标签出现次数（按便笺去重计数）。 */
export function collectStickyTagCatalog(app: App, files: readonly TFile[]): StickyTagCount[] {
	const counts = new Map<string, number>();
	for (const file of files) {
		const seen = new Set(getStickyTagsForFile(app, file));
		for (const tag of seen) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * 按标签筛选。
 * - `include` 为空：不施加「包含」条件
 * - `exclude` 命中任一则排除
 * - `logic`：`or` 命中任一包含标签；`and` 须全部包含
 */
export function filterStickyFilesByTags(
	app: App,
	files: TFile[],
	include: readonly string[],
	exclude: readonly string[],
	logic: 'and' | 'or'
): TFile[] {
	const inc = include.map(normalizeStickyTag).filter(Boolean);
	const exc = new Set(exclude.map(normalizeStickyTag).filter(Boolean));
	if (inc.length === 0 && exc.size === 0) return files;
	return files.filter(file => {
		const tags = new Set(getStickyTagsForFile(app, file));
		for (const e of exc) {
			if (tags.has(e)) return false;
		}
		if (inc.length === 0) return true;
		if (logic === 'and') return inc.every(t => tags.has(t));
		return inc.some(t => tags.has(t));
	});
}
