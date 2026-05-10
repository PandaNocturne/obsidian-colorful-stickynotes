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

/** 拖动时对齐吸附的触发方式（与「吸附后绑定」共用阈值与邻窗检测）。 */
export type StickyAssistAlignSnapMode = 'none' | 'auto' | 'ctrl';

/** 绑定组内归一化网格索引下的多格占位（含边界）。单格时勿存。 */
export interface StickyGridSpan {
	colMin: number;
	colMax: number;
	rowMin: number;
	rowMax: number;
}

export interface SerializedStickyWindow {
	id: string;
	path: string;
	/** 便笺文件 frontmatter: `colorful-sticky-id`，用于改名后恢复定位。 */
	stickyId?: string;
	bounds?: FloatingBounds;
	collapsed?: boolean;
	/** 窗口是否处于隐藏状态。 */
	hidden?: boolean;
	/** 窗口是否处于拉伸状态（全高）。 */
	stretched?: boolean;
	/** 吸附绑定的其它窗口 id（无向关系，序列化为邻接表）。 */
	bindings?: string[];
	/** 跨多格便笺：归一化网格列/行范围；与拓扑变化不符时布局会丢弃。 */
	gridSpan?: StickyGridSpan;
	color?: StickyColorId;
	yamlVisible?: boolean;
	/** Markdown 便笺的阅读 / 编辑视图（`preview` | `source`）。 */
	markdownMode?: 'preview' | 'source';
}

export interface StickyWorkspace {
	id: string;
	name: string;
	/** 工作区备注（可选），显示在工作区面板卡片上。 */
	remark?: string;
	windows: SerializedStickyWindow[];
	/** 最近一次写入该便笺工作区快照的时间（毫秒时间戳）。 */
	updatedAt?: number;
}

export interface WorkspacesFile {
	version: 1;
	workspaces: StickyWorkspace[];
	/** 从面板删除的工作区快照，可还原或彻底删除（持久化在 `*-workspaces.json` 的 `trash` 字段）。 */
	trash: StickyWorkspace[];
	/** 当前选中的便笺工作区；为 null 表示未选中（删除当前区后不应默认落到其它区，以免把当前浮动布局误写入该区快照）。 */
	activeWorkspaceId: string | null;
}

export const VIEW_STICKY_NOTE_LIST = 'colorful-sticky-notes-list';

/** 便笺列表排序方式（时间均为 vault 文件 stat；按文件名称时为 `TFile.basename`，含扩展名，`localeCompare` 带 numeric）。 */
export type NoteListSort =
	| 'ctime-desc'
	| 'ctime-asc'
	| 'mtime-desc'
	| 'mtime-asc'
	| 'basename-asc'
	| 'basename-desc';

/** 便笺列表首次打开时的挂载位置。 */
export type NoteListOpenLocation = 'left-sidebar' | 'right-sidebar' | 'new-tab';

/** 便笺头部「+」从当前窗口旁新建时，优先出现在源窗口的哪一侧（空间不足时自动换到另一侧）。 */
export type HeaderNewStickyAdjacentSide = 'left' | 'right';

/** 便笺列表：按当前是否已打开浮动便笺窗口筛选。 */
export type NoteListFloatOpenFilter = 'all' | 'open' | 'closed';

/** 便笺列表：按 frontmatter `colorful-sticky-archived` 筛选。 */
export type NoteListArchiveFilter = 'all' | 'unarchived' | 'archived';

