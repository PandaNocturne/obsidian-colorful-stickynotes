import type { Plugin } from 'obsidian';
import { normalizePath } from 'obsidian';
import type { WorkspacesFile } from './types';

const FILE_NAME = 'workspaces.json';

export function defaultWorkspacesFile(): WorkspacesFile {
	const id = 'default';
	return {
		version: 1,
		activeWorkspaceId: id,
		workspaces: [{ id, name: '默认工作区', windows: [] }]
	};
}

export async function loadWorkspacesFile(plugin: Plugin): Promise<WorkspacesFile> {
	const dir = plugin.manifest.dir;
	const path = normalizePath(`${dir}/${FILE_NAME}`);
	const exists = await plugin.app.vault.adapter.exists(path);
	if (!exists) return defaultWorkspacesFile();
	try {
		const raw = await plugin.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as Partial<WorkspacesFile>;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
			return defaultWorkspacesFile();
		}
		const active =
			typeof parsed.activeWorkspaceId === 'string' && parsed.activeWorkspaceId
				? parsed.activeWorkspaceId
				: parsed.workspaces[0]?.id ?? 'default';
		return {
			version: 1,
			activeWorkspaceId: active,
			workspaces: parsed.workspaces.map(w => ({
				id: w.id,
				name: w.name,
				windows: Array.isArray(w.windows) ? w.windows : []
			}))
		};
	} catch {
		return defaultWorkspacesFile();
	}
}

export async function saveWorkspacesFile(plugin: Plugin, data: WorkspacesFile): Promise<void> {
	const dir = plugin.manifest.dir;
	const path = normalizePath(`${dir}/${FILE_NAME}`);
	await plugin.app.vault.adapter.write(path, JSON.stringify(data, null, 2));
}
