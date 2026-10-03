import { Menu } from 'obsidian';
import { t } from '../lang/helpers';
import { WS_TAB_GROUP_DEFAULT_ID, WS_TAB_GROUP_UNGROUPED_ID, type StickyWorkspace, type WorkspacesFile } from '../types';
import { resolveWorkspaceTabGroupId } from '../workspace-store';

export type WorkspaceMenuEntry = {
	id: string;
	name: string;
	alreadyIn?: boolean;
	disabled?: boolean;
	/** 仅勾选、仍可点击（如筛选当前项）。 */
	selected?: boolean;
};

export type WorkspaceMenuGroupSection = {
	id: string;
	name: string;
	workspaces: WorkspaceMenuEntry[];
};

/** 按「未分组 → 各 tab 分组」顺序，把工作区整理成菜单分段。 */
export function buildWorkspaceMenuGroups(
	file: WorkspacesFile,
	filter: (ws: StickyWorkspace) => boolean,
	mapEntry: (ws: StickyWorkspace) => WorkspaceMenuEntry
): WorkspaceMenuGroupSection[] {
	const tabGroups =
		file.tabGroups.length > 0
			? file.tabGroups
			: [{ id: WS_TAB_GROUP_DEFAULT_ID, name: t('WS_TAB_GROUP_DEFAULT') }];

	const sections: WorkspaceMenuGroupSection[] = [];

	const ungrouped = file.workspaces.filter(
		ws => filter(ws) && resolveWorkspaceTabGroupId(ws, tabGroups) === WS_TAB_GROUP_UNGROUPED_ID
	);
	if (ungrouped.length > 0) {
		sections.push({
			id: WS_TAB_GROUP_UNGROUPED_ID,
			name: t('DASH_AREA_UNGROUPED'),
			workspaces: ungrouped.map(mapEntry)
		});
	}

	for (const g of tabGroups) {
		const list = file.workspaces.filter(
			ws => filter(ws) && resolveWorkspaceTabGroupId(ws, tabGroups) === g.id
		);
		if (list.length === 0) continue;
		sections.push({
			id: g.id,
			name: g.name,
			workspaces: list.map(mapEntry)
		});
	}
	return sections;
}

/** 将分组工作区写入子菜单：多段时「分组 > 工作区」；仅一段时扁平列出。 */
export function appendGroupedWorkspacePicker(
	menu: Menu,
	sections: readonly WorkspaceMenuGroupSection[],
	onPick: (wsId: string) => void
): void {
	const nonEmpty = sections.filter(s => s.workspaces.length > 0);
	if (nonEmpty.length === 0) return;

	const appendEntries = (host: Menu, entries: readonly WorkspaceMenuEntry[]): void => {
		for (const ws of entries) {
			host.addItem(si => {
				si.setTitle(ws.name).setIcon('layers');
				if (ws.alreadyIn || ws.selected) si.setChecked(true);
				if (ws.disabled || ws.alreadyIn) si.setDisabled(true);
				si.onClick(() => onPick(ws.id));
			});
		}
	};

	if (nonEmpty.length === 1) {
		appendEntries(menu, nonEmpty[0]!.workspaces);
		return;
	}

	for (const section of nonEmpty) {
		menu.addItem(item => {
			item
				.setTitle(section.name)
				.setIcon(section.id === WS_TAB_GROUP_UNGROUPED_ID ? 'folder-x' : 'folder');
			const sub = item.setSubmenu();
			appendEntries(sub, section.workspaces);
		});
	}
}
