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
