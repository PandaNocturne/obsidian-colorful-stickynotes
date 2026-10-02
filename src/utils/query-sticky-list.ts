import { normalizePath, type App, type TFile } from 'obsidian';
import type { NoteListArchiveFilter, NoteListSort, StickyColorId } from '../types';
import { resolveStickyArchivedForFile } from './sticky-archived-from-file';
import { resolveStickyBgColorForFile } from './sticky-bg-from-file';

/** `pinnedNorm` 为已 normalize 的路径数组，顺序即置顶顺序；不在数组中为未置顶。 */
export function pinnedSortRank(notePath: string, pinnedNorm: readonly string[]): number {
	const i = pinnedNorm.indexOf(normalizePath(notePath));
	return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export function compareStickyListFiles(a: TFile, b: TFile, sort: NoteListSort): number {
	switch (sort) {
		case 'ctime-desc': {
			const d = b.stat.ctime - a.stat.ctime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'ctime-asc': {
			const d = a.stat.ctime - b.stat.ctime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'mtime-desc': {
			const d = b.stat.mtime - a.stat.mtime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'mtime-asc': {
			const d = a.stat.mtime - b.stat.mtime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'basename-asc': {
			const c = a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
			if (c !== 0) return c;
			return a.path.localeCompare(b.path);
		}
		case 'basename-desc': {
			const c = b.basename.localeCompare(a.basename, undefined, { numeric: true, sensitivity: 'base' });
			if (c !== 0) return c;
			return a.path.localeCompare(b.path);
		}
		default:
			return a.path.localeCompare(b.path);
	}
}

export function sortStickyListFiles(
	files: TFile[],
	sort: NoteListSort,
	pinnedNorm: readonly string[],
	prioritizePath: string | null
): TFile[] {
	const next = [...files];
	next.sort((a, b) => {
		const ra = pinnedSortRank(a.path, pinnedNorm);
		const rb = pinnedSortRank(b.path, pinnedNorm);
		if (ra !== rb) return ra - rb;
		if (prioritizePath) {
			if (a.path === prioritizePath && b.path !== prioritizePath) return -1;
			if (b.path === prioritizePath && a.path !== prioritizePath) return 1;
		}
		return compareStickyListFiles(a, b, sort);
	});
	return next;
}

/** 多个关键词为「且」关系；在标题、路径与全文（cachedRead，不区分大小写子串）中匹配。 */
export async function filterStickyFilesByKeywords(
	app: App,
	files: TFile[],
	keywords: string[]
): Promise<TFile[]> {
	if (keywords.length === 0) return files;
	const flags = await Promise.all(
		files.map(async f => {
			let body = '';
			try {
				body = (await app.vault.cachedRead(f)).toLowerCase();
			} catch {
				/* 读取失败则仅以标题/路径参与匹配 */
			}
			const hay = `${f.basename}\n${f.path}\n${body}`.toLowerCase();
			return keywords.every(k => hay.includes(k));
		})
	);
	return files.filter((_, i) => flags[i]!);
}

/**
 * 生成 1-based 页码序列：含间断时用占位 `'gap'` 渲染为省略号。
 * 总页数较多时大致为「1 2 3 … 中间窗口 … 末三页」形态。
 */
export function buildPaginationEntries(totalPages: number, currentPage0: number): Array<number | 'gap'> {
	const T = totalPages;
	const c = Math.min(Math.max(currentPage0 + 1, 1), T);
	if (T <= 1) return [1];
	if (T <= 9) return Array.from({ length: T }, (_, i) => i + 1);

	const s = new Set<number>();
	for (const p of [1, 2, 3, T - 2, T - 1, T, c - 1, c, c + 1]) {
		if (p >= 1 && p <= T) s.add(p);
	}
	const arr = [...s].sort((a, b) => a - b);
	const out: Array<number | 'gap'> = [];
	for (let i = 0; i < arr.length; i++) {
		if (i > 0 && arr[i]! - arr[i - 1]! > 1) out.push('gap');
		out.push(arr[i]!);
	}
	return out;
}

/** 空数组表示不过滤；否则保留解析颜色命中任一选中色的便笺（或关系）。 */
export async function filterStickyFilesByColors(
	app: App,
	files: TFile[],
	colors: readonly StickyColorId[]
): Promise<TFile[]> {
	if (colors.length === 0) return files;
	const want = new Set(colors);
	const rows = await Promise.all(
		files.map(async f => {
			const c = (await resolveStickyBgColorForFile(app, f)) ?? 'default';
			return want.has(c) ? f : null;
		})
	);
	return rows.filter((f): f is TFile => f !== null);
}

export async function filterStickyFilesByArchiveFilter(
	app: App,
	files: TFile[],
	mode: NoteListArchiveFilter
): Promise<TFile[]> {
	if (mode === 'all') return files;
	const flags = await Promise.all(files.map(f => resolveStickyArchivedForFile(app, f)));
	if (mode === 'archived') return files.filter((_, i) => flags[i]!);
	return files.filter((_, i) => !flags[i]!);
}

/** 本地日历日 `YYYY-MM-DD`。 */
export function localDateKeyFromMs(ms: number): string {
	const d = new Date(ms);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/** 解析 `YYYY-MM-DD` 为本地 0 点时间戳；非法则返回 null。 */
export function localMsFromDateKey(dateKey: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]) - 1;
	const d = Number(m[3]);
	const dt = new Date(y, mo, d);
	if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
	return dt.getTime();
}

/** 两日（含端点）之间的全部本地日期键，按时间升序。 */
export function listLocalDateKeysInclusive(a: string, b: string): string[] {
	const ta = localMsFromDateKey(a);
	const tb = localMsFromDateKey(b);
	if (ta == null || tb == null) return [];
	const startMs = Math.min(ta, tb);
	const endMs = Math.max(ta, tb);
	const out: string[] = [];
	const cur = new Date(startMs);
	while (cur.getTime() <= endMs) {
		out.push(localDateKeyFromMs(cur.getTime()));
		cur.setDate(cur.getDate() + 1);
		if (out.length > 4000) break;
	}
	return out;
}

/** ISO 周：周一为一周起始；返回 `{ year, week }`（week 为 1–53）。 */
export function isoWeekPartsFromMs(ms: number): { year: number; week: number } {
	const d = new Date(ms);
	const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const day = utc.getUTCDay() || 7;
	utc.setUTCDate(utc.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return { year: utc.getUTCFullYear(), week };
}

export type StickyDateFilter =
	| { kind: 'year'; year: number }
	| { kind: 'month'; year: number; month0: number }
	| { kind: 'week'; year: number; week: number }
	| { kind: 'day'; dateKey: string }
	| { kind: 'days'; dateKeys: string[] };

export function stickyDateFilterKey(filter: StickyDateFilter | null): string {
	if (!filter) return '';
	switch (filter.kind) {
		case 'year':
			return `y:${filter.year}`;
		case 'month':
			return `m:${filter.year}-${filter.month0}`;
		case 'week':
			return `w:${filter.year}-W${filter.week}`;
		case 'day':
			return `d:${filter.dateKey}`;
		case 'days':
			return `ds:${[...filter.dateKeys].sort().join(',')}`;
	}
}

export function stickyDateFiltersEqual(a: StickyDateFilter | null, b: StickyDateFilter | null): boolean {
	return stickyDateFilterKey(a) === stickyDateFilterKey(b);
}

export function filterStickyFilesByDateFilter(
	files: TFile[],
	filter: StickyDateFilter | null
): TFile[] {
	if (!filter) return files;
	switch (filter.kind) {
		case 'year':
			return files.filter(f => new Date(f.stat.ctime).getFullYear() === filter.year);
		case 'month':
			return files.filter(f => {
				const d = new Date(f.stat.ctime);
				return d.getFullYear() === filter.year && d.getMonth() === filter.month0;
			});
		case 'week':
			return files.filter(f => {
				const p = isoWeekPartsFromMs(f.stat.ctime);
				return p.year === filter.year && p.week === filter.week;
			});
		case 'day':
			return files.filter(f => localDateKeyFromMs(f.stat.ctime) === filter.dateKey);
		case 'days': {
			const set = new Set(filter.dateKeys);
			if (set.size === 0) return files;
			return files.filter(f => set.has(localDateKeyFromMs(f.stat.ctime)));
		}
	}
}

/** @deprecated 使用 `filterStickyFilesByDateFilter`；保留兼容日级字符串筛选。 */
export function filterStickyFilesByCtimeDate(files: TFile[], dateKey: string | null): TFile[] {
	if (!dateKey) return files;
	return filterStickyFilesByDateFilter(files, { kind: 'day', dateKey });
}

export function ctimeDateKeysForFiles(files: readonly TFile[]): Set<string> {
	const out = new Set<string>();
	for (const f of files) out.add(localDateKeyFromMs(f.stat.ctime));
	return out;
}

/** 按创建日统计便笺数量（热力图强度）。 */
export function ctimeDateCountsForFiles(files: readonly TFile[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const f of files) {
		const key = localDateKeyFromMs(f.stat.ctime);
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return out;
}

/** 将计数映射为 0–4 热力档位（近似 GitHub contribution）。 */
export function heatmapLevelFromCount(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
	if (count <= 0 || maxCount <= 0) return 0;
	if (count === 1) return 1;
	const ratio = count / maxCount;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
}

export function injectMarkdownAfterFrontmatter(source: string, extra: string): string {
	const text = source.replace(/^\uFEFF/, '');
	const trimmed = extra.replace(/\s+$/, '');
	if (!trimmed) return text;
	const m = text.match(/^---[\t ]*\r?\n[\s\S]*?\r?\n---(?:[\t ]*)(?:\r?\n|$)/);
	if (m) {
		const rest = text.slice(m[0].length).trimStart();
		return rest ? `${m[0]}${trimmed}\n\n${rest}` : `${m[0]}${trimmed}\n`;
	}
	const body = text.trimStart();
	return body ? `${trimmed}\n\n${body}` : `${trimmed}\n`;
}
