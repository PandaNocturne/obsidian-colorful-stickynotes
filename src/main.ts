import { Notice, Plugin, TFile } from 'obsidian';
import { ColorfulStickyNotesSettingTab, DEFAULT_SETTINGS, type ColorfulStickyNotesSettings } from './settings';
import { WorkspacePanelModal } from './modals/WorkspacePanelModal';
import { StickyNoteManager } from './sticky/StickyNoteManager';
import { StickyNoteListView } from './views/StickyNoteListView';
import { VIEW_STICKY_NOTE_LIST, type NoteListOpenLocation, type NoteListSort, type StickyColorId } from './types';

const VALID_NEW_STICKY_BG: readonly StickyColorId[] = [
	'default',
	'yellow',
	'pink',
	'mint',
	'blue',
	'lavender',
	'gray'
];

const VALID_NOTE_LIST_SORT: readonly NoteListSort[] = [
	'ctime-desc',
	'ctime-asc',
	'mtime-desc',
	'mtime-asc'
];

const VALID_NOTE_LIST_OPEN_LOCATION: readonly NoteListOpenLocation[] = [
	'left-sidebar',
	'right-sidebar',
	'new-tab'
];

export default class ColorfulStickyNotesPlugin extends Plugin {
	settings!: ColorfulStickyNotesSettings;
	stickies!: StickyNoteManager;

	/** 便笺列表排序：插件新建的便笺路径临时置顶，`StickyNoteListView` 渲染后清空 */
	listPrioritizeStickyPath: string | null = null;

	/** 写入 frontmatter 等触发的 `modify`：跳过防抖列表刷新，由新建流程末尾主动 `refreshStickyListIfOpen` 一次，避免连刷卡顿 */
	muteStickyListModifyPaths: Set<string> = new Set();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.stickies = new StickyNoteManager(this, this.app);
		await this.stickies.init();

		this.registerView(VIEW_STICKY_NOTE_LIST, leaf => new StickyNoteListView(leaf, this));

		this.addRibbonIcon('square-pen', '打开便笺', () => {
			void this.restoreStickySession();
		});

		this.addRibbonIcon('layout-list', '便笺列表', () => {
			void this.openNoteListView();
		});

		this.addRibbonIcon('layout', '便笺工作区', () => {
			this.openWorkspacePanel();
		});

		this.addCommand({
			id: 'open-sticky-note-windows',
			name: '打开便笺窗口（恢复上次会话）',
			callback: () => {
				void this.restoreStickySession();
			}
		});

		this.addCommand({
			id: 'open-sticky-note-list',
			name: '打开便笺列表',
			callback: () => {
				void this.openNoteListView();
			}
		});

		this.addCommand({
			id: 'create-new-sticky-note',
			name: '新建便笺',
			callback: () => {
				void this.stickies.addStickyWindow();
			}
		});

		this.addCommand({
			id: 'open-sticky-workspace-panel',
			name: '打开便笺工作区',
			callback: () => {
				this.openWorkspacePanel();
			}
		});

		this.addSettingTab(new ColorfulStickyNotesSettingTab(this.app, this));

		if (this.settings.restoreStickySessionOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				const ms = Math.max(0, this.settings.restoreStickySessionDelaySec) * 1000;
				const id = window.setTimeout(() => {
					void this.restoreStickySession();
				}, ms);
				this.register(() => window.clearTimeout(id));
			});
		}
	}

	onunload(): void {
		/* 勿 detach 便笺列表：重载插件时不应关闭用户已固定在侧栏的叶视图。 */
		this.stickies?.onunload();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as ColorfulStickyNotesSettings;
		const st = this.settings as unknown as Record<string, unknown>;
		delete st.bottomBarCommands;
		delete st.defaultPositionMode;
		delete st.defaultPositionX;
		delete st.defaultPositionY;
		const z = this.settings.viewContentZoom;
		if (typeof z !== 'number' || !Number.isFinite(z)) {
			this.settings.viewContentZoom = DEFAULT_SETTINGS.viewContentZoom;
		} else {
			this.settings.viewContentZoom = Math.max(0.5, Math.min(1, z));
		}
		const layout = this.settings.noteListLayout;
		if (layout !== 'column' && layout !== 'grid') {
			this.settings.noteListLayout = DEFAULT_SETTINGS.noteListLayout;
		}
		const nls = this.settings.noteListSort;
		if (typeof nls !== 'string' || !VALID_NOTE_LIST_SORT.includes(nls as NoteListSort)) {
			this.settings.noteListSort = DEFAULT_SETTINGS.noteListSort;
		}

		const nlo = this.settings.noteListOpenLocation;
		if (
			typeof nlo !== 'string' ||
			!VALID_NOTE_LIST_OPEN_LOCATION.includes(nlo as NoteListOpenLocation)
		) {
			this.settings.noteListOpenLocation = DEFAULT_SETTINGS.noteListOpenLocation;
		}
		const delaySec = this.settings.restoreStickySessionDelaySec;
		if (typeof delaySec !== 'number' || !Number.isFinite(delaySec)) {
			this.settings.restoreStickySessionDelaySec = DEFAULT_SETTINGS.restoreStickySessionDelaySec;
		} else {
			this.settings.restoreStickySessionDelaySec = Math.max(
				0,
				Math.min(10, Math.round(delaySec))
			);
		}
		if (typeof st.notifyBlankStickyTrashOnClose === 'boolean') {
			this.settings.confirmBlankStickyTrashOnClose = st.notifyBlankStickyTrashOnClose;
			delete st.notifyBlankStickyTrashOnClose;
		}
		if (typeof this.settings.confirmBlankStickyTrashOnClose !== 'boolean') {
			this.settings.confirmBlankStickyTrashOnClose = DEFAULT_SETTINGS.confirmBlankStickyTrashOnClose;
		}

		let dw = this.settings.defaultNewStickyWidth;
		if (typeof dw !== 'number' || !Number.isFinite(dw)) {
			dw = DEFAULT_SETTINGS.defaultNewStickyWidth;
		}
		this.settings.defaultNewStickyWidth = Math.max(200, Math.min(1600, Math.round(dw)));

		let dh = this.settings.defaultNewStickyHeight;
		if (typeof dh !== 'number' || !Number.isFinite(dh)) {
			dh = DEFAULT_SETTINGS.defaultNewStickyHeight;
		}
		this.settings.defaultNewStickyHeight = Math.max(200, Math.min(1200, Math.round(dh)));

		const dbg = this.settings.defaultNewStickyBackground;
		if (typeof dbg !== 'string' || !VALID_NEW_STICKY_BG.includes(dbg as StickyColorId)) {
			this.settings.defaultNewStickyBackground = DEFAULT_SETTINGS.defaultNewStickyBackground;
		} else {
			this.settings.defaultNewStickyBackground = dbg as StickyColorId;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	openWorkspacePanel(): void {
		new WorkspacePanelModal(this.app, this).open();
	}

	/** 若便笺列表已打开，立即重绘（新建便笺后对齐颜色/预览，且不与 vault 防抖叠成二次整表刷新） */
	refreshStickyListIfOpen(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.requestRedraw();
			}
		}
	}

	/** 将「内容缩放」同步到所有浮动便笺与已打开的便笺列表卡片（不重渲列表正文）。 */
	syncViewContentZoomToOpenViews(): void {
		this.stickies.updateViewContentZoomFromSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.syncViewContentZoomFromSettings();
			}
		}
	}

	async openNoteListView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)[0];
		const loc = this.settings.noteListOpenLocation;

		if (!leaf) {
			if (loc === 'left-sidebar') {
				const L = workspace.getLeftLeaf(false);
				if (!L) {
					new Notice('无法创建左侧侧边栏视图');
					return;
				}
				await L.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
				leaf = L;
			} else if (loc === 'right-sidebar') {
				const R = workspace.getRightLeaf(false);
				if (!R) {
					new Notice('无法创建右侧侧边栏视图');
					return;
				}
				await R.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
				leaf = R;
			} else {
				const tab = workspace.getLeaf('tab');
				await tab.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
				leaf = tab;
			}
		} else {
			await leaf.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	/** 打开或聚焦指定文件的便笺窗口 */
	async openStickyForFile(file: TFile): Promise<void> {
		await this.stickies.openStickyForFile(file);
	}

	private async restoreStickySession(): Promise<void> {
		await this.stickies.restoreWorkspaceWindows();
	}
}
