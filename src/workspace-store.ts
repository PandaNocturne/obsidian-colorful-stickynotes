import type { Plugin } from 'obsidian';
import { normalizePath } from 'obsidian';

/** 便笺工作区快照 JSON 在库内的路径（与 `loadWorkspacesFile` / `saveWorkspacesFile` 一致）。 */
export function stickyWorkspacesJsonVaultPath(plugin: Plugin): string {
	return normalizePath(`${plugin.manifest.dir}/${plugin.manifest.id}-workspaces.json`);
}
import { t } from './lang/helpers';
import {
	WS_TAB_GROUP_DEFAULT_ID,
	type StickyWorkspace,
	type StickyWorkspaceTabGroup,
	type WorkspacesFile
} from './types';

/** 新便笺工作区条目的 id（与创建/复制/空白区逻辑一致）。 */
export function newStickyWorkspaceId(): string {
	return `ws_${Date.now().toString(36)}`;
}

/** 新顶部分组标签 id。 */
export function newStickyWorkspaceTabGroupId(): string {
	return `wsg_${Date.now().toString(36)}`;
}

export function defaultStickyWorkspaceTabGroup(): StickyWorkspaceTabGroup {
	return {
		id: WS_TAB_GROUP_DEFAULT_ID,
		name: t('WS_TAB_GROUP_DEFAULT')
	};
}

/** 工作区实际归属的分组 id（兼容旧数据无 `tabGroupId`）。 */
export function resolveWorkspaceTabGroupId(
	ws: Pick<StickyWorkspace, 'tabGroupId'>,
	tabGroups: readonly StickyWorkspaceTabGroup[]
): string {
	const raw = ws.tabGroupId;
	if (typeof raw === 'string' && raw.length > 0 && tabGroups.some(g => g.id === raw)) {
		return raw;
	}
	const fallback = tabGroups.find(g => g.id === WS_TAB_GROUP_DEFAULT_ID)?.id ?? tabGroups[0]?.id;
	return fallback ?? WS_TAB_GROUP_DEFAULT_ID;
}

function normalizeTabGroups(raw: unknown): StickyWorkspaceTabGroup[] {
	const fallback = [defaultStickyWorkspaceTabGroup()];
	if (!Array.isArray(raw)) return fallback;
	const groups: StickyWorkspaceTabGroup[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const id = (item as { id?: unknown }).id;
		const name = (item as { name?: unknown }).name;
		if (typeof id !== 'string' || id.length === 0) continue;
		if (typeof name !== 'string' || !name.trim()) continue;
		groups.push({ id, name: name.trim() });
	}
	if (groups.length === 0) return fallback;
	if (!groups.some(g => g.id === WS_TAB_GROUP_DEFAULT_ID)) {
		groups.unshift(defaultStickyWorkspaceTabGroup());
	}
	return groups;
}

function workspacesPrefixedPath(plugin: Plugin): string {
	return normalizePath(`${plugin.manifest.dir}/${plugin.manifest.id}-workspaces.json`);
}

function workspacesLegacyPath(plugin: Plugin): string {
	return normalizePath(`${plugin.manifest.dir}/workspaces.json`);
}

async function migrateLegacyWorkspacesFile(plugin: Plugin): Promise<void> {
	const next = workspacesPrefixedPath(plugin);
	const prev = workspacesLegacyPath(plugin);
	if (await plugin.app.vault.adapter.exists(next)) return;
	if (!(await plugin.app.vault.adapter.exists(prev))) return;
	try {
		const rawText = await plugin.app.vault.adapter.read(prev);
		await plugin.app.vault.adapter.write(next, rawText);
		await plugin.app.vault.adapter.remove(prev);
	} catch {
		/* 迁移失败则保留旧文件 */
	}
}

export function defaultWorkspacesFile(): WorkspacesFile {
	const id = newStickyWorkspaceId();
	const now = Date.now();
	const tabGroups = [defaultStickyWorkspaceTabGroup()];
	return {
		version: 1,
		activeWorkspaceId: id,
		tabGroups,
		workspaces: [
			{
				id,
				name: t('WS_NEW_WORKSPACE_AUTO_NAME', { n: 1 }),
				tabGroupId: WS_TAB_GROUP_DEFAULT_ID,
				windows: [],
				updatedAt: now
			}
		],
		trash: []
	};
}

export async function loadWorkspacesFile(plugin: Plugin): Promise<WorkspacesFile> {
	await migrateLegacyWorkspacesFile(plugin);
	const path = workspacesPrefixedPath(plugin);
	const exists = await plugin.app.vault.adapter.exists(path);
	if (!exists) return defaultWorkspacesFile();
	try {
		const raw = await plugin.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as Partial<WorkspacesFile>;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
			return defaultWorkspacesFile();
		}
		const ids = new Set(
			parsed.workspaces.map(w => w.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
		);
		const rawActive = parsed.activeWorkspaceId;
		let active: string | null;
		if (rawActive === null) {
			active = null;
		} else if (typeof rawActive === 'string' && rawActive.length > 0 && ids.has(rawActive)) {
			active = rawActive;
		} else if (typeof rawActive === 'string' && rawActive.length > 0) {
			/* 磁盘上活动 id 已不在列表中（例如手工编辑或异常），不强行选中第一项 */
			active = null;
		} else {
			const first = parsed.workspaces.find(
				w => typeof w.id === 'string' && w.id.length > 0
			);
			active = first?.id ?? null;
		}
		const tabGroups = normalizeTabGroups((parsed as { tabGroups?: unknown }).tabGroups);
		const mapWorkspace = (w: (typeof parsed.workspaces)[number]): StickyWorkspace => {
			const rawRemark = (w as { remark?: unknown }).remark;
			const remark = typeof rawRemark === 'string' ? rawRemark : undefined;
			const rawTabGroupId = (w as { tabGroupId?: unknown }).tabGroupId;
			const tabGroupId =
				typeof rawTabGroupId === 'string' && rawTabGroupId.length > 0 ? rawTabGroupId : undefined;
			return {
				id: w.id,
				name: w.name,
				...(remark !== undefined ? { remark } : {}),
				...(tabGroupId !== undefined ? { tabGroupId } : {}),
				windows: Array.isArray(w.windows) ? w.windows : [],
				updatedAt:
					typeof (w as { updatedAt?: unknown }).updatedAt === 'number' &&
					Number.isFinite((w as { updatedAt: number }).updatedAt)
						? (w as { updatedAt: number }).updatedAt
						: undefined
			};
		};
		const rawTrash = (parsed as { trash?: unknown }).trash;
		const trash = Array.isArray(rawTrash)
			? (rawTrash as typeof parsed.workspaces).map(mapWorkspace)
			: [];
		return {
			version: 1,
			activeWorkspaceId: active,
			tabGroups,
			workspaces: parsed.workspaces.map(mapWorkspace),
			trash
		};
	} catch {
		return defaultWorkspacesFile();
	}
}

export async function saveWorkspacesFile(plugin: Plugin, data: WorkspacesFile): Promise<void> {
	await migrateLegacyWorkspacesFile(plugin);
	const path = workspacesPrefixedPath(plugin);
	await plugin.app.vault.adapter.write(path, JSON.stringify(data, null, 2));
}
