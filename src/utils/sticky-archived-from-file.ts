import { parseYaml, type App, type TFile } from 'obsidian';

const FM_ARCHIVED_KEY = 'colorful-sticky-archived';

export function normalizeStickyArchivedValue(raw: unknown): boolean {
	return raw === true;
}

/** 解析正文首段 YAML 中的 `colorful-sticky-archived`；无 YAML 或键缺失时为 `null`。 */
export function parseStickyArchivedFromMarkdownSource(source: string): boolean | null {
	const text = source.replace(/^\uFEFF/, '');
	const m = text.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*)(?:\r?\n|$)/);
	if (!m?.[1]) return null;
	try {
		const fm = parseYaml(m[1]) as unknown;
		if (!fm || typeof fm !== 'object') return null;
		const obj = fm as Record<string, unknown>;
		if (!Object.prototype.hasOwnProperty.call(obj, FM_ARCHIVED_KEY)) return null;
		return normalizeStickyArchivedValue(obj[FM_ARCHIVED_KEY]);
	} catch {
		return null;
	}
}

async function readStickyArchivedFromVaultCachedRead(app: App, file: TFile): Promise<boolean | null> {
	try {
		const text = await app.vault.cachedRead(file);
		return parseStickyArchivedFromMarkdownSource(text);
	} catch {
		return null;
	}
}

/**
 * 与列表筛选一致：元数据缓存中若已存在该键则用之；否则解析首段 YAML；
 * 仍无键则视为未归档。
 */
export async function resolveStickyArchivedForFile(app: App, file: TFile): Promise<boolean> {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	if (fm && Object.prototype.hasOwnProperty.call(fm, FM_ARCHIVED_KEY)) {
		return normalizeStickyArchivedValue(fm[FM_ARCHIVED_KEY]);
	}
	const fromBody = await readStickyArchivedFromVaultCachedRead(app, file);
	if (fromBody !== null) return fromBody;
	return false;
}
