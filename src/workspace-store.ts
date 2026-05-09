import type { Plugin } from 'obsidian';
import { normalizePath } from 'obsidian';

/** 便笺工作区快照 JSON 在库内的路径（与 `loadWorkspacesFile` / `saveWorkspacesFile` 一致）。 */
export function stickyWorkspacesJsonVaultPath(plugin: Plugin): string {
	return normalizePath(`${plugin.manifest.dir}/${plugin.manifest.id}-workspaces.json`);
}
import { t } from './lang/helpers';
import type { WorkspacesFile } from './types';

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
	const id = 'default';
	const now = Date.now();
	return {
		version: 1,
		activeWorkspaceId: id,
		workspaces: [{ id, name: t('DEFAULT_WORKSPACE_NAME'), windows: [], updatedAt: now }]
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
			active = parsed.workspaces[0]?.id ?? 'default';
		}
		return {
			version: 1,
			activeWorkspaceId: active,
			workspaces: parsed.workspaces.map(w => {
				const rawRemark = (w as { remark?: unknown }).remark;
				const remark =
					typeof rawRemark === 'string' ? rawRemark : undefined;
				return {
					id: w.id,
					name: w.name,
					...(remark !== undefined ? { remark } : {}),
					windows: Array.isArray(w.windows) ? w.windows : [],
					updatedAt:
						typeof (w as { updatedAt?: unknown }).updatedAt === 'number' &&
						Number.isFinite((w as { updatedAt: number }).updatedAt)
							? (w as { updatedAt: number }).updatedAt
							: undefined
				};
			})
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
