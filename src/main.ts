import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import {
	clampViewContentZoom,
	ColorfulStickyNotesSettingTab,
	DEFAULT_SETTINGS,
	type ColorfulStickyNotesSettings
} from './settings';
import { WorkspacePanelModal } from './modals/WorkspacePanelModal';
import { StickyNoteManager } from './sticky/StickyNoteManager';
import { StickyNoteListView } from './views/StickyNoteListView';
import {
	VIEW_STICKY_NOTE_LIST,
	type NoteListFloatOpenFilter,
	type NoteListOpenLocation,
	type NoteListSort,
	type StickyColorId
} from './types';

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

const VALID_NOTE_LIST_FLOAT_OPEN_FILTER: readonly NoteListFloatOpenFilter[] = ['all', 'open', 'closed'];

function normalizeNoteListColorFilters(value: unknown): StickyColorId[] {
	if (!Array.isArray(value)) return [];
	const out: StickyColorId[] = [];
	const seen = new Set<string>();
	for (const x of value) {
		if (typeof x !== 'string' || !VALID_NEW_STICKY_BG.includes(x as StickyColorId)) continue;
		if (seen.has(x)) continue;
		seen.add(x);
		out.push(x as StickyColorId);
	}
	return out;
}

/**
 * 便笺列表置顶路径：仅做规范化与去重。
 * 不在加载时用 vault 校验文件是否存在，否则插件早于库就绪时会把合法路径整批丢掉，表现为「置顶未保存」。
 */
function normalizeNoteListPinnedPathsStorage(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of value) {
		if (typeof x !== 'string' || !x.trim()) continue;
		const p = normalizePath(x);
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

export default class ColorfulStickyNotesPlugin extends Plugin {
	settings!: ColorfulStickyNotesSettings;
	stickies!: StickyNoteManager;

	/** 便笺列表排序：插件新建的便笺路径临时置顶，`StickyNoteListView` 渲染后清空 */
	listPrioritizeStickyPath: string | null = null;

	/** 写入 frontmatter 等触发的 `modify`：跳过防抖列表刷新，由新建流程末尾主动 `refreshStickyListIfOpen` 一次，避免连刷卡顿 */
	muteStickyListModifyPaths: Set<string> = new Set();

	private listOpenIndicatorRaf: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.stickies = new StickyNoteManager(this, this.app);
		await this.stickies.init();

		this.registerView(VIEW_STICKY_NOTE_LIST, leaf => new StickyNoteListView(leaf, this));
		this.syncNoteListGridMetricsToOpenViews();
		this.app.workspace.onLayoutReady(() => {
			this.syncNoteListGridMetricsToOpenViews();
		});

		this.addRibbonIcon('square-pen', '打开便笺', () => {
			void this.restoreStickySession();
		});

		this.addRibbonIcon('layout-grid', '便笺列表', () => {
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
		if (this.listOpenIndicatorRaf !== null) {
			window.cancelAnimationFrame(this.listOpenIndicatorRaf);
			this.listOpenIndicatorRaf = null;
		}
		/* 勿 detach 便笺列表：重载插件时不应关闭用户已固定在侧栏的叶视图。 */
		this.stickies?.onunload();
	}

	async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw) as ColorfulStickyNotesSettings;
		const st = this.settings as unknown as Record<string, unknown>;
		delete st.bottomBarCommands;
		delete st.defaultPositionMode;
		delete st.defaultPositionX;
		delete st.defaultPositionY;

		const legacyZoom = raw.viewContentZoom;
		if (typeof legacyZoom === 'number' && Number.isFinite(legacyZoom)) {
			const c = clampViewContentZoom(legacyZoom);
			if (!('stickyViewContentZoom' in raw) && !('noteListViewContentZoom' in raw)) {
				this.settings.stickyViewContentZoom = c;
				this.settings.noteListViewContentZoom = c;
			}
		}
		delete st.viewContentZoom;

		this.settings.stickyViewContentZoom = clampViewContentZoom(this.settings.stickyViewContentZoom);
		this.settings.noteListViewContentZoom = clampViewContentZoom(this.settings.noteListViewContentZoom);

		if (typeof this.settings.noteListCardOverflowHidden !== 'boolean') {
			this.settings.noteListCardOverflowHidden = DEFAULT_SETTINGS.noteListCardOverflowHidden;
		}

		this.settings.noteListPinnedPaths = normalizeNoteListPinnedPathsStorage(
			'noteListPinnedPaths' in raw ? raw.noteListPinnedPaths : this.settings.noteListPinnedPaths
		);

		delete st.noteListLayout;
		let listH = this.settings.noteListCardHeight;
		if (typeof listH !== 'number' || !Number.isFinite(listH)) {
			listH = DEFAULT_SETTINGS.noteListCardHeight;
		}
		this.settings.noteListCardHeight = Math.max(120, Math.min(600, Math.round(listH)));

		let listMinW = this.settings.noteListGridMinWidth;
		if (typeof listMinW !== 'number' || !Number.isFinite(listMinW)) {
			listMinW = DEFAULT_SETTINGS.noteListGridMinWidth;
		}
		this.settings.noteListGridMinWidth = Math.max(180, Math.min(800, Math.round(listMinW)));

		let listPs = this.settings.noteListPageSize;
		if (typeof listPs !== 'number' || !Number.isFinite(listPs)) {
			listPs = DEFAULT_SETTINGS.noteListPageSize;
		}
		this.settings.noteListPageSize = Math.max(4, Math.min(48, Math.round(listPs)));

		const nls = this.settings.noteListSort;
		if (typeof nls !== 'string' || !VALID_NOTE_LIST_SORT.includes(nls as NoteListSort)) {
			this.settings.noteListSort = DEFAULT_SETTINGS.noteListSort;
		}

		const nf = this.settings.noteListFloatOpenFilter;
		if (
			typeof nf !== 'string' ||
			!VALID_NOTE_LIST_FLOAT_OPEN_FILTER.includes(nf as NoteListFloatOpenFilter)
		) {
			this.settings.noteListFloatOpenFilter = DEFAULT_SETTINGS.noteListFloatOpenFilter;
		}

		const hasNewColorFilters = 'noteListColorFilters' in raw;
		if (hasNewColorFilters) {
			this.settings.noteListColorFilters = normalizeNoteListColorFilters(raw.noteListColorFilters);
		} else {
			const leg = raw.noteListColorFilter;
			if (
				typeof leg === 'string' &&
				leg !== 'all' &&
				VALID_NEW_STICKY_BG.includes(leg as StickyColorId)
			) {
				this.settings.noteListColorFilters = [leg as StickyColorId];
			} else {
				this.settings.noteListColorFilters = [];
			}
		}
		delete st.noteListColorFilter;

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
		try {
			/* 深拷贝后写入，避免不可 JSON 序列化字段或 Obsidian 内部引用导致静默失败 */
			const payload = JSON.parse(JSON.stringify(this.settings)) as ColorfulStickyNotesSettings;
			await this.saveData(payload);
		} catch (e) {
			console.error('[colorful-sticky-notes] saveSettings failed', e);
			new Notice('多彩便笺：设置保存失败，请查看控制台。');
			throw e;
		}
	}

	openWorkspacePanel(): void {
		new WorkspacePanelModal(this.app, this).open();
	}

	/** 取消已打开便笺列表上排队的结构/正文防抖（不重绘）。供新建便笺在延迟刷新前调用。 */
	cancelStickyListDebouncedRefresh(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.cancelPendingListRefresh();
			}
		}
	}

	/** 同步便笺列表卡片上「已打开浮动便笺」的右下角卷角标记（requestAnimationFrame 合并多次触发）。 */
	refreshStickyListOpenIndicatorsIfOpen(): void {
		if (this.listOpenIndicatorRaf !== null) {
			window.cancelAnimationFrame(this.listOpenIndicatorRaf);
		}
		this.listOpenIndicatorRaf = window.requestAnimationFrame(() => {
			this.listOpenIndicatorRaf = null;
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
				const v = leaf.view;
				if (v instanceof StickyNoteListView) {
					/* 非「全部」时打开/关闭便笺会改变列表成员，需整表重绘；仅「全部」时只更新卷角标记 */
					if (this.settings.noteListFloatOpenFilter !== 'all') {
						v.requestRedraw();
					} else {
						v.syncOpenStickyCornerIndicators();
					}
				}
			}
		});
	}

	/** 若便笺列表已打开：取消 create 等已排队的防抖并立即重绘，避免与 vault 事件叠成两次整表渲染 */
	refreshStickyListIfOpen(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.flushListRedraw();
			}
		}
	}

	/** 每页条数变更：回到第一页并重绘已打开的列表。 */
	refreshStickyListPageSizeChanged(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.resetPageAndRedraw();
			}
		}
	}

	/** 将便笺窗口内容缩放同步到已打开的浮动便笺。 */
	syncStickyViewContentZoomToOpenViews(): void {
		this.stickies.updateViewContentZoomFromSettings();
	}

	/** 将列表预览缩放同步到已打开的便笺列表（不重渲 Markdown）。 */
	syncNoteListViewContentZoomToOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.syncViewContentZoomFromSettings();
			}
		}
	}

	/** 将列表网格的卡片高度、列最小宽度同步到已打开的便笺列表视图。 */
	syncNoteListGridMetricsToOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
			const v = leaf.view;
			if (v instanceof StickyNoteListView) {
				v.syncListGridMetricsFromSettings();
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
		this.refreshStickyListOpenIndicatorsIfOpen();
	}

	/** 打开或聚焦指定文件的便笺窗口 */
	async openStickyForFile(file: TFile): Promise<void> {
		await this.stickies.openStickyForFile(file);
	}

	private async restoreStickySession(): Promise<void> {
		await this.stickies.restoreWorkspaceWindows();
	}
}
