export interface FloatingBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export type StickyColorId =
	| 'default'
	| 'yellow'
	| 'pink'
	| 'mint'
	| 'blue'
	| 'lavender'
	| 'gray';

export interface SerializedStickyWindow {
	id: string;
	path: string;
	bounds?: FloatingBounds;
	collapsed?: boolean;
	color?: StickyColorId;
	yamlVisible?: boolean;
	/** Markdown 便笺的阅读 / 编辑视图（`preview` | `source`）。 */
	markdownMode?: 'preview' | 'source';
}

export interface StickyWorkspace {
	id: string;
	name: string;
	windows: SerializedStickyWindow[];
}

export interface WorkspacesFile {
	version: 1;
	workspaces: StickyWorkspace[];
	activeWorkspaceId: string;
}

export const VIEW_STICKY_NOTE_LIST = 'colorful-sticky-notes-list';

/** 便笺列表排序方式（时间均为 vault 文件 stat）。 */
export type NoteListSort = 'ctime-desc' | 'ctime-asc' | 'mtime-desc' | 'mtime-asc';

/** 便笺列表首次打开时的挂载位置。 */
export type NoteListOpenLocation = 'left-sidebar' | 'right-sidebar' | 'new-tab';

/** 便笺列表：按当前是否已打开浮动便笺窗口筛选。 */
export type NoteListFloatOpenFilter = 'all' | 'open' | 'closed';

