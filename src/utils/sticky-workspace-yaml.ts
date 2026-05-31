import { parseYaml, type App, type TFile } from 'obsidian';

/** 便笺所属活动工作区（列表，可多项；值为工作区 id）。 */
export const FM_STICKY_WORKSPACES_KEY = 'colorful-sticky-workspaces';

/** 便笺所属已归档（回收站）工作区（列表；值为工作区 id）。 */
export const FM_STICKY_ARCHIVED_WORKSPACES_KEY = 'colorful-sticky-archived-workspaces';

/** 将 frontmatter 中的工作区列表规范为去重后的 id 数组。 */
export function normalizeStickyWorkspaceIdList(raw: unknown): string[] {
	if (raw == null) return [];
	const items: unknown[] = Array.isArray(raw) ? raw : [raw];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (typeof item !== 'string') continue;
		const id = item.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function parseWorkspaceListFromMarkdownSource(source: string, key: string): string[] | null {
	const text = source.replace(/^\uFEFF/, '');
	const m = text.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*)(?:\r?\n|$)/);
	if (!m?.[1]) return null;
	try {
		const fm = parseYaml(m[1]) as unknown;
		if (!fm || typeof fm !== 'object') return null;
		const obj = fm as Record<string, unknown>;
		if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
		return normalizeStickyWorkspaceIdList(obj[key]);
	} catch {
		return null;
	}
}

async function readWorkspaceListFromVaultCachedRead(
	app: App,
	file: TFile,
	key: string
): Promise<string[] | null> {
	try {
		const text = await app.vault.cachedRead(file);
		return parseWorkspaceListFromMarkdownSource(text, key);
	} catch {
		return null;
	}
}

function resolveWorkspaceListFromMetadata(
	app: App,
	file: TFile,
	key: string
): string[] | null {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	if (!fm || !Object.prototype.hasOwnProperty.call(fm, key)) return null;
	return normalizeStickyWorkspaceIdList(fm[key]);
}

async function resolveWorkspaceListForFile(app: App, file: TFile, key: string): Promise<string[]> {
	const fromCache = resolveWorkspaceListFromMetadata(app, file, key);
	if (fromCache !== null) return fromCache;
	const fromBody = await readWorkspaceListFromVaultCachedRead(app, file, key);
	return fromBody ?? [];
}

/** 解析活动工作区 id 列表；无键时为空数组。 */
export async function resolveStickyWorkspacesForFile(app: App, file: TFile): Promise<string[]> {
	return resolveWorkspaceListForFile(app, file, FM_STICKY_WORKSPACES_KEY);
}

/** 解析已归档工作区 id 列表；无键时为空数组。 */
export async function resolveStickyArchivedWorkspacesForFile(app: App, file: TFile): Promise<string[]> {
	return resolveWorkspaceListForFile(app, file, FM_STICKY_ARCHIVED_WORKSPACES_KEY);
}
