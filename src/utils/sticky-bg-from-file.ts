import { parseYaml, type App, type TFile } from 'obsidian';
import type { StickyColorId } from '../types';

const FM_COLOR_KEY = 'colorful-sticky-bg';

const STICKY_BG_ALLOWED: readonly StickyColorId[] = [
	'default',
	'yellow',
	'pink',
	'mint',
	'blue',
	'lavender',
	'gray'
];

function normalizeStickyBgValue(raw: unknown): StickyColorId | null {
	if (typeof raw !== 'string' || !raw) return null;
	return STICKY_BG_ALLOWED.includes(raw as StickyColorId) ? (raw as StickyColorId) : null;
}

/** 仅读元数据缓存（同步），用于刚打开文件后立刻对齐颜色等场景。 */
export function getStickyBgColorFromMetadataCache(app: App, file: TFile): StickyColorId | null {
	const raw: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[FM_COLOR_KEY];
	return normalizeStickyBgValue(raw);
}

/** 解析 Markdown 源码首段 YAML 中的 `colorful-sticky-bg`（不落盘、不读 vault）。 */
export function parseStickyBgColorFromMarkdownSource(source: string): StickyColorId | null {
	const text = source.replace(/^\uFEFF/, '');
	const m = text.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*)(?:\r?\n|$)/);
	if (!m?.[1]) return null;
	try {
		const fm = parseYaml(m[1]) as unknown;
		if (!fm || typeof fm !== 'object') return null;
		return normalizeStickyBgValue((fm as Record<string, unknown>)[FM_COLOR_KEY]);
	} catch {
		return null;
	}
}

async function readStickyColorFromVaultCachedRead(app: App, file: TFile): Promise<StickyColorId | null> {
	try {
		const text = await app.vault.cachedRead(file);
		return parseStickyBgColorFromMarkdownSource(text);
	} catch {
		return null;
	}
}

/** 与浮动便笺一致：元数据优先，否则解析正文首段 YAML；无 `colorful-sticky-bg` 时为 `null`。 */
export async function resolveStickyBgColorForFile(app: App, file: TFile): Promise<StickyColorId | null> {
	const fromCache = getStickyBgColorFromMetadataCache(app, file);
	if (fromCache) return fromCache;
	return readStickyColorFromVaultCachedRead(app, file);
}
