/** 仪表盘 / 管理面板：工作区拖拽 MIME（勿与便签 markdown link 的 text/plain 混用）。 */
export const WORKSPACE_DND_MIME = 'text/x-csn-workspace-id';
/** 工作区分组（tab group）拖拽 MIME。 */
export const WORKSPACE_GROUP_DND_MIME = 'text/x-csn-workspace-group-id';
/** 便签路径列表 JSON（string[]），拖到工作区树以加入成员。 */
export const STICKY_PATHS_DND_MIME = 'text/x-csn-sticky-paths';

export function dragEventHasMime(e: DragEvent, mime: string): boolean {
	const types = e.dataTransfer?.types;
	if (!types) return false;
	/* Electron / 旧 Chromium 可能是 DOMStringList（含 contains），新版可能是只读 string[]。 */
	const list = types as DataTransfer['types'] & { contains?: (type: string) => boolean };
	if (typeof list.contains === 'function') return list.contains(mime);
	for (let i = 0; i < list.length; i++) {
		if (list[i] === mime) return true;
	}
	return false;
}

export function setStickyPathsDragData(dt: DataTransfer, paths: readonly string[]): void {
	dt.setData(STICKY_PATHS_DND_MIME, JSON.stringify([...paths]));
}

export function readStickyPathsDragData(dt: DataTransfer | null): string[] {
	if (!dt) return [];
	const raw = dt.getData(STICKY_PATHS_DND_MIME);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
	} catch {
		return [];
	}
}
