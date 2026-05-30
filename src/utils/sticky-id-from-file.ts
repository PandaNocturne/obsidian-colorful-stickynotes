import { parseYaml, type App, type TFile } from 'obsidian';

export const FM_STICKY_ID_KEY = 'colorful-sticky-id';

/** 仅读元数据缓存（同步）。 */
export function getStickyIdFromMetadataCache(app: App, file: TFile): string | null {
	const raw: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[FM_STICKY_ID_KEY];
	return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** 解析 Markdown 源码首段 YAML 中的 `colorful-sticky-id`。 */
export function parseStickyIdFromMarkdownSource(source: string): string | null {
	const text = source.replace(/^\uFEFF/, '');
	const m = text.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*)(?:\r?\n|$)/);
	if (!m?.[1]) return null;
	try {
		const fm = parseYaml(m[1]) as unknown;
		if (!fm || typeof fm !== 'object') return null;
		const v = (fm as Record<string, unknown>)[FM_STICKY_ID_KEY];
		return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
	} catch {
		return null;
	}
}

/** 元数据优先，否则解析正文首段 YAML。 */
export async function resolveStickyIdForFile(app: App, file: TFile): Promise<string | null> {
	const fromCache = getStickyIdFromMetadataCache(app, file);
	if (fromCache) return fromCache;
	if (file.extension !== 'md') return null;
	try {
		const text = await app.vault.cachedRead(file);
		return parseStickyIdFromMarkdownSource(text);
	} catch {
		return null;
	}
}
