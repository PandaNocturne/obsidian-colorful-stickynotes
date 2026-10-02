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

/**
 * 写入便笺 YAML `tags`（无 `#` 前缀的数组）；空则删除 `tags`/`tag`。
 */
export async function writeStickyTagsToFile(
	app: App,
	file: TFile,
	tags: readonly string[]
): Promise<void> {
	const forFm = [
		...new Set(
			tags
				.map(normalizeStickyTag)
				.filter(Boolean)
				.map(tag => (tag.startsWith('#') ? tag.slice(1) : tag))
		)
	];
	await app.fileManager.processFrontMatter(file, fm => {
		const obj = fm as Record<string, unknown>;
		delete obj.tag;
		if (forFm.length === 0) delete obj.tags;
		else obj.tags = forFm;
	});
}

/** 从 Obsidian 全库标签索引收集（`metadataCache.getTags`）。 */
export function collectVaultTagCatalog(app: App): StickyTagCount[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const raw = (app.metadataCache as any).getTags?.() as Record<string, number> | undefined;
	if (!raw || typeof raw !== 'object') return [];
	return Object.entries(raw)
		.map(([tag, count]) => ({
			tag: normalizeStickyTag(tag),
			count: typeof count === 'number' ? count : 0
		}))
		.filter(row => row.tag)
		.sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Obsidian 层级标签树节点（`parent/child`）。 */
export interface StickyTagTreeNode {
	/** 当前段名（不含父路径）。 */
	name: string;
	/** 完整标签（带 `#`）。 */
	fullTag: string;
	count: number;
	children: StickyTagTreeNode[];
}

/** 将扁平标签列表建成 `/` 分层树；缺失的中间父节点会补齐。 */
export function buildStickyTagTree(rows: readonly StickyTagCount[]): StickyTagTreeNode[] {
	const root: StickyTagTreeNode[] = [];
	const map = new Map<string, StickyTagTreeNode>();

	const ensure = (fullPath: string, segment: string): StickyTagTreeNode => {
		const fullTag = normalizeStickyTag(fullPath);
		let node = map.get(fullTag);
		if (node) return node;
		node = { name: segment, fullTag, count: 0, children: [] };
		map.set(fullTag, node);
		const slash = fullPath.lastIndexOf('/');
		if (slash < 0) {
			root.push(node);
		} else {
			const parentPath = fullPath.slice(0, slash);
			const parentSeg = parentPath.includes('/')
				? parentPath.slice(parentPath.lastIndexOf('/') + 1)
				: parentPath;
			ensure(parentPath, parentSeg).children.push(node);
		}
		return node;
	};

	for (const row of rows) {
		const path = displayStickyTag(row.tag);
		if (!path) continue;
		const parts = path.split('/').filter(Boolean);
		if (parts.length === 0) continue;
		let acc = '';
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i]!;
			acc = acc ? `${acc}/${seg}` : seg;
			const node = ensure(acc, seg);
			if (i === parts.length - 1) node.count = row.count;
		}
	}

	const sortRec = (nodes: StickyTagTreeNode[]) => {
		nodes.sort((a, b) => a.name.localeCompare(b.name));
		for (const n of nodes) sortRec(n.children);
	};
	sortRec(root);
	return root;
}
