/** 仪表盘 / 管理面板：工作区拖拽 MIME（勿与便签 markdown link 的 text/plain 混用）。 */
export const WORKSPACE_DND_MIME = 'text/x-csn-workspace-id';
/** 便签路径列表 JSON（string[]），拖到工作区树以加入成员。 */
export const STICKY_PATHS_DND_MIME = 'text/x-csn-sticky-paths';

export function dragEventHasMime(e: DragEvent, mime: string): boolean {
	return e.dataTransfer?.types.includes(mime) ?? false;
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
