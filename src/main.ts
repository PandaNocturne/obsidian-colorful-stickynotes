import { Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import { t } from './lang/helpers';
import {
	clampViewContentZoom,
	normalizeNoteListDimensionCss,
	ColorfulStickyNotesSettingTab,
	DEFAULT_SETTINGS,
	type ColorfulStickyNotesSettings
} from './settings';
import { WorkspacePanelModal } from './modals/WorkspacePanelModal';
import {
	applyNoteListPersisted,
	extractNoteListPersisted,
	loadNoteListPersistedFile,
	NOTE_LIST_DATA_JSON_KEYS,
	normalizeNoteListColorFilters,
	normalizeNoteListPinnedPathsStorage,
	pruneNoteListPinnedPathsAfterDelete,
	resolveNoteListWorkspaceFilterIdAfterMerge,
	rawPluginDataHasNoteListKeys,
	saveNoteListPersistedFile,
	samePinnedPathsOrder
} from './note-list-store';
import { StickyNoteManager } from './sticky/StickyNoteManager';
import { StickyNoteListView } from './views/StickyNoteListView';
import { registerSendToStickyMenus } from './register-send-to-sticky-menus';
import {
	VIEW_STICKY_NOTE_LIST,
	type HeaderNewStickyAdjacentSide,
	type NoteListArchiveFilter,
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
	'mtime-asc',
	'basename-asc',
	'basename-desc'
];

const VALID_NOTE_LIST_OPEN_LOCATION: readonly NoteListOpenLocation[] = [
	'left-sidebar',
	'right-sidebar',
	'new-tab'
];

const VALID_NOTE_LIST_FLOAT_OPEN_FILTER: readonly NoteListFloatOpenFilter[] = ['all', 'open', 'closed'];

const VALID_NOTE_LIST_ARCHIVE_FILTER: readonly NoteListArchiveFilter[] = ['all', 'unarchived', 'archived'];

const VALID_HEADER_NEW_STICKY_ADJACENT_SIDE: readonly HeaderNewStickyAdjacentSide[] = ['left', 'right'];

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
		await this.syncNoteListWorkspaceFiltersAfterWorkspacesLoad();

		this.registerView(VIEW_STICKY_NOTE_LIST, leaf => new StickyNoteListView(leaf, this));
		this.syncNoteListGridMetricsToOpenViews();
		this.app.workspace.onLayoutReady(() => {
			this.syncNoteListGridMetricsToOpenViews();
		});

		this.addRibbonIcon('square-pen', t('RIBBON_OPEN_STICKY'), () => {
			void this.toggleStickyWindowsForCurrentWorkspace();
		});

		this.addRibbonIcon('layout-list', t('RIBBON_STICKY_LIST'), () => {
			void this.openNoteListView();
		});

		this.addRibbonIcon('layers', t('RIBBON_WORKSPACE'), () => {
			this.openWorkspacePanel();
		});

		this.addCommand({
			id: 'open-sticky-note-windows',
			name: t('CMD_TOGGLE_STICKY_WINDOWS'),
			callback: () => {
				void this.toggleStickyWindowsForCurrentWorkspace();
			}
		});

		this.addCommand({
			id: 'open-sticky-note-list',
			name: t('CMD_OPEN_STICKY_LIST'),
			callback: () => {
				void this.openNoteListView();
			}
		});

		this.addCommand({
			id: 'create-new-sticky-note',
			name: t('CMD_NEW_STICKY'),
			callback: () => {
				void this.stickies.addStickyWindow();
			}
		});

		this.addCommand({
			id: 'hide-current-sticky-note',
			name: t('CMD_HIDE_CURRENT'),
			callback: () => {
				this.stickies.toggleHideCurrentSticky();
			}
		});

		this.addCommand({
			id: 'toggle-sticky-notes-hide-others',
			name: t('CMD_TOGGLE_HIDE_OTHERS'),
			callback: () => {
				/* 兼容旧命令：按当前状态切换隐藏其他/显示其他。 */
				if (this.stickies.isHideOthersMode()) {
					this.stickies.showOthersSticky();
				} else {
					this.stickies.hideOthersSticky();
				}
			}
		});

		this.addCommand({
			id: 'toggle-sticky-notes-visibility',
			name: t('CMD_TOGGLE_HIDE_ALL'),
			callback: () => {
				/* 若任意便笺处于隐藏状态，则优先“显示所有”；否则“隐藏所有”。 */
				this.stickies.toggleHideAllByCurrentState();
			}
		});

		this.addCommand({
			id: 'open-sticky-workspace-panel',
			name: t('CMD_OPEN_WORKSPACE_PANEL'),
			callback: () => {
				this.openWorkspacePanel();
			}
		});

		this.addCommand({
			id: 'send-to-sticky-window',
			name: t('CMD_SEND_TO_STICKY_WINDOW'),
			checkCallback: (checking: boolean) => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return false;
				if (checking) return true;
				void this.openStickyForFile(f, { markdownMode: 'preview' });
				return true;
			}
		});

		this.addCommand({
			id: 'move-to-sticky-window',
			name: t('CMD_MOVE_TO_STICKY_WINDOW'),
			checkCallback: (checking: boolean) => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return false;
				if (checking) return true;
				void this.moveFileToStickyWindow(f, { markdownMode: 'preview' });
				return true;
			}
		});

		registerSendToStickyMenus(this);

		this.addSettingTab(new ColorfulStickyNotesSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				const oldN = normalizePath(oldPath);
				const newN = normalizePath(file.path);
				const oldPrefix = `${oldN}/`;
				let changed = false;
				const next = this.settings.noteListPinnedPaths.map(p => {
					const pn = normalizePath(p);
					if (pn === oldN) {
						changed = true;
						return newN;
					}
					if (file instanceof TFolder && pn.startsWith(oldPrefix)) {
						changed = true;
						return normalizePath(`${newN}/${pn.slice(oldPrefix.length)}`);
					}
					return p;
				});
				if (!changed) return;
				this.settings.noteListPinnedPaths = normalizeNoteListPinnedPathsStorage(next);
				void this.saveSettings();
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (this.settings.noteListPinnedPaths.length === 0) return;
				const isFolder = file instanceof TFolder;
				const next = pruneNoteListPinnedPathsAfterDelete(
					this.settings.noteListPinnedPaths,
					file.path,
					isFolder
				);
				if (samePinnedPathsOrder(this.settings.noteListPinnedPaths, next)) return;
				this.settings.noteListPinnedPaths = next;
				void this.saveSettings();
			})
		);

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
		if (typeof this.settings.stickyEdgeAutoStretchHeight !== 'boolean') {
			this.settings.stickyEdgeAutoStretchHeight = DEFAULT_SETTINGS.stickyEdgeAutoStretchHeight;
		}
		if (typeof this.settings.stickyHeaderDoubleClickStretch !== 'boolean') {
			this.settings.stickyHeaderDoubleClickStretch = DEFAULT_SETTINGS.stickyHeaderDoubleClickStretch;
		}
		const VALID_SNAP_MODES = new Set(['none', 'auto', 'ctrl']);
		const rawSnapMode = raw.stickyAssistAlignSnapMode;
		const legacySnapBool = raw.stickyAssistAlignSnap;
		if (typeof rawSnapMode === 'string' && VALID_SNAP_MODES.has(rawSnapMode)) {
			this.settings.stickyAssistAlignSnapMode =
				rawSnapMode as ColorfulStickyNotesSettings['stickyAssistAlignSnapMode'];
		} else if (typeof legacySnapBool === 'boolean') {
			this.settings.stickyAssistAlignSnapMode = legacySnapBool ? 'auto' : 'none';
		} else if (
			typeof this.settings.stickyAssistAlignSnapMode !== 'string' ||
			!VALID_SNAP_MODES.has(this.settings.stickyAssistAlignSnapMode)
		) {
			this.settings.stickyAssistAlignSnapMode = DEFAULT_SETTINGS.stickyAssistAlignSnapMode;
		}
		delete st.stickyAssistAlignSnap;
		const snapPx = this.settings.stickyAssistAlignSnapThresholdPx;
		if (typeof snapPx !== 'number' || !Number.isFinite(snapPx)) {
			this.settings.stickyAssistAlignSnapThresholdPx = DEFAULT_SETTINGS.stickyAssistAlignSnapThresholdPx;
		} else {
			this.settings.stickyAssistAlignSnapThresholdPx = Math.max(1, Math.min(50, Math.round(snapPx)));
		}
		const snapUnbindMult = this.settings.stickyAssistAlignSnapUnbindRangeMultiplier;
		if (typeof snapUnbindMult !== 'number' || !Number.isFinite(snapUnbindMult)) {
			this.settings.stickyAssistAlignSnapUnbindRangeMultiplier =
				DEFAULT_SETTINGS.stickyAssistAlignSnapUnbindRangeMultiplier;
		} else {
			this.settings.stickyAssistAlignSnapUnbindRangeMultiplier = Math.max(
				1,
				Math.min(8, Math.round(snapUnbindMult * 10) / 10)
			);
		}
		if (typeof this.settings.stickyAssistAlignBind !== 'boolean') {
			this.settings.stickyAssistAlignBind = DEFAULT_SETTINGS.stickyAssistAlignBind;
		}

		this.settings.noteListPinnedPaths = normalizeNoteListPinnedPathsStorage(
			'noteListPinnedPaths' in raw ? raw.noteListPinnedPaths : this.settings.noteListPinnedPaths
		);

		delete st.noteListLayout;
		const rawH = 'noteListCardHeight' in raw ? raw.noteListCardHeight : this.settings.noteListCardHeight;
		this.settings.noteListCardHeight = normalizeNoteListDimensionCss(
			rawH,
			DEFAULT_SETTINGS.noteListCardHeight,
			120,
			600
		);
		const rawW =
			'noteListGridMinWidth' in raw ? raw.noteListGridMinWidth : this.settings.noteListGridMinWidth;
		this.settings.noteListGridMinWidth = normalizeNoteListDimensionCss(
			rawW,
			DEFAULT_SETTINGS.noteListGridMinWidth,
			180,
			800
		);

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

		const naf = this.settings.noteListArchiveFilter;
		if (
			typeof naf !== 'string' ||
			!VALID_NOTE_LIST_ARCHIVE_FILTER.includes(naf as NoteListArchiveFilter)
		) {
			this.settings.noteListArchiveFilter = DEFAULT_SETTINGS.noteListArchiveFilter;
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

		delete (st as Record<string, unknown>).noteListWorkspaceFilterIds;
		this.settings.noteListWorkspaceFilterId = resolveNoteListWorkspaceFilterIdAfterMerge(raw);

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

		const hns = this.settings.headerNewStickyAdjacentSide;
		if (
			typeof hns !== 'string' ||
			!VALID_HEADER_NEW_STICKY_ADJACENT_SIDE.includes(hns as HeaderNewStickyAdjacentSide)
		) {
			this.settings.headerNewStickyAdjacentSide = DEFAULT_SETTINGS.headerNewStickyAdjacentSide;
		}

		const listFromDisk = await loadNoteListPersistedFile(this);
		if (listFromDisk) {
			applyNoteListPersisted(this.settings, listFromDisk);
		} else {
			await saveNoteListPersistedFile(this, extractNoteListPersisted(this.settings));
		}
		if (rawPluginDataHasNoteListKeys(raw)) {
			await this.persistPluginSettingsWithoutNoteListKeys();
		}
	}

	/** 便笺列表已不再提供工作区筛选：清空遗留的持久化值。 */
	private async syncNoteListWorkspaceFiltersAfterWorkspacesLoad(): Promise<void> {
		if (this.settings.noteListWorkspaceFilterId !== null) {
			this.settings.noteListWorkspaceFilterId = null;
			await this.saveSettings();
		}
	}

	/** 写入 `data.json` 时去掉便笺列表字段（列表状态在 `note-list.json`）。 */
	private async persistPluginSettingsWithoutNoteListKeys(): Promise<void> {
		const payload = JSON.parse(JSON.stringify(this.settings)) as Record<string, unknown>;
		for (const k of NOTE_LIST_DATA_JSON_KEYS) {
			delete payload[k];
		}
		delete payload.noteListWorkspaceFilterIds;
		await this.saveData(payload);
	}

	async saveSettings(): Promise<void> {
		try {
			await saveNoteListPersistedFile(this, extractNoteListPersisted(this.settings));
			/* 深拷贝后写入，避免不可 JSON 序列化字段或 Obsidian 内部引用导致静默失败 */
			const payload = JSON.parse(JSON.stringify(this.settings)) as Record<string, unknown>;
			for (const k of NOTE_LIST_DATA_JSON_KEYS) {
				delete payload[k];
			}
			await this.saveData(payload);
		} catch (e) {
			console.error('[colorful-sticky-notes] saveSettings failed', e);
			new Notice(t('NOTICE_SAVE_SETTINGS_FAILED'));
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

	/**
	 * 浮动便笺打开/关闭时刷新列表（requestAnimationFrame 合并多次触发）。
	 * 仅在「已打开 / 未打开」筛选下需要重绘；「全部」下列成员不变则无需刷新。
	 */
	refreshStickyListOpenIndicatorsIfOpen(): void {
		if (this.settings.noteListFloatOpenFilter === 'all') return;
		if (this.listOpenIndicatorRaf !== null) {
			window.cancelAnimationFrame(this.listOpenIndicatorRaf);
		}
		this.listOpenIndicatorRaf = window.requestAnimationFrame(() => {
			this.listOpenIndicatorRaf = null;
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)) {
				const v = leaf.view;
				if (v instanceof StickyNoteListView) {
					v.requestRedraw();
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

	/** 将「贴边自动拉伸」同步到已打开的浮动便笺。 */
	syncStickyEdgeAutoStretchToOpenViews(): void {
		this.stickies.updateEdgeAutoStretchFromSettings();
	}

	/** 将「双击头部拉伸」同步到已打开的浮动便笺。 */
	syncStickyHeaderDoubleClickStretchToOpenViews(): void {
		this.stickies.updateHeaderDoubleClickStretchFromSettings();
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
					new Notice(t('NOTICE_CANNOT_CREATE_LEFT_SIDEBAR'));
					return;
				}
				await L.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
				leaf = L;
			} else if (loc === 'right-sidebar') {
				const R = workspace.getRightLeaf(false);
				if (!R) {
					new Notice(t('NOTICE_CANNOT_CREATE_RIGHT_SIDEBAR'));
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
	async openStickyForFile(
		file: TFile,
		opts?: { markdownMode?: 'preview' | 'source' }
	): Promise<void> {
		await this.stickies.openStickyForFile(file, opts);
	}

	/** 在便笺中打开并关闭主工作区中该文件的标签（不含便笺浮动叶）。 */
	async moveFileToStickyWindow(
		file: TFile,
		opts?: { markdownMode?: 'preview' | 'source' }
	): Promise<void> {
		await this.stickies.moveFileToStickyWindow(file, opts);
	}

	/**
	 * 命令行为：
	 * 1) 当前便笺工作区没有便笺 → 新建并打开一张便笺
	 * 2) 当前便笺工作区存在便笺 → 关闭该便笺工作区内所有已打开便笺
	 * 3) 若当前无打开便笺，但该便笺工作区已有保存布局 → 恢复该便笺工作区
	 */
	private async toggleStickyWindowsForCurrentWorkspace(): Promise<void> {
		if (this.stickies.hasOpenStickyWindows()) {
			/* 关闭窗口但保留便笺工作区会话，便于下次一键恢复。 */
			this.stickies.closeAllOpenStickyWindows(true);
			return;
		}
		if (this.stickies.hasSavedStickyWindowsInActiveWorkspace()) {
			await this.stickies.restoreWorkspaceWindows();
			return;
		}
		await this.stickies.addStickyWindow();
	}

	private async restoreStickySession(): Promise<void> {
		await this.stickies.restoreWorkspaceWindows();
	}
}
