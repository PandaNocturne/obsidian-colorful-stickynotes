import {
	Component,
	ItemView,
	MarkdownRenderer,
	Menu,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	debounce,
	normalizePath,
	setIcon,
	type Debouncer
} from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { t } from '../lang/helpers';
import type { MessageKey } from '../lang/locale/en';
import {
	clampDashComposerPaneHeight,
	clampDashLeftPaneWidth,
	clampViewContentZoom,
	DASH_COMPOSER_PANE_HEIGHT_DEFAULT,
	DASH_LEFT_PANE_AUTO_COLLAPSE_BELOW,
	DASH_LEFT_PANE_WIDTH_DEFAULT,
	dashboardFilterStateKey,
	normalizeDashboardFilterState,
	normalizeDashboardVisibleAreaModes,
	type DashboardFilterState
} from '../settings';
import {
	VIEW_STICKY_NOTE_DASHBOARD,
	WS_TAB_GROUP_DEFAULT_ID,
	WS_TAB_GROUP_UNGROUPED_ID,
	type DashAreaMode,
	type DashWorkspaceSel,
	type NoteListArchiveFilter,
	type NoteListSort,
	type StickyColorId,
	type StickyWorkspace,
	type StickyWorkspaceTabGroup
} from '../types';
import { ListBatchDeleteConfirmModal } from '../modals/ListBatchDeleteConfirmModal';
import {
	DeleteStickyWorkspaceConfirmModal,
	DeleteWorkspaceTabGroupConfirmModal,
	NewBlankWorkspaceModal,
	NewWorkspaceTabGroupModal,
	PermanentlyDeleteStickyWorkspaceConfirmModal
} from '../modals/WorkspacePanelModal';
import { collectMarkdownUnderFolder } from '../utils/collect-markdown-under-folder';
import { resolveStickyArchivedForFile } from '../utils/sticky-archived-from-file';
import { resolveStickyBgColorForFile } from '../utils/sticky-bg-from-file';
import {
	buildPaginationEntries,
	dateCountsForFiles,
	heatmapLevelFromCount,
	filterStickyFilesByArchiveFilter,
	filterStickyFilesByColors,
	filterStickyFilesByDateFilter,
	filterStickyFilesByKeywords,
	injectMarkdownAfterFrontmatter,
	localDateKeyFromMs,
	sortStickyListFiles,
	stickyDateFilterKey,
	stickyDateFiltersEqual,
	listLocalDateKeysInclusive,
	type StickyDateField,
	type StickyDateFilter
} from '../utils/query-sticky-list';
import { SHEET_COLOR_ORDER } from '../sticky/sticky-color-order';
import { isWorkspaceUngrouped, resolveTrashWorkspaceGroupLabel, resolveWorkspaceTabGroupId } from '../workspace-store';
import { EmbeddedMarkdownEditorHost } from '../utils/embedded-markdown-editor';
import {
	collectStickyTagCatalog,
	displayStickyTag,
	filterStickyFilesByTags,
	normalizeStickyTag,
	type StickyTagCount
} from '../utils/sticky-tags-from-file';
import {
	dragEventHasMime,
	readStickyPathsDragData,
	setStickyPathsDragData,
	STICKY_PATHS_DND_MIME,
	WORKSPACE_DND_MIME,
	WORKSPACE_GROUP_DND_MIME
} from '../utils/workspace-dnd';
import {
	appendGroupedWorkspacePicker,
	buildWorkspaceMenuGroups
} from '../utils/workspace-transfer-menu';

const DASH_AREA_MODE_SPECS: Array<{
	mode: DashAreaMode;
	titleKey: MessageKey;
	icon: string;
	showCount: boolean;
}> = [
	{ mode: 'all', titleKey: 'DASH_AREA_ALL', icon: 'inbox', showCount: true },
	{ mode: 'ungrouped', titleKey: 'DASH_AREA_UNGROUPED', icon: 'folder-x', showCount: true },
	{ mode: 'uncategorized', titleKey: 'DASH_AREA_UNCATEGORIZED', icon: 'layers', showCount: true },
	{ mode: 'recent', titleKey: 'DASH_AREA_RECENT', icon: 'clock', showCount: false },
	{ mode: 'random', titleKey: 'DASH_AREA_RANDOM', icon: 'shuffle', showCount: false },
	{ mode: 'archived', titleKey: 'DASH_AREA_ARCHIVED', icon: 'archive', showCount: true }
];

type DashLeftPanelId = 'area' | 'workspace';

type DashWsTreeSort = 'manual' | 'name-asc' | 'name-desc' | 'mtime-desc';

const DASH_WS_TREE_SORT_SPECS: Array<{
	mode: DashWsTreeSort;
	titleKey: MessageKey;
	menuIcon: string;
}> = [
	{ mode: 'manual', titleKey: 'DASH_WS_SORT_MANUAL', menuIcon: 'list-ordered' },
	{ mode: 'name-asc', titleKey: 'DASH_WS_SORT_NAME_ASC', menuIcon: 'arrow-up-narrow-wide' },
	{ mode: 'name-desc', titleKey: 'DASH_WS_SORT_NAME_DESC', menuIcon: 'arrow-down-narrow-wide' },
	{ mode: 'mtime-desc', titleKey: 'DASH_WS_SORT_MTIME_DESC', menuIcon: 'clock' }
];

/** 列表卡片预览：维基嵌入语法，由 Obsidian 按阅读视图嵌入管线渲染整篇便笺。 */
function listPreviewEmbedMarkdown(file: TFile): string {
	const pathNoExt = file.path.replace(/\.md$/i, '');
	return `![[${pathNoExt}]]\n`;
}

/** 展开/紧凑工具栏上的排序按钮默认图标（时间类排序共用；文件名称排序另设 `toolbarIcon`）。 */
const NOTE_LIST_SORT_TOOLBAR_ICON = 'arrow-down-wide-narrow';

/** 排序模式：`menuIcon` 用于菜单行；`toolbarIcon` 省略时工具栏按钮用 `NOTE_LIST_SORT_TOOLBAR_ICON`。 */
const NOTE_LIST_SORT_SPECS: readonly {
	mode: NoteListSort;
	menuIcon: string;
	toolbarIcon?: string;
	titleKey: MessageKey;
}[] = [
	{ mode: 'ctime-desc', menuIcon: 'calendar-arrow-down', titleKey: 'SORT_CTIME_DESC_NEW' },
	{ mode: 'ctime-asc', menuIcon: 'calendar-arrow-up', titleKey: 'SORT_CTIME_ASC_OLD' },
	{ mode: 'mtime-desc', menuIcon: 'clock-arrow-down', titleKey: 'SORT_MTIME_DESC_NEW' },
	{ mode: 'mtime-asc', menuIcon: 'clock-arrow-up', titleKey: 'SORT_MTIME_ASC_OLD' },
	{
		mode: 'basename-asc',
		menuIcon: 'arrow-up-narrow-wide',
		toolbarIcon: 'arrow-up-narrow-wide',
		titleKey: 'SORT_BASENAME_AZ'
	},
	{
		mode: 'basename-desc',
		menuIcon: 'arrow-down-narrow-wide',
		toolbarIcon: 'arrow-down-narrow-wide',
		titleKey: 'SORT_BASENAME_ZA'
	}
];

function buildStickyBgSubmenuTitle(
	doc: Document,
	colorId: StickyColorId,
	label: string,
	selected: boolean
): DocumentFragment {
	const frag = doc.createDocumentFragment();
	const row = doc.createElement('span');
	row.className = 'csn-list-bg-menu-row';
	row.dataset.csnBg = colorId;
	const lab = doc.createElement('span');
	lab.className = 'csn-list-bg-menu-label';
	lab.textContent = label;
	row.appendChild(lab);
	if (selected) {
		const check = doc.createElement('span');
		check.className = 'csn-list-bg-menu-check';
		setIcon(check, 'check');
		row.appendChild(check);
	}
	frag.appendChild(row);
	return frag;
}

function weekdayMinLabels(): string[] {
	try {
		const m = (window as Window & { moment?: { weekdaysMin?: () => string[] } }).moment;
		const labels = m?.weekdaysMin?.();
		if (Array.isArray(labels) && labels.length === 7) return labels;
	} catch {
		/* fall through */
	}
	return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
}

function monthShortLabels(): string[] {
	try {
		const m = (window as Window & { moment?: { monthsShort?: () => string[] } }).moment;
		const labels = m?.monthsShort?.();
		if (Array.isArray(labels) && labels.length === 12) return labels;
	} catch {
		/* fall through */
	}
	return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
}

/** 以周日为一周起点，生成当月完整周行（含邻月日期）。 */
function buildMonthWeekRows(
	year: number,
	month0: number
): Array<Array<{ y: number; m0: number; d: number; inMonth: boolean }>> {
	const first = new Date(year, month0, 1);
	const start = new Date(first);
	start.setDate(1 - first.getDay());
	const rows: Array<Array<{ y: number; m0: number; d: number; inMonth: boolean }>> = [];
	const cursor = new Date(start);
	for (let r = 0; r < 6; r++) {
		const days: Array<{ y: number; m0: number; d: number; inMonth: boolean }> = [];
		for (let i = 0; i < 7; i++) {
			days.push({
				y: cursor.getFullYear(),
				m0: cursor.getMonth(),
				d: cursor.getDate(),
				inMonth: cursor.getFullYear() === year && cursor.getMonth() === month0
			});
			cursor.setDate(cursor.getDate() + 1);
		}
		rows.push(days);
		if (cursor.getMonth() !== month0 && cursor.getDay() === 0) break;
	}
	return rows;
}

export class StickyNoteDashboardView extends ItemView {
	private calendarEl: HTMLElement | null = null;
	private composerHostEl: HTMLElement | null = null;
	private composerFallbackEl: HTMLTextAreaElement | null = null;
	private composerEditor: EmbeddedMarkdownEditorHost | null = null;
	private composerColorBtn: HTMLButtonElement | null = null;
	private composerColorWrapEl: HTMLElement | null = null;
	private composerPaletteEl: HTMLElement | null = null;
	private composerColorSwatchBtns = new Map<StickyColorId, HTMLButtonElement>();
	private composerDoneBtn: HTMLButtonElement | null = null;
	/** 输入区新建便笺颜色（可在完成按钮旁切换）。 */
	private composerCreateColor: StickyColorId = 'yellow';
	private treeEl: HTMLElement | null = null;
	private areaNavEl: HTMLElement | null = null;
	private areaPanelEl: HTMLElement | null = null;
	private areaVisibilityBtn: HTMLButtonElement | null = null;
	private areaVisibilityPanelEl: HTMLElement | null = null;
	private areaVisibilityItemBtns = new Map<DashAreaMode, HTMLButtonElement>();
	private wsPanelEl: HTMLElement | null = null;
	private leftPanelTitleBtns = new Map<DashLeftPanelId, HTMLButtonElement>();
	private collapsedLeftPanels = new Set<DashLeftPanelId>();
	private areaBtns = new Map<DashAreaMode, HTMLButtonElement>();
	private areaCounts: Partial<Record<DashAreaMode, number>> = {};
	private wsTreeFilterInput: HTMLInputElement | null = null;
	private wsTreeFilterQuery = '';
	private wsTreeSortMode: DashWsTreeSort = 'manual';
	/** 树内正在拖拽的数据类型（自定义 MIME 在部分 Electron 的 dragover.types 里不可靠）。 */
	private wsTreeDragKind: 'none' | 'workspace' | 'group' | 'sticky' = 'none';
	private wsTreeSortBtn: HTMLButtonElement | null = null;
	private wsTreeCollapseBtn: HTMLButtonElement | null = null;
	private wsTreeShowArchivedBtn: HTMLButtonElement | null = null;
	private wsTreeAddBtn: HTMLButtonElement | null = null;
	/** 选中卡片时是否自动定位工作区树。 */
	private wsTreeCardFocusBtn: HTMLButtonElement | null = null;
	/** 工作区树是否显示已归档（trash）工作区。 */
	private wsTreeShowArchived = false;
	private searchInput: HTMLInputElement | null = null;
	private searchInnerEl: HTMLElement | null = null;
	private searchClearBtn: HTMLButtonElement | null = null;
	private dateFilterChipsEl: HTMLElement | null = null;
	private dateFilterWrapEl: HTMLElement | null = null;
	private dateFilterAddBtn: HTMLButtonElement | null = null;
	private dateFilterPanelEl: HTMLElement | null = null;
	private dateFilterModeEl: HTMLElement | null = null;
	private dateFilterInput: HTMLInputElement | null = null;
	private dateFilterConfirmBtn: HTMLButtonElement | null = null;
	private dateFilterPanelGroupsEl: HTMLElement | null = null;
	private dateFilterPanelListEl: HTMLElement | null = null;
	/** + 面板添加粒度：日可累加；年/月为单值筛选。 */
	private dateFilterAddMode: 'day' | 'month' | 'year' = 'day';
	private dateFilterPanelGroup: 'selected' | 'add' = 'add';
	private readonly dateFilterModeBtns = new Map<'day' | 'month' | 'year', HTMLButtonElement>();
	private wsFilterWrapEl: HTMLElement | null = null;
	private wsFilterChipsEl: HTMLElement | null = null;
	private wsFilterAddBtn: HTMLButtonElement | null = null;
	private wsFilterPanelEl: HTMLElement | null = null;
	private wsFilterPanelListEl: HTMLElement | null = null;
	private wsFilterPanelGroupsEl: HTMLElement | null = null;
	private wsFilterPanelSearchInput: HTMLInputElement | null = null;
	private wsFilterPanelSearch = '';
	private wsFilterPanelGroup: 'selected' | 'all' = 'all';
	private colorBtns = new Map<StickyColorId, HTMLButtonElement>();
	private archiveFilterBtns = new Map<NoteListArchiveFilter, HTMLButtonElement>();
	private gridEl: HTMLElement | null = null;
	private paginationEl: HTMLElement | null = null;
	private paginationRowEl: HTMLElement | null = null;
	private paginationPagesEl: HTMLElement | null = null;
	private paginationPrevBtn: HTMLButtonElement | null = null;
	private paginationNextBtn: HTMLButtonElement | null = null;
	private paginationMetaEl: HTMLElement | null = null;

	private sortDropdownBtn: HTMLButtonElement | null = null;
	private listBulkEditBtn: HTMLButtonElement | null = null;
	private listCardOverflowClipBtn: HTMLButtonElement | null = null;
	private composerToggleBtn: HTMLButtonElement | null = null;
	private leftPaneToggleBtn: HTMLButtonElement | null = null;
	/** 因视口过窄而临时收起左侧栏（不写入用户设置）。 */
	private leftPaneAutoCollapsedForWidth = false;
	/** 窄宽度下用户主动展开左侧栏时，本轮窄布局内不再自动收起。 */
	private leftPaneKeepOpenWhenNarrow = false;
	/** 开启后卡片头部显示归档复选框，便于勾选修改。 */
	private listArchiveCheckboxEditMode = false;

	/** 每张列表卡片嵌入预览各自一个 Component，便于翻页时按路径卸载/复用。 */
	private readonly listCardMarkdownHosts = new Map<string, Component>();
	private gridDelegatedEvents = false;
	/** 上次渲染的仪表盘结构指纹；一致时翻页可走 DOM 增量。 */
	private lastDashStructureKey = '';
	/** 筛选上下文指纹（不含 paths/pinned）；不变时新建/删除走卡片增量，避免整表闪烁。 */
	private lastDashFilterKey = '';
	private lastRenderedPageIndex: number | null = null;
	private listPageIndex = 0;
	private areaMode: DashAreaMode = 'all';
	/** 随机模式锁定的路径顺序（进入模式或刷新时重建）。 */
	private randomOrderPaths: string[] | null = null;
	private archiveFilter: NoteListArchiveFilter = 'unarchived';
	private colorFilters: StickyColorId[] = [];
	/** 包含筛选的标签（规范化 `#tag`）。 */
	private tagIncludeFilters: string[] = [];
	/** 排除筛选的标签。 */
	private tagExcludeFilters: string[] = [];
	private tagFilterLogic: 'and' | 'or' = 'or';
	private tagPanelGroup: 'all' | 'selected' = 'all';
	private tagPanelSearch = '';
	private tagCatalog: StickyTagCount[] = [];
	private tagFilterBtn: HTMLButtonElement | null = null;
	private tagChipsEl: HTMLElement | null = null;
	private tagPanelWrapEl: HTMLElement | null = null;
	private tagPanelEl: HTMLElement | null = null;
	private tagPanelSearchInput: HTMLInputElement | null = null;
	private tagPanelGroupsEl: HTMLElement | null = null;
	private tagPanelListEl: HTMLElement | null = null;
	private tagLogicOrBtn: HTMLButtonElement | null = null;
	private tagLogicAndBtn: HTMLButtonElement | null = null;
	private workspaceSel: DashWorkspaceSel = { kind: 'all' };
	private workspaceFilterLogic: 'and' | 'or' = 'or';
	private wsLogicOrBtn: HTMLButtonElement | null = null;
	private wsLogicAndBtn: HTMLButtonElement | null = null;
	private collapsedGroupIds = new Set<string>();
	private calYear: number;
	private calMonth0: number;
	/** 年月自定义选择面板：null 关闭。 */
	private calPicker: null | 'year' | 'month' = null;
	/** 年面板十年起点（含）。 */
	private calDecadeStart = 0;
	private calPickerDocClose: ((evt: MouseEvent) => void) | null = null;
	private selectedDateFilter: StickyDateFilter | null = null;
	/** Shift 范围多选的锚点日期（YYYY-MM-DD）。 */
	private lastCalDateClickKey: string | null = null;
	private noteDateKeys = new Set<string>();
	/** 创建日 → 便笺数，供日历热力图。 */
	private noteDateCounts = new Map<string, number>();
	private composing = false;

	/** 列表卡片多选：当前选中的便笺路径（normalizePath）。 */
	private readonly selectedListNotePaths = new Set<string>();
	/** Shift 范围选择的锚点（最后一次显式选择）。 */
	private lastSelectedListNotePath: string | null = null;
	/** 选中卡片所属工作区，用于树节点高亮（不改变筛选）。 */
	private cardFocusWorkspaceIds: string[] = [];
	/** 从拖拽手柄拖拽时，附着在 `document.body` 上的拖拽行为说明浮层。 */
	private canvasDragCanvasHintEl: HTMLElement | null = null;
	/** 当前浮层提示类型：Canvas / 工作区。 */
	private cardDragHintKind: 'none' | 'canvas' | 'workspace' = 'none';

	private dashRenderChain: Promise<void> = Promise.resolve();
	private debouncedStructureRefresh: Debouncer<[], void> | null = null;
	private debouncedContentRefresh: Debouncer<[], void> | null = null;
	/** 快速输入未提交草稿防抖落盘。 */
	private debouncedPersistComposerDraft: Debouncer<[string], void> | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ColorfulStickyNotesPlugin
	) {
		super(leaf);
		const now = new Date();
		this.calYear = now.getFullYear();
		this.calMonth0 = now.getMonth();
		this.composerCreateColor = this.plugin.settings.defaultNewStickyBackground ?? 'yellow';
		this.restoreDashboardFiltersFromSettings();
	}

	getViewType(): string {
		return VIEW_STICKY_NOTE_DASHBOARD;
	}

	getDisplayText(): string {
		return t('DISPLAY_STICKY_DASHBOARD');
	}

	getIcon(): string {
		return 'layout-panel-top';
	}

	/** 从设置写入根节点 CSS 变量（网格列最小宽度、卡片高度）及预览区 overflow。 */
	syncListGridMetricsFromSettings(): void {
		if (!this.contentEl.hasClass('csn-dash')) return;
		const h = this.plugin.settings.noteListCardHeight.trim();
		const w = this.plugin.settings.noteListGridMinWidth.trim();
		this.contentEl.style.setProperty('--csn-list-card-height', h);
		this.contentEl.style.setProperty('--csn-list-grid-min-width', w);
		this.contentEl.toggleClass(
			'csn-list-view--card-overflow-visible',
			!this.plugin.settings.noteListCardOverflowHidden
		);
		this.syncCardOverflowClipToolbarBtn();
	}

	private isDashViewportNarrow(): boolean {
		const w = this.contentEl.clientWidth;
		return w > 0 && w < DASH_LEFT_PANE_AUTO_COLLAPSE_BELOW;
	}

	private isLeftPaneCollapsed(): boolean {
		return !!this.plugin.settings.dashboardLeftPaneCollapsed || this.leftPaneAutoCollapsedForWidth;
	}

	/** 写入左右栏宽、输入区高到 CSS 变量，并同步折叠态 class。 */
	applyDashPaneLayout(): void {
		if (!this.contentEl.hasClass('csn-dash')) return;
		const leftW = clampDashLeftPaneWidth(this.plugin.settings.dashboardLeftPaneWidth);
		const composerH = clampDashComposerPaneHeight(this.plugin.settings.dashboardComposerPaneHeight);
		this.plugin.settings.dashboardLeftPaneWidth = leftW;
		this.plugin.settings.dashboardComposerPaneHeight = composerH;
		this.contentEl.style.setProperty('--csn-dash-left-width', `${leftW}px`);
		this.contentEl.style.setProperty('--csn-dash-composer-height', `${composerH}px`);
		this.contentEl.toggleClass('csn-dash--left-collapsed', this.isLeftPaneCollapsed());
		this.contentEl.toggleClass(
			'csn-dash--composer-hidden',
			!!this.plugin.settings.dashboardComposerHidden
		);
		this.syncLeftPaneToggleBtn();
		this.syncComposerToggleBtn();
	}

	private syncLeftPaneToggleBtn(): void {
		const btn = this.leftPaneToggleBtn;
		if (!btn) return;
		const collapsed = this.isLeftPaneCollapsed();
		btn.toggleClass('is-active', !collapsed);
		btn.setAttr('aria-pressed', collapsed ? 'false' : 'true');
	}

	private syncComposerToggleBtn(): void {
		const btn = this.composerToggleBtn;
		if (!btn) return;
		const hidden = !!this.plugin.settings.dashboardComposerHidden;
		btn.toggleClass('is-active', !hidden);
		btn.setAttr('aria-pressed', hidden ? 'false' : 'true');
	}

	/** 视口过窄时自动收起左侧栏；变宽后若仅因窄宽而收起则恢复。 */
	private syncLeftPaneForViewportWidth(): void {
		if (!this.contentEl.hasClass('csn-dash')) return;
		const narrow = this.isDashViewportNarrow();
		if (narrow) {
			if (
				!this.plugin.settings.dashboardLeftPaneCollapsed &&
				!this.leftPaneKeepOpenWhenNarrow &&
				!this.leftPaneAutoCollapsedForWidth
			) {
				this.leftPaneAutoCollapsedForWidth = true;
				this.applyDashPaneLayout();
			}
			return;
		}
		this.leftPaneKeepOpenWhenNarrow = false;
		if (this.leftPaneAutoCollapsedForWidth) {
			this.leftPaneAutoCollapsedForWidth = false;
			this.applyDashPaneLayout();
		}
	}

	private registerDashViewportWidthObserver(): void {
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			this.syncLeftPaneForViewportWidth();
		});
		ro.observe(this.contentEl);
		this.register(() => ro.disconnect());
		this.syncLeftPaneForViewportWidth();
	}

	private async toggleLeftPaneCollapsed(): Promise<void> {
		if (this.leftPaneAutoCollapsedForWidth) {
			this.leftPaneAutoCollapsedForWidth = false;
			this.leftPaneKeepOpenWhenNarrow = true;
			this.plugin.settings.dashboardLeftPaneCollapsed = false;
		} else {
			const next = !this.plugin.settings.dashboardLeftPaneCollapsed;
			this.plugin.settings.dashboardLeftPaneCollapsed = next;
			this.leftPaneKeepOpenWhenNarrow = !next && this.isDashViewportNarrow();
		}
		this.applyDashPaneLayout();
		await this.plugin.saveSettings();
	}

	private async toggleComposerHidden(): Promise<void> {
		this.plugin.settings.dashboardComposerHidden = !this.plugin.settings.dashboardComposerHidden;
		this.applyDashPaneLayout();
		await this.plugin.saveSettings();
	}

	/** 垂直/水平拖拽分隔条：调整左栏宽或输入区高，松手后写入设置。 */
	private registerDashSplitter(el: HTMLElement, orientation: 'vertical' | 'horizontal'): void {
		this.registerDomEvent(el, 'pointerdown', (evt: PointerEvent) => {
			if (evt.button !== 0) return;
			evt.preventDefault();
			const startX = evt.clientX;
			const startY = evt.clientY;
			const startLeft = clampDashLeftPaneWidth(this.plugin.settings.dashboardLeftPaneWidth);
			const startComposer = clampDashComposerPaneHeight(this.plugin.settings.dashboardComposerPaneHeight);
			el.classList.add('is-dragging');
			el.setPointerCapture(evt.pointerId);

			const onMove = (e: PointerEvent) => {
				if (orientation === 'vertical') {
					if (this.isLeftPaneCollapsed()) return;
					const next = clampDashLeftPaneWidth(startLeft + (e.clientX - startX));
					this.plugin.settings.dashboardLeftPaneWidth = next;
				} else {
					if (this.plugin.settings.dashboardComposerHidden) return;
					const next = clampDashComposerPaneHeight(startComposer + (e.clientY - startY));
					this.plugin.settings.dashboardComposerPaneHeight = next;
				}
				this.applyDashPaneLayout();
			};
			const onUp = (e: PointerEvent) => {
				el.classList.remove('is-dragging');
				try {
					el.releasePointerCapture(e.pointerId);
				} catch {
					/* already released */
				}
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				window.removeEventListener('pointercancel', onUp);
				void this.plugin.saveSettings();
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', onUp);
		});

		this.registerDomEvent(el, 'dblclick', () => {
			if (orientation === 'vertical') {
				this.plugin.settings.dashboardLeftPaneWidth = DASH_LEFT_PANE_WIDTH_DEFAULT;
			} else {
				this.plugin.settings.dashboardComposerPaneHeight = DASH_COMPOSER_PANE_HEIGHT_DEFAULT;
			}
			this.applyDashPaneLayout();
			void this.plugin.saveSettings();
		});
	}

	/** 同步卡片预览区与快速输入编辑区内容缩放（不重渲 Markdown）。 */
	syncViewContentZoomFromSettings(): void {
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		this.gridEl?.querySelectorAll('.csn-list-card').forEach(card => {
			if (card instanceof HTMLElement) {
				card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
			}
		});
		this.applyComposerContentZoom(zoom);
	}

	private applyComposerContentZoom(zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom)): void {
		const host = this.composerHostEl;
		const frame = host?.parentElement;
		const target = frame ?? host;
		if (!target) return;
		target.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
	}

	requestRedraw(): void {
		void this.renderDash();
	}

	/** 设置「每页条数」变更：回到第一页并立即重绘。 */
	resetPageAndRedraw(): void {
		this.listPageIndex = 0;
		this.flushDashRedraw();
	}

	flushDashRedraw(): void {
		this.cancelPendingRefresh();
		void this.renderDash();
	}

	cancelPendingRefresh(): void {
		this.debouncedStructureRefresh?.cancel();
		this.debouncedContentRefresh?.cancel();
	}

	private syncPinButton(card: HTMLElement, path: string, pinnedSet: ReadonlySet<string>): void {
		const pinBtn = card.querySelector('.csn-list-card-pin-btn');
		if (!(pinBtn instanceof HTMLButtonElement)) return;
		const on = pinnedSet.has(normalizePath(path));
		pinBtn.toggleClass('is-active', on);
		pinBtn.setAttr('aria-pressed', on ? 'true' : 'false');
		pinBtn.setAttr('aria-label', on ? t('UNPIN_ARIA') : t('PIN_ARIA'));
	}

	/** 根节点类名控制归档复选框是否可见（与「编辑」按钮联动）。 */
	private syncListArchiveCheckboxEditUI(): void {
		this.contentEl.toggleClass('csn-list-view--archive-checkbox-edit', this.listArchiveCheckboxEditMode);
		if (this.listBulkEditBtn) {
			this.listBulkEditBtn.toggleClass('is-active', this.listArchiveCheckboxEditMode);
			this.listBulkEditBtn.setAttr(
				'aria-pressed',
				this.listArchiveCheckboxEditMode ? 'true' : 'false'
			);
		}
	}

	private syncArchiveChromeOnCard(card: HTMLElement, archived: boolean): void {
		card.setAttr('data-csn-archived', archived ? 'true' : 'false');
		const wrap = card.querySelector('.csn-list-card-archive-wrap');
		const input = card.querySelector('.csn-list-card-archive-checkbox');
		if (wrap instanceof HTMLElement) wrap.toggleClass('is-archived', archived);
		if (input instanceof HTMLInputElement) {
			input.checked = archived;
			input.setAttr(
				'aria-label',
				archived ? t('LIST_CARD_ARCHIVE_CBOX_ARIA_CHECKED') : t('LIST_CARD_ARCHIVE_CBOX_ARIA_UNCHECKED')
			);
		}
	}

	/** 仪表盘本地归档筛选（非 `settings.noteListArchiveFilter`）。 */
	private listShouldRerenderForArchiveState(archived: boolean): boolean {
		const m = this.archiveFilter;
		if (m === 'all') return false;
		if (m === 'unarchived') return archived;
		return !archived;
	}

	private async togglePinForPath(path: string): Promise<void> {
		const p = normalizePath(path);
		const cur = this.plugin.settings.noteListPinnedPaths.map(x => normalizePath(x));
		const i = cur.indexOf(p);
		if (i >= 0) cur.splice(i, 1);
		else cur.unshift(p);
		this.plugin.settings.noteListPinnedPaths = cur;
		await this.plugin.saveSettings();
		this.listPageIndex = 0;
		void this.renderDash();
	}

	private syncCardOverflowClipToolbarBtn(): void {
		if (!this.listCardOverflowClipBtn) return;
		const clip = this.plugin.settings.noteListCardOverflowHidden;
		this.listCardOverflowClipBtn.toggleClass('is-active', clip);
		this.listCardOverflowClipBtn.setAttr('aria-pressed', clip ? 'true' : 'false');
	}

	private syncSortToolbarBtn(): void {
		const sortSpec =
			NOTE_LIST_SORT_SPECS.find(s => s.mode === this.plugin.settings.noteListSort) ??
			NOTE_LIST_SORT_SPECS[0]!;
		if (!this.sortDropdownBtn) return;
		this.sortDropdownBtn.empty();
		setIcon(this.sortDropdownBtn, sortSpec.toolbarIcon ?? NOTE_LIST_SORT_TOOLBAR_ICON);
		const sortTitle = t(sortSpec.titleKey);
		this.sortDropdownBtn.setAttr('aria-label', t('LIST_TOOLBAR_SORT_PREFIX', { title: sortTitle }));
	}

	private openSortDropdownMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const cur = this.plugin.settings.noteListSort;
		for (const spec of NOTE_LIST_SORT_SPECS) {
			menu.addItem(item => {
				item
					.setTitle(t(spec.titleKey))
					.setIcon(spec.menuIcon)
					.setChecked(spec.mode === cur)
					.onClick(() => {
						void this.setListSort(spec.mode);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private async setListSort(sort: NoteListSort): Promise<void> {
		if (this.plugin.settings.noteListSort === sort) return;
		this.plugin.settings.noteListSort = sort;
		await this.plugin.saveSettings();
		this.syncSortToolbarBtn();
		this.listPageIndex = 0;
		void this.renderDash();
	}

	private disposeMarkdownHostForPath(path: string): void {
		const c = this.listCardMarkdownHosts.get(path);
		if (c) {
			this.removeChild(c);
			this.listCardMarkdownHosts.delete(path);
		}
	}

	private disposeAllMarkdownHosts(): void {
		for (const p of [...this.listCardMarkdownHosts.keys()]) {
			this.disposeMarkdownHostForPath(p);
		}
	}

	private ensureMarkdownHostForPath(path: string): Component {
		let c = this.listCardMarkdownHosts.get(path);
		if (!c) {
			c = new Component();
			this.listCardMarkdownHosts.set(path, c);
			this.addChild(c);
		}
		return c;
	}

	private hideCanvasDragBehaviorHint(): void {
		this.canvasDragCanvasHintEl?.remove();
		this.canvasDragCanvasHintEl = null;
		this.cardDragHintKind = 'none';
	}

	private updateCanvasDragBehaviorHintPos(clientX: number, clientY: number): void {
		const el = this.canvasDragCanvasHintEl;
		if (!el) return;
		const m = 16;
		const w = window.innerWidth;
		const h = window.innerHeight;
		const x = Math.min(Math.max(m, clientX + 18), Math.max(m, w - m));
		const y = Math.min(Math.max(m, clientY + 18), Math.max(m, h - m));
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
	}

	private updateCanvasDragBehaviorHintState(ctrlOrCmd: boolean, shift: boolean): void {
		const wrap = this.canvasDragCanvasHintEl;
		if (!wrap || this.cardDragHintKind !== 'canvas') return;
		const plainEl = wrap.querySelector('[data-csn-drag-mode="plain"]');
		const fileRefEl = wrap.querySelector('[data-csn-drag-mode="fileRef"]');
		const shiftEl = wrap.querySelector('[data-csn-drag-mode="deleteOriginal"]');
		if (!(plainEl instanceof HTMLElement)) return;
		if (!(fileRefEl instanceof HTMLElement)) return;
		if (!(shiftEl instanceof HTMLElement)) return;
		const isDeleteOriginal = shift && !ctrlOrCmd;
		const isFileRefOnly = ctrlOrCmd && !shift;
		const isPlain = !isDeleteOriginal && !isFileRefOnly;
		plainEl.toggleClass('is-active', isPlain);
		fileRefEl.toggleClass('is-active', isFileRefOnly);
		shiftEl.toggleClass('is-active', isDeleteOriginal);
	}

	private updateWorkspaceDragBehaviorHintState(ctrlOrCmd: boolean): void {
		const wrap = this.canvasDragCanvasHintEl;
		if (!wrap || this.cardDragHintKind !== 'workspace') return;
		const moveEl = wrap.querySelector('[data-csn-drag-mode="move"]');
		const copyEl = wrap.querySelector('[data-csn-drag-mode="copy"]');
		if (!(moveEl instanceof HTMLElement) || !(copyEl instanceof HTMLElement)) return;
		moveEl.toggleClass('is-active', !ctrlOrCmd);
		copyEl.toggleClass('is-active', ctrlOrCmd);
	}

	private updateActiveCardDragHint(evt: DragEvent): void {
		this.updateCanvasDragBehaviorHintPos(evt.clientX, evt.clientY);
		if (this.cardDragHintKind === 'workspace') {
			this.updateWorkspaceDragBehaviorHintState(evt.ctrlKey || evt.metaKey);
			return;
		}
		if (this.cardDragHintKind === 'canvas') {
			this.updateCanvasDragBehaviorHintState(evt.ctrlKey || evt.metaKey, evt.shiftKey);
		}
	}

	/** 仪表盘拖到工作区：移动 / Ctrl 复制。 */
	private showWorkspaceDragBehaviorHint(selectedCount: number, evt?: DragEvent): void {
		this.hideCanvasDragBehaviorHint();
		const wrap = document.body.createDiv({ cls: 'csn-canvas-drag-hint', attr: { 'aria-live': 'polite' } });
		this.canvasDragCanvasHintEl = wrap;
		this.cardDragHintKind = 'workspace';
		wrap.createDiv({ cls: 'csn-canvas-drag-hint-title', text: t('DASH_DRAG_WS_HINT_TITLE') });
		if (selectedCount > 1) {
			wrap.createDiv({
				cls: 'csn-canvas-drag-hint-batch',
				text: t('DASH_DRAG_WS_HINT_BATCH', { n: selectedCount })
			});
		}
		const ul = wrap.createEl('ul', { cls: 'csn-canvas-drag-hint-list' });
		ul.createEl('li', { text: t('DASH_DRAG_WS_HINT_MOVE'), attr: { 'data-csn-drag-mode': 'move' } });
		ul.createEl('li', { text: t('DASH_DRAG_WS_HINT_COPY'), attr: { 'data-csn-drag-mode': 'copy' } });
		wrap.createDiv({ cls: 'csn-canvas-drag-hint-note', text: t('DASH_DRAG_WS_HINT_NOTE') });
		if (evt) {
			this.updateCanvasDragBehaviorHintPos(evt.clientX, evt.clientY);
			this.updateWorkspaceDragBehaviorHintState(evt.ctrlKey || evt.metaKey);
		} else {
			this.updateWorkspaceDragBehaviorHintState(false);
		}
	}

	/** 从仪表盘拖向 Canvas（或编辑器）期间的按键说明：跟随指针，不拦截指针。 */
	private showCanvasDragBehaviorHint(selectedCount: number, evt?: DragEvent): void {
		this.hideCanvasDragBehaviorHint();
		const wrap = document.body.createDiv({ cls: 'csn-canvas-drag-hint', attr: { 'aria-live': 'polite' } });
		this.canvasDragCanvasHintEl = wrap;
		this.cardDragHintKind = 'canvas';
		wrap.createDiv({ cls: 'csn-canvas-drag-hint-title', text: t('LIST_DRAG_CANVAS_HINT_TITLE') });
		if (selectedCount > 1) {
			wrap.createDiv({
				cls: 'csn-canvas-drag-hint-batch',
				text: t('LIST_DRAG_CANVAS_HINT_BATCH', { n: selectedCount })
			});
		}
		const ul = wrap.createEl('ul', { cls: 'csn-canvas-drag-hint-list' });
		ul.createEl('li', { text: t('LIST_DRAG_CANVAS_HINT_PLAIN'), attr: { 'data-csn-drag-mode': 'plain' } });
		ul.createEl('li', {
			text: t('LIST_DRAG_CANVAS_HINT_CTRL_OR_CMD'),
			attr: { 'data-csn-drag-mode': 'fileRef' }
		});
		ul.createEl('li', {
			text: t('LIST_DRAG_CANVAS_HINT_SHIFT'),
			attr: { 'data-csn-drag-mode': 'deleteOriginal' }
		});
		wrap.createDiv({ cls: 'csn-canvas-drag-hint-note', text: t('LIST_DRAG_CANVAS_HINT_NOTE_LINK') });
		if (evt) {
			this.updateCanvasDragBehaviorHintPos(evt.clientX, evt.clientY);
			this.updateCanvasDragBehaviorHintState(evt.ctrlKey || evt.metaKey, evt.shiftKey);
		} else {
			this.updateCanvasDragBehaviorHintState(false, false);
		}
	}

	private beginCanvasDropSessionForFiles(items: Array<{ file: TFile; color: StickyColorId }>): void {
		const CANVAS_COLOR_BY_STICKY: Record<StickyColorId, string | null> = {
			default: null,
			yellow: '#f5e6a3',
			pink: '#f5c2d6',
			mint: '#a8e6cf',
			blue: '#a8d4f0',
			lavender: '#d4c4f5',
			gray: '#d8d8d8'
		};
		type CanvasViewLike = {
			containerEl?: HTMLElement;
			file?: TFile;
			canvas?: {
				posFromEvt: (evt: DragEvent) => unknown;
				createTextNode?: (arg: {
					text: string;
					pos: unknown;
					save: boolean;
					size?: { width: number; height: number };
					focus?: boolean;
				}) => {
					color?: string;
					onResizeDblclick?: (event: MouseEvent, position: 'top' | 'bottom' | 'left' | 'right') => void;
				};
				createFileNode: (arg: {
					file: TFile;
					pos: unknown;
					save: boolean;
					size?: { width: number; height: number };
					focus?: boolean;
				}) => {
					color?: string;
					onResizeDblclick?: (event: MouseEvent, position: 'top' | 'bottom' | 'left' | 'right') => void;
				};
				requestSave?: () => Promise<void>;
				requestFrame?: () => Promise<void>;
				selection?: Set<unknown>;
				zoomToSelection?: () => void;
			};
		};
		const maybeApplyCanvasNodeColor = (
			node: { color?: string } | null | undefined,
			stickyColor: StickyColorId
		): void => {
			const canvasColor = this.plugin.settings.canvasLinkMatchColor
				? CANVAS_COLOR_BY_STICKY[stickyColor]
				: null;
			if (!node || !canvasColor) return;
			node.color = canvasColor;
		};
		const autoFitHeightForNodes = async (
			v: CanvasViewLike,
			nodes: Array<{ onResizeDblclick?: (e: MouseEvent, pos: 'top' | 'bottom' | 'left' | 'right') => void }>
		): Promise<void> => {
			if (!this.plugin.settings.canvasLinkAutoFitHeight) return;
			if (nodes.length > 1) return;
			const fitTargets = nodes.filter(n => typeof n.onResizeDblclick === 'function');
			if (fitTargets.length === 0) return;
			for (let fr = 0; fr < 2; fr++) {
				await new Promise<void>(r => requestAnimationFrame(() => r()));
			}
			for (const n of fitTargets) {
				n.onResizeDblclick?.(new MouseEvent('dblclick'), 'bottom');
				await v.canvas?.requestFrame?.();
			}
			await v.canvas?.requestSave?.();
		};
		const offsetPos = (pos: unknown, dx: number, dy: number): unknown => {
			if (!pos || typeof pos !== 'object') return pos;
			const anyPos = pos as { x?: unknown; y?: unknown };
			if (typeof anyPos.x === 'number' && typeof anyPos.y === 'number') {
				return { x: anyPos.x + dx, y: anyPos.y + dy };
			}
			return pos;
		};
		const getCanvasViewFromDropEvent = (evt: DragEvent): CanvasViewLike | null => {
			const target = evt.target;
			if (!(target instanceof Node)) return null;
			for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
				const v = leaf.view as CanvasViewLike;
				if (v.containerEl instanceof HTMLElement && v.containerEl.contains(target)) return v;
			}
			return null;
		};
		const cleanup = (): void => {
			window.removeEventListener('drop', onDropCapture, true);
			window.removeEventListener('dragend', onDragEndCapture, true);
			window.removeEventListener('dragover', onDragOverCapture, true);
		};
		const onDragOverCapture = (evt: DragEvent): void => {
			if (this.cardDragHintKind === 'none') return;
			this.updateActiveCardDragHint(evt);
		};
		const onDropCapture = (evt: DragEvent): void => {
			const v = getCanvasViewFromDropEvent(evt);
			if (!v?.canvas) return;
			evt.preventDefault();
			evt.stopPropagation();
			const pos = v.canvas.posFromEvt(evt);
			const size = {
				width: this.plugin.settings.canvasLinkNodeWidth,
				height: this.plugin.settings.canvasLinkNodeHeight
			};

			void (async () => {
				const ctrlOrCmd = evt.ctrlKey || evt.metaKey;
				const isDeleteOriginal = evt.shiftKey && !ctrlOrCmd;
				const isFileRefOnly = ctrlOrCmd && !evt.shiftKey;

				const createdNodes: Array<{
					onResizeDblclick?: (e: MouseEvent, p: 'top' | 'bottom' | 'left' | 'right') => void;
				}> = [];
				const gap = Math.max(0, Math.min(500, Math.round(this.plugin.settings.canvasLinkBatchGridGap)));
				const maxPerRow = Math.max(1, Math.min(50, Math.round(this.plugin.settings.canvasLinkBatchMaxPerRow)));
				const cellW = Math.max(1, Math.round(size.width)) + gap;
				const cellH = Math.max(1, Math.round(size.height)) + gap;
				for (let i = 0; i < items.length; i++) {
					const it = items[i]!;
					const col = i % maxPerRow;
					const row = Math.floor(i / maxPerRow);
					const p2 = offsetPos(pos, col * cellW, row * cellH);
					let node:
						| {
								color?: string;
								onResizeDblclick?: (e: MouseEvent, p: 'top' | 'bottom' | 'left' | 'right') => void;
						  }
						| undefined;

					if (isFileRefOnly) {
						node = v.canvas?.createFileNode({
							file: it.file,
							pos: p2,
							size,
							focus: false,
							save: true
						});
					} else {
						const text = await this.app.vault.cachedRead(it.file);
						node = v.canvas?.createTextNode?.({
							text,
							pos: p2,
							size,
							focus: false,
							save: true
						});
					}

					maybeApplyCanvasNodeColor(node, it.color);
					if (node) createdNodes.push(node);
				}

				try {
					v.canvas?.selection?.clear();
					for (const n of createdNodes) {
						v.canvas?.selection?.add(n);
					}
					await v.canvas?.requestFrame?.();
				} catch {
					// ignore
				}

				void v.canvas?.requestSave?.();
				await autoFitHeightForNodes(v, createdNodes);

				if (
					this.plugin.settings.canvasLinkZoomToSelection &&
					createdNodes.length > 0 &&
					v.canvas?.zoomToSelection
				) {
					for (let fr = 0; fr < 3; fr++) {
						await new Promise<void>(r => requestAnimationFrame(() => r()));
					}
					try {
						await v.canvas.requestFrame?.();
						v.canvas.zoomToSelection();
						await v.canvas.requestFrame?.();
					} catch {
						// ignore
					}
				}

				if (isDeleteOriginal) {
					for (const it of items) {
						await this.app.fileManager.trashFile(it.file);
					}
				}
			})()
				.catch(() => undefined)
				.finally(() => {
					cleanup();
				});
			return;
			cleanup();
		};
		const onDragEndCapture = (): void => {
			cleanup();
		};
		window.addEventListener('dragover', onDragOverCapture, true);
		window.addEventListener('drop', onDropCapture, true);
		window.addEventListener('dragend', onDragEndCapture, true);
	}

	private getRenderedListCardPathsInOrder(): string[] {
		const container = this.gridEl;
		if (!container) return [];
		const out: string[] = [];
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (p) out.push(normalizePath(p));
		}
		return out;
	}

	private syncListCardSelectionChrome(): void {
		const container = this.gridEl;
		if (!container) return;
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (!p) continue;
			el.toggleClass('is-selected', this.selectedListNotePaths.has(normalizePath(p)));
		}
	}

	private collectWorkspaceIdsForSelectedCards(): string[] {
		const ids: string[] = [];
		const seen = new Set<string>();
		const pushFile = (file: TFile): void => {
			for (const id of this.plugin.stickies.getWorkspaceIdsContainingFile(file)) {
				if (seen.has(id)) continue;
				seen.add(id);
				ids.push(id);
			}
		};
		const prefer = this.lastSelectedListNotePath;
		if (prefer) {
			const abs = this.app.vault.getAbstractFileByPath(prefer);
			if (abs instanceof TFile) pushFile(abs);
		}
		for (const p of this.selectedListNotePaths) {
			if (p === prefer) continue;
			const abs = this.app.vault.getAbstractFileByPath(p);
			if (abs instanceof TFile) pushFile(abs);
		}
		return ids;
	}

	private applyCardFocusWorkspaceChrome(scroll: boolean): void {
		const host = this.treeEl;
		if (!host) return;
		const focus = new Set(this.cardFocusWorkspaceIds);
		let first: HTMLElement | null = null;
		for (const el of Array.from(host.querySelectorAll<HTMLElement>('.csn-dash-tree-ws[data-csn-ws-id]'))) {
			const id = el.dataset.csnWsId;
			const on = !!id && focus.has(id);
			el.toggleClass('is-card-focus', on);
			if (on && !first) first = el;
		}
		if (scroll && first) {
			first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}

	/** 选中卡片后展开所属分组并滚动到对应工作区，不改筛选。 */
	private revealCardFocusWorkspacesInTree(): void {
		if (!this.plugin.settings.dashboardCardFocusWorkspace) {
			this.cardFocusWorkspaceIds = [];
			this.applyCardFocusWorkspaceChrome(false);
			return;
		}
		this.cardFocusWorkspaceIds = this.collectWorkspaceIdsForSelectedCards();
		if (this.cardFocusWorkspaceIds.length === 0) {
			this.applyCardFocusWorkspaceChrome(false);
			return;
		}
		if (this.collapsedLeftPanels.has('workspace')) {
			this.collapsedLeftPanels.delete('workspace');
			this.persistCollapsedLeftPanels();
			this.applyLeftPanelCollapsedClass('workspace');
		}
		let expanded = false;
		if (!this.wsTreeShowArchived) {
			const file = this.plugin.stickies.workspaces;
			const tabGroups = file.tabGroups;
			for (const wsId of this.cardFocusWorkspaceIds) {
				const ws = file.workspaces.find(w => w.id === wsId);
				if (!ws) continue;
				const groupId = resolveWorkspaceTabGroupId(ws, tabGroups);
				if (groupId === WS_TAB_GROUP_UNGROUPED_ID) continue;
				if (this.collapsedGroupIds.has(groupId)) {
					this.collapsedGroupIds.delete(groupId);
					expanded = true;
				}
			}
		}
		if (expanded) {
			this.persistCollapsedGroups();
			this.renderWorkspaceTree();
			this.applyCardFocusWorkspaceChrome(true);
			return;
		}
		this.applyCardFocusWorkspaceChrome(true);
	}

	private async toggleWsTreeCardFocus(): Promise<void> {
		this.plugin.settings.dashboardCardFocusWorkspace = !this.plugin.settings.dashboardCardFocusWorkspace;
		this.syncWsTreeCardFocusBtn();
		await this.plugin.saveSettings();
		if (this.plugin.settings.dashboardCardFocusWorkspace) {
			this.revealCardFocusWorkspacesInTree();
		} else {
			this.cardFocusWorkspaceIds = [];
			this.applyCardFocusWorkspaceChrome(false);
		}
	}

	private syncWsTreeCardFocusBtn(): void {
		const btn = this.wsTreeCardFocusBtn;
		if (!btn) return;
		const on = !!this.plugin.settings.dashboardCardFocusWorkspace;
		btn.toggleClass('is-active', on);
		btn.setAttr('aria-pressed', on ? 'true' : 'false');
		btn.setAttr('aria-label', t(on ? 'DASH_WS_CARD_FOCUS_ON_ARIA' : 'DASH_WS_CARD_FOCUS_OFF_ARIA'));
	}

	private beginStickyCardDrag(evt: DragEvent, card: HTMLElement): boolean {
		const path = card.dataset.csnNotePath;
		if (!path) return false;
		const normPath = normalizePath(path);
		const selected =
			this.selectedListNotePaths.size > 0 && this.selectedListNotePaths.has(normPath)
				? [...this.selectedListNotePaths]
				: [normPath];

		const items: Array<{ file: TFile; color: StickyColorId }> = [];
		for (const p of selected) {
			const abs = this.app.vault.getAbstractFileByPath(p);
			if (!(abs instanceof TFile)) continue;
			const el = this.gridEl?.querySelector(`.csn-list-card[data-csn-note-path="${CSS.escape(p)}"]`);
			const rawColor =
				el instanceof HTMLElement ? (el.dataset.csnListColor as StickyColorId | undefined) : undefined;
			items.push({ file: abs, color: rawColor ?? 'default' });
		}
		if (items.length === 0) return false;
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		const md = this.app.fileManager.generateMarkdownLink(items[0]!.file, sourcePath);
		const dt = evt.dataTransfer;
		if (!dt) return false;
		dt.setData('text/plain', md);
		setStickyPathsDragData(
			dt,
			items.map(it => normalizePath(it.file.path))
		);
		dt.effectAllowed = 'copyMove';
		this.wsTreeDragKind = 'sticky';
		this.showWorkspaceDragBehaviorHint(items.length, evt);
		this.beginCanvasDropSessionForFiles(items);
		return true;
	}

	private isListCardHeadMenuHitExcluded(hit: Element): boolean {
		return !!(
			hit.closest('.csn-list-card-pin-btn') ||
			hit.closest('.csn-list-card-menu-btn') ||
			hit.closest('.csn-list-card-archive-wrap') ||
			hit.closest('.csn-list-card-drag-handle')
		);
	}

	private getCardElForPath(path: string): HTMLElement | null {
		const norm = normalizePath(path);
		const el = this.gridEl?.querySelector(`.csn-list-card[data-csn-note-path="${CSS.escape(norm)}"]`);
		return el instanceof HTMLElement ? el : null;
	}

	private titleWithBatchCount(base: string, n: number): string {
		return n > 1 ? `${base} (${n})` : base;
	}

	private resolveMenuTargetFiles(anchorPath: string): TFile[] {
		const norm = normalizePath(anchorPath);
		const paths =
			this.selectedListNotePaths.size > 0 && this.selectedListNotePaths.has(norm)
				? [...this.selectedListNotePaths]
				: [norm];
		const files: TFile[] = [];
		for (const p of paths) {
			const abs = this.app.vault.getAbstractFileByPath(p);
			if (abs instanceof TFile) files.push(abs);
		}
		return files;
	}

	private getListCardColorFromDom(file: TFile): StickyColorId | null {
		const card = this.getCardElForPath(file.path);
		if (!card) return null;
		const raw = card.dataset.csnListColor;
		return raw && raw.length > 0 ? (raw as StickyColorId) : null;
	}

	private getListCardArchivedFromDom(file: TFile): boolean | null {
		const card = this.getCardElForPath(file.path);
		if (!card) return null;
		return card.dataset.csnArchived === 'true';
	}

	private ensureListSelectionForContextMenu(anchorPath: string): void {
		const norm = normalizePath(anchorPath);
		if (!this.selectedListNotePaths.has(norm)) {
			this.selectedListNotePaths.clear();
			this.selectedListNotePaths.add(norm);
			this.lastSelectedListNotePath = norm;
			this.syncListCardSelectionChrome();
			this.revealCardFocusWorkspacesInTree();
		}
	}

	private async trashMenuTargetFiles(files: TFile[]): Promise<void> {
		for (const f of files) {
			this.selectedListNotePaths.delete(normalizePath(f.path));
		}
		if (files.length === 0) return;
		for (const f of files) {
			this.plugin.muteStickyListModifyPaths.add(f.path);
		}
		this.plugin.cancelStickyListDebouncedRefresh();
		try {
			for (const f of files) {
				await this.plugin.stickies.trashStickyNoteFile(f, { skipListRefresh: true });
			}
			this.plugin.refreshStickyListIfOpen({ tree: 'counts' });
		} finally {
			for (const f of files) {
				const p = f.path;
				window.setTimeout(() => this.plugin.muteStickyListModifyPaths.delete(p), 400);
			}
		}
	}

	private registerGridDelegatedEvents(): void {
		if (this.gridDelegatedEvents || !this.gridEl) return;
		this.gridDelegatedEvents = true;

		this.registerDomEvent(this.gridEl, 'dragstart', (evt: DragEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const dragHandleEl = hit.closest('.csn-list-card-drag-handle');
			if (!dragHandleEl || !this.gridEl?.contains(dragHandleEl)) {
				/* 仅拖拽符可拖；头部其它区域禁止原生拖拽 */
				if (hit.closest('.csn-list-card-head')) evt.preventDefault();
				return;
			}
			const card = dragHandleEl.closest('.csn-list-card');
			if (!(card instanceof HTMLElement)) return;
			if (!this.beginStickyCardDrag(evt, card)) evt.preventDefault();
		});

		this.registerDomEvent(this.gridEl, 'dragend', () => {
			this.wsTreeDragKind = 'none';
			this.clearTreeDropTargets();
			this.hideCanvasDragBehaviorHint();
		});

		this.registerDomEvent(this.gridEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const pinBtn = hit.closest('.csn-list-card-pin-btn');
			if (pinBtn && this.gridEl?.contains(pinBtn)) {
				const card = pinBtn.closest('.csn-list-card');
				if (!card) return;
				const path = (card as HTMLElement).dataset.csnNotePath;
				if (!path) return;
				evt.preventDefault();
				evt.stopPropagation();
				void this.togglePinForPath(path);
				return;
			}
			const btn = hit.closest('.csn-list-card-menu-btn');
			if (!btn || !this.gridEl?.contains(btn)) return;
			const card = btn.closest('.csn-list-card');
			if (!card) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.showCardMenu(evt, path, card as HTMLElement);
		});

		this.registerDomEvent(this.gridEl, 'contextmenu', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			if (this.isListCardHeadMenuHitExcluded(hit)) return;
			const head = hit.closest('.csn-list-card-head');
			if (!head || !this.gridEl?.contains(head)) return;
			const card = head.closest('.csn-list-card');
			if (!card) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			this.ensureListSelectionForContextMenu(path);
			void this.showCardMenu(evt, path, card as HTMLElement);
		});

		this.registerDomEvent(this.gridEl, 'mousedown', (evt: MouseEvent) => {
			if (evt.button !== 0) return;
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			if (
				hit.closest('.csn-list-card-pin-btn') ||
				hit.closest('.csn-list-card-menu-btn') ||
				hit.closest('.csn-list-card-archive-wrap') ||
				hit.closest('.csn-list-card-drag-handle')
			) {
				return;
			}
			const card = hit.closest('.csn-list-card');
			if (!card || !this.gridEl?.contains(card)) {
				if (this.selectedListNotePaths.size > 0) {
					this.selectedListNotePaths.clear();
					this.lastSelectedListNotePath = null;
					this.syncListCardSelectionChrome();
					this.revealCardFocusWorkspacesInTree();
				}
				return;
			}
			const rawPath = (card as HTMLElement).dataset.csnNotePath;
			if (!rawPath) return;
			const path = normalizePath(rawPath);

			const ctrl = evt.ctrlKey || evt.metaKey;
			const shift = evt.shiftKey;
			const order = this.getRenderedListCardPathsInOrder();

			if (shift && this.lastSelectedListNotePath) {
				const a = order.indexOf(this.lastSelectedListNotePath);
				const b = order.indexOf(path);
				if (a !== -1 && b !== -1) {
					const [s, e] = a <= b ? [a, b] : [b, a];
					this.selectedListNotePaths.clear();
					for (let i = s; i <= e; i++) this.selectedListNotePaths.add(order[i]!);
				} else {
					this.selectedListNotePaths.clear();
					this.selectedListNotePaths.add(path);
				}
			} else if (ctrl) {
				if (this.selectedListNotePaths.has(path)) this.selectedListNotePaths.delete(path);
				else this.selectedListNotePaths.add(path);
				this.lastSelectedListNotePath = path;
			} else {
				this.selectedListNotePaths.clear();
				this.selectedListNotePaths.add(path);
				this.lastSelectedListNotePath = path;
			}
			this.syncListCardSelectionChrome();
			this.revealCardFocusWorkspacesInTree();
		});

		this.registerDomEvent(this.gridEl, 'change', (evt: Event) => {
			const t = evt.target;
			if (!(t instanceof HTMLInputElement) || !t.classList.contains('csn-list-card-archive-checkbox')) return;
			const card = t.closest('.csn-list-card');
			if (!card || !this.gridEl?.contains(card)) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			const wantArchived = t.checked;
			void this.plugin.stickies.setStickyArchivedForFile(f, wantArchived).then(() => {
				if (this.listShouldRerenderForArchiveState(wantArchived)) {
					void this.renderDash();
				} else {
					this.syncArchiveChromeOnCard(card as HTMLElement, wantArchived);
				}
			});
		});

		this.registerDomEvent(this.gridEl, 'dblclick', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			if (
				hit.closest('.csn-list-card-pin-btn') ||
				hit.closest('.csn-list-card-menu-btn') ||
				hit.closest('.csn-list-card-archive-wrap')
			) {
				return;
			}
			const card = hit.closest('.csn-list-card');
			if (!card || !this.gridEl?.contains(card)) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.plugin.openStickyForFile(f);
		});
	}

	private pathUnderStickyFolder(path: string): boolean {
		const root = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const p = normalizePath(path);
		return p === root || p.startsWith(`${root}/`);
	}

	private registerVaultRefresh(): void {
		this.debouncedStructureRefresh = debounce(
			() => {
				this.listPageIndex = 0;
				void this.renderDash();
			},
			80,
			false
		);
		this.debouncedContentRefresh = debounce(() => {
			void this.renderDash();
		}, 280, false);
		this.register(() => this.cancelPendingRefresh());
		this.registerEvent(
			this.app.vault.on('create', (f: TAbstractFile) => {
				if (this.plugin.muteStickyListModifyPaths.has(f.path)) return;
				if (this.pathUnderStickyFolder(f.path)) this.debouncedStructureRefresh?.();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (f: TAbstractFile) => {
				if (this.plugin.muteStickyListModifyPaths.has(f.path)) return;
				if (this.pathUnderStickyFolder(f.path)) this.debouncedStructureRefresh?.();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
				if (
					this.plugin.muteStickyListModifyPaths.has(f.path) ||
					this.plugin.muteStickyListModifyPaths.has(oldPath)
				) {
					return;
				}
				if (this.pathUnderStickyFolder(f.path) || this.pathUnderStickyFolder(oldPath)) {
					this.debouncedStructureRefresh?.();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (f: TAbstractFile) => {
				if (f instanceof TFile && f.extension === 'md' && this.pathUnderStickyFolder(f.path)) {
					if (this.plugin.muteStickyListModifyPaths.has(f.path)) return;
					this.debouncedContentRefresh?.();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', file => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.pathUnderStickyFolder(file.path)) return;
				if (this.plugin.muteStickyListModifyPaths.has(file.path)) return;
				this.debouncedContentRefresh?.();
			})
		);
	}

	async onOpen(): Promise<void> {
		/* 进入仪表盘即关闭当前激活的便笺工作区会话 */
		await this.plugin.stickies.deselectActiveStickyWorkspace();

		const root = this.contentEl;
		root.empty();
		root.addClass('csn-dash');
		this.applyDashPaneLayout();

		/* 先左右栏，再各自上下：左=日历+区域管理+工作区树；右=输入区+网格 */
		const colLeft = root.createDiv({ cls: 'csn-dash-col csn-dash-col-left' });

		this.calendarEl = colLeft.createDiv({ cls: 'csn-dash-calendar' });

		const areaMount = this.mountLeftPanel(colLeft, 'area', t('DASH_AREA_LABEL'), {
			headExtra: head => {
				const actions = head.createDiv({ cls: 'csn-dash-ws-actions csn-dash-area-vis-wrap' });
				this.areaVisibilityBtn = actions.createEl('button', {
					type: 'button',
					cls: 'clickable-icon csn-dash-ws-action-btn',
					attr: {
						'aria-label': t('DASH_AREA_VISIBILITY_ARIA'),
						'aria-haspopup': 'true',
						'aria-expanded': 'false'
					}
				});
				setIcon(this.areaVisibilityBtn, 'eye');
				this.registerDomEvent(this.areaVisibilityBtn, 'click', (evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.toggleAreaVisibilityPanel();
				});
				this.buildAreaVisibilityPanel(actions);
			}
		});
		this.areaPanelEl = areaMount.panel;
		this.areaNavEl = areaMount.body;
		this.areaNavEl.addClass('csn-dash-area-nav');
		this.areaNavEl.setAttr('role', 'navigation');
		this.areaNavEl.setAttr('aria-label', t('DASH_AREA_LABEL'));
		this.ensureVisibleAreaMode();

		const wsMount = this.mountLeftPanel(colLeft, 'workspace', t('DASH_WS_TREE_TITLE'), {
			grow: true,
			headExtra: head => {
				const wsActions = head.createDiv({ cls: 'csn-dash-ws-actions' });
				this.wsTreeSortBtn = wsActions.createEl('button', {
					type: 'button',
					cls: 'clickable-icon csn-dash-ws-action-btn',
					attr: { 'aria-label': t('DASH_WS_SORT_ARIA'), 'aria-haspopup': 'menu' }
				});
				setIcon(this.wsTreeSortBtn, 'arrow-up-down');
				this.registerDomEvent(this.wsTreeSortBtn, 'click', (evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.openWsTreeSortMenu(evt);
				});
				this.wsTreeCollapseBtn = wsActions.createEl('button', {
					type: 'button',
					cls: 'clickable-icon csn-dash-ws-action-btn',
					attr: { 'aria-label': t('DASH_WS_COLLAPSE_ALL_ARIA') }
				});
				setIcon(this.wsTreeCollapseBtn, 'chevrons-down-up');
				this.registerDomEvent(this.wsTreeCollapseBtn, 'click', (evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.toggleWsTreeCollapseAll();
				});
				this.wsTreeCardFocusBtn = wsActions.createEl('button', {
					type: 'button',
					cls: 'clickable-icon csn-dash-ws-action-btn',
					attr: {
						'aria-label': t('DASH_WS_CARD_FOCUS_ON_ARIA'),
						'aria-pressed': 'true'
					}
				});
				setIcon(this.wsTreeCardFocusBtn, 'crosshair');
				this.registerDomEvent(this.wsTreeCardFocusBtn, 'click', (evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
					void this.toggleWsTreeCardFocus();
				});
				const newWsBtn = wsActions.createEl('button', {
					type: 'button',
					cls: 'clickable-icon csn-dash-ws-add-btn',
					attr: { 'aria-label': t('DASH_WS_NEW_ARIA') }
				});
				this.wsTreeAddBtn = newWsBtn;
				setIcon(newWsBtn, 'plus');
				this.registerDomEvent(newWsBtn, 'click', (evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
					if (this.wsTreeShowArchived) void this.openNewArchivedGroupModal();
					else void this.openNewGroupModal();
				});
			}
		});
		this.wsPanelEl = wsMount.panel;
		const left = wsMount.body;
		left.addClass('csn-dash-left');
		this.syncWsTreeCollapseBtn();
		this.syncWsTreeCardFocusBtn();
		this.treeEl = left.createDiv({ cls: 'csn-dash-ws-tree' });
		const wsFilter = left.createDiv({ cls: 'csn-dash-ws-filter' });
		const wsFilterRow = wsFilter.createDiv({ cls: 'csn-dash-ws-filter-row' });
		const wsFilterInner = wsFilterRow.createDiv({ cls: 'csn-dash-ws-filter-inner' });
		const wsFilterIcon = wsFilterInner.createSpan({
			cls: 'csn-dash-ws-filter-icon',
			attr: { 'aria-hidden': 'true' }
		});
		setIcon(wsFilterIcon, 'filter');
		this.wsTreeFilterInput = wsFilterInner.createEl('input', {
			type: 'text',
			cls: 'csn-dash-ws-filter-input',
			attr: {
				placeholder: t('DASH_WS_FILTER_PLACEHOLDER'),
				spellcheck: 'false',
				autocomplete: 'off',
				'aria-label': t('DASH_WS_FILTER_PLACEHOLDER')
			}
		});
		this.wsTreeShowArchivedBtn = wsFilterRow.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-ws-action-btn csn-dash-ws-archived-toggle',
			attr: {
				'aria-label': t('DASH_WS_SHOW_ARCHIVED_ARIA'),
				'aria-pressed': 'false'
			}
		});
		setIcon(this.wsTreeShowArchivedBtn, 'archive');
		this.registerDomEvent(this.wsTreeShowArchivedBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleWsTreeShowArchived();
		});
		const debouncedWsFilter = debounce(
			() => {
				this.wsTreeFilterQuery = this.wsTreeFilterInput?.value ?? '';
				this.renderWorkspaceTree();
			},
			100,
			true
		);
		this.registerDomEvent(this.wsTreeFilterInput, 'input', () => debouncedWsFilter());
		this.syncWsTreeShowArchivedBtn();

		const splitV = root.createEl('div', {
			cls: 'csn-dash-splitter csn-dash-splitter--v',
			attr: {
				role: 'separator',
				'aria-orientation': 'vertical',
				'aria-label': t('DASH_SPLITTER_LR'),
				tabindex: '0'
			}
		});
		this.registerDashSplitter(splitV, 'vertical');

		const colRight = root.createDiv({ cls: 'csn-dash-col csn-dash-col-right' });

		const composerWrap = colRight.createDiv({ cls: 'csn-dash-composer' });
		const composerFrame = composerWrap.createDiv({
			cls: 'csn-dash-composer-editor',
			attr: { 'aria-label': t('DASH_COMPOSER_PLACEHOLDER') }
		});
		/* 与 Kanban 一致：CM 挂到轻量容器，勿直接把 markdown-source-view 当构造容器 */
		this.composerHostEl = composerFrame.createDiv({ cls: 'csn-dash-composer-cm cm-table-widget' });
		this.mountComposerEditor();
		this.registerDomEvent(composerFrame, 'click', (evt: MouseEvent) => {
			const tEl = evt.target;
			if (!(tEl instanceof Element)) return;
			if (tEl.closest('.csn-dash-composer-actions')) return;
			if (tEl.closest('.cm-editor')) return;
			this.composerEditor?.focus();
			this.composerFallbackEl?.focus();
		});
		const actions = composerWrap.createDiv({ cls: 'csn-dash-composer-actions' });
		this.composerColorWrapEl = actions.createDiv({ cls: 'csn-dash-composer-color-wrap' });
		this.composerPaletteEl = this.composerColorWrapEl.createDiv({
			cls: 'csn-dash-composer-palette',
			attr: { role: 'group', 'aria-label': t('DASH_COMPOSER_COLOR_ARIA') }
		});
		this.composerColorSwatchBtns.clear();
		for (const c of SHEET_COLOR_ORDER) {
			const sw = this.composerPaletteEl.createEl('button', {
				type: 'button',
				cls: 'csn-dash-composer-swatch',
				attr: {
					'data-csn-color': c.id,
					'aria-label': t(c.labelKey),
					title: t(c.labelKey)
				}
			});
			this.composerColorSwatchBtns.set(c.id, sw);
			this.registerDomEvent(sw, 'click', (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.composerCreateColor = c.id;
				this.syncComposerColorBtn();
				this.closeComposerColorPalette();
			});
		}
		this.composerColorBtn = this.composerColorWrapEl.createEl('button', {
			type: 'button',
			cls: 'csn-dash-composer-color',
			attr: {
				'aria-label': t('DASH_COMPOSER_COLOR_ARIA'),
				'aria-haspopup': 'true',
				'aria-expanded': 'false',
				'data-csn-color': this.composerCreateColor
			}
		});
		setIcon(this.composerColorBtn, 'palette');
		this.registerDomEvent(this.composerColorWrapEl, 'mouseenter', () => {
			this.openComposerColorPalette();
		});
		this.registerDomEvent(this.composerColorWrapEl, 'mouseleave', () => {
			this.closeComposerColorPalette();
		});
		this.registerDomEvent(this.composerColorBtn, 'focus', () => {
			this.openComposerColorPalette();
		});
		this.registerDomEvent(this.composerColorBtn, 'click', (evt: MouseEvent) => {
			/* 悬停已展开；点击仅阻止冒泡到输入区，避免收起/抢焦点 */
			evt.preventDefault();
			evt.stopPropagation();
		});
		this.composerDoneBtn = actions.createEl('button', {
			type: 'button',
			cls: 'csn-dash-composer-done',
			attr: { 'aria-label': t('DASH_COMPOSER_DONE_ARIA') }
		});
		setIcon(this.composerDoneBtn.createSpan({ cls: 'csn-dash-composer-done-icon' }), 'check');
		this.composerDoneBtn.createSpan({
			cls: 'csn-dash-composer-done-label',
			text: t('DASH_COMPOSER_DONE')
		});
		this.registerDomEvent(this.composerDoneBtn, 'click', () => {
			void this.commitComposer();
		});
		this.syncComposerColorBtn();

		const splitH = colRight.createEl('div', {
			cls: 'csn-dash-splitter csn-dash-splitter--h',
			attr: {
				role: 'separator',
				'aria-orientation': 'horizontal',
				'aria-label': t('DASH_SPLITTER_COMPOSER'),
				tabindex: '0'
			}
		});
		this.registerDashSplitter(splitH, 'horizontal');

		const main = colRight.createDiv({ cls: 'csn-dash-main' });

		const toolBar = main.createDiv({ cls: 'csn-dash-tool-bar' });
		const filters = toolBar.createDiv({ cls: 'csn-dash-filters' });

		const attrRow = filters.createDiv({ cls: 'csn-dash-attr' });
		attrRow.createSpan({ cls: 'csn-dash-filter-label', text: t('DASH_ATTR_LABEL') });
		const archiveSpecs: Array<{
			mode: NoteListArchiveFilter;
			icon: string;
			titleKey: MessageKey;
		}> = [
			{ mode: 'all', icon: 'list', titleKey: 'ARCHIVE_FILTER_ALL' },
			{ mode: 'unarchived', icon: 'inbox', titleKey: 'ARCHIVE_FILTER_UNARCHIVED' },
			{ mode: 'archived', icon: 'archive', titleKey: 'ARCHIVE_FILTER_ARCHIVED' }
		];
		for (const spec of archiveSpecs) {
			const title = t(spec.titleKey);
			const btn = attrRow.createEl('button', {
				type: 'button',
				cls: 'clickable-icon csn-dash-attr-btn csn-dash-attr-btn--icon',
				attr: {
					'aria-label': title,
					'aria-pressed': 'false',
					title
				}
			});
			setIcon(btn, spec.icon);
			this.archiveFilterBtns.set(spec.mode, btn);
			this.registerDomEvent(btn, 'click', () => {
				this.setArchiveFilter(spec.mode);
			});
		}
		this.syncArchiveFilterButtons();

		const colorRow = filters.createDiv({ cls: 'csn-dash-colors' });
		colorRow.createSpan({ cls: 'csn-dash-filter-label', text: t('DASH_COLOR_LABEL') });
		const strip = colorRow.createDiv({ cls: 'csn-list-color-filter-btns' });
		for (const c of SHEET_COLOR_ORDER) {
			const btn = strip.createEl('button', {
				type: 'button',
				cls: 'csn-list-color-filter-btn csn-list-color-filter-swatch',
				attr: {
					'data-csn-list-color': c.id,
					'aria-label': t('LIST_COLOR_SWATCH_FILTER_HINT', { label: t(c.labelKey) })
				}
			});
			this.colorBtns.set(c.id, btn);
			this.registerDomEvent(btn, 'click', (evt: MouseEvent) => {
				const multi = evt.ctrlKey || evt.metaKey;
				if (multi) {
					const i = this.colorFilters.indexOf(c.id);
					if (i >= 0) this.colorFilters.splice(i, 1);
					else this.colorFilters.push(c.id);
				} else {
					/* 单击单选：再点已选中的唯一色则清空 */
					if (this.colorFilters.length === 1 && this.colorFilters[0] === c.id) {
						this.colorFilters = [];
					} else {
						this.colorFilters = [c.id];
					}
				}
				this.listPageIndex = 0;
				this.syncColorButtons();
				void this.renderDash();
			});
		}

		const tagWrap = filters.createDiv({ cls: 'csn-dash-tag-wrap' });
		this.tagPanelWrapEl = tagWrap;
		tagWrap.createSpan({ cls: 'csn-dash-filter-label', text: t('DASH_TAG_LABEL') });
		this.tagChipsEl = tagWrap.createDiv({ cls: 'csn-dash-tag-chips' });
		this.registerDomEvent(this.tagChipsEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const removeBtn = hit.closest('[data-csn-tag-chip-remove]');
			if (removeBtn && this.tagChipsEl?.contains(removeBtn)) {
				const tag = (removeBtn as HTMLElement).dataset.csnTagChipRemove;
				if (!tag) return;
				evt.preventDefault();
				evt.stopPropagation();
				this.removeTagFilter(tag);
				return;
			}
			if (hit.closest('[data-csn-filter-more-clear]')) return;
			const chip = hit.closest('button.csn-dash-tag-chip');
			if (chip && this.tagChipsEl?.contains(chip)) {
				evt.preventDefault();
				evt.stopPropagation();
				this.tagPanelGroup = 'selected';
				this.openTagFilterPanel();
			}
		});
		this.tagFilterBtn = tagWrap.createEl('button', {
			type: 'button',
			cls: 'csn-dash-tag-add-btn clickable-icon',
			attr: {
				'aria-label': t('DASH_TAG_ADD_ARIA'),
				'aria-haspopup': 'dialog',
				'aria-expanded': 'false',
				'aria-controls': 'csn-dash-tag-panel'
			}
		});
		setIcon(this.tagFilterBtn, 'plus');
		this.registerDomEvent(this.tagFilterBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleTagFilterPanel();
		});
		this.buildTagFilterPanel(tagWrap);
		this.syncTagFilterButton();

		const dateFilterWrap = filters.createDiv({ cls: 'csn-dash-date-filter' });
		this.dateFilterWrapEl = dateFilterWrap;
		dateFilterWrap.createSpan({ cls: 'csn-dash-filter-label', text: t('DASH_DATE_FILTER_LABEL') });
		this.dateFilterChipsEl = dateFilterWrap.createDiv({ cls: 'csn-dash-date-filter-chips' });
		this.registerDomEvent(this.dateFilterChipsEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const removeBtn = hit.closest('[data-csn-date-chip-remove]');
			if (removeBtn && this.dateFilterChipsEl?.contains(removeBtn)) {
				evt.preventDefault();
				evt.stopPropagation();
				const key = (removeBtn as HTMLElement).dataset.csnDateChipRemove;
				if (!key) return;
				this.removeDateFilterChip(key);
				return;
			}
			if (hit.closest('[data-csn-filter-more-clear]')) return;
			const chip = hit.closest('button.csn-dash-date-filter-chip');
			if (chip && this.dateFilterChipsEl?.contains(chip)) {
				evt.preventDefault();
				evt.stopPropagation();
				this.openDateFilterPanel({ group: 'selected' });
			}
		});
		this.dateFilterAddBtn = dateFilterWrap.createEl('button', {
			type: 'button',
			cls: 'csn-dash-date-filter-add-btn clickable-icon',
			attr: {
				'aria-label': t('DASH_DATE_FILTER_ADD_ARIA'),
				'aria-haspopup': 'dialog',
				'aria-expanded': 'false',
				'aria-controls': 'csn-dash-date-filter-panel'
			}
		});
		setIcon(this.dateFilterAddBtn, 'plus');
		this.registerDomEvent(this.dateFilterAddBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleDateFilterPanel();
		});
		this.buildDateFilterPanel(dateFilterWrap);
		this.syncDateFilterBar();

		const wsFilterWrap = filters.createDiv({ cls: 'csn-dash-ws-filter-bar' });
		this.wsFilterWrapEl = wsFilterWrap;
		wsFilterWrap.createSpan({ cls: 'csn-dash-filter-label', text: t('DASH_WS_FILTER_LABEL') });
		this.wsFilterChipsEl = wsFilterWrap.createDiv({ cls: 'csn-dash-ws-filter-chips' });
		this.registerDomEvent(this.wsFilterChipsEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const removeBtn = hit.closest('[data-csn-ws-chip-remove]');
			if (removeBtn && this.wsFilterChipsEl?.contains(removeBtn)) {
				evt.preventDefault();
				evt.stopPropagation();
				const el = removeBtn as HTMLElement;
				const kind = el.dataset.csnWsChipKind;
				const id = el.dataset.csnWsChipRemove;
				if (!kind || !id) return;
				if (kind === 'group' || kind === 'workspace') {
					this.removeWorkspaceFilterChip(kind, id);
				}
				return;
			}
			if (hit.closest('[data-csn-filter-more-clear]')) return;
			const chip = hit.closest('button.csn-dash-ws-filter-chip');
			if (chip && this.wsFilterChipsEl?.contains(chip)) {
				evt.preventDefault();
				evt.stopPropagation();
				this.openWorkspaceFilterPanel({ group: 'selected' });
			}
		});
		this.wsFilterAddBtn = wsFilterWrap.createEl('button', {
			type: 'button',
			cls: 'csn-dash-ws-filter-add-btn clickable-icon',
			attr: {
				'aria-label': t('DASH_WS_FILTER_ADD_ARIA'),
				'aria-haspopup': 'dialog',
				'aria-expanded': 'false',
				'aria-controls': 'csn-dash-ws-filter-panel'
			}
		});
		setIcon(this.wsFilterAddBtn, 'plus');
		this.registerDomEvent(this.wsFilterAddBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleWorkspaceFilterPanel();
		});
		this.buildWorkspaceFilterPanel(wsFilterWrap);
		this.syncWorkspaceFilterBar();

		const searchWrap = filters.createDiv({ cls: 'csn-dash-search' });
		searchWrap.createSpan({ cls: 'csn-dash-filter-label', text: t('DASH_SEARCH_LABEL') });
		const searchInner = searchWrap.createDiv({ cls: 'csn-dash-search-inner' });
		this.searchInnerEl = searchInner;
		const searchIcon = searchInner.createSpan({ cls: 'csn-dash-search-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(searchIcon, 'search');
		this.searchInput = searchInner.createEl('input', {
			type: 'text',
			cls: 'csn-dash-search-input',
			attr: {
				placeholder: t('DASH_SEARCH_PLACEHOLDER'),
				spellcheck: 'false',
				'aria-label': t('SEARCH_ARIA'),
				role: 'searchbox',
				autocomplete: 'off'
			}
		});
		this.searchInput.value = this.plugin.settings.dashboardFilters.searchQuery;
		this.searchClearBtn = searchInner.createEl('button', {
			type: 'button',
			cls: 'csn-dash-search-clear csn-dash-search-clear--hidden',
			attr: {
				'aria-label': t('CLEAR_SEARCH_ARIA'),
				'aria-hidden': 'true',
				tabindex: '-1'
			}
		});
		setIcon(this.searchClearBtn, 'x');
		const debouncedSearch = debounce(
			() => {
				this.listPageIndex = 0;
				void this.renderDash();
			},
			120,
			true
		);
		this.registerDomEvent(this.searchInput, 'input', () => {
			this.syncSearchClearVisibility();
			debouncedSearch();
		});
		this.registerDomEvent(this.searchClearBtn, 'click', () => {
			if (!this.searchInput) return;
			this.searchInput.value = '';
			this.syncSearchClearVisibility();
			this.listPageIndex = 0;
			void this.renderDash();
			this.searchInput.focus();
		});

		this.registerDomEvent(document, 'pointerdown', (evt: PointerEvent) => {
			const tEl = evt.target;
			if (!(tEl instanceof Node)) return;
			if (this.isAreaVisibilityPanelOpen()) {
				if (
					!(
						this.areaVisibilityPanelEl?.contains(tEl) ||
						this.areaVisibilityBtn?.contains(tEl)
					)
				) {
					this.closeAreaVisibilityPanel();
				}
			}
			if (this.isTagFilterPanelOpen()) {
				/* 仅点击面板或触发控件内不关闭；勿用整块 tag-wrap（会占满筛选行空白） */
				if (
					!(
				this.tagPanelEl?.contains(tEl) ||
				this.tagFilterBtn?.contains(tEl) ||
				this.tagChipsEl?.contains(tEl)
					)
				) {
					this.closeTagFilterPanel();
				}
			}
			if (this.isDateFilterPanelOpen()) {
				if (
					!(
						this.dateFilterPanelEl?.contains(tEl) ||
						this.dateFilterAddBtn?.contains(tEl) ||
						this.dateFilterChipsEl?.contains(tEl)
					)
				) {
					this.closeDateFilterPanel();
				}
			}
			if (this.isWorkspaceFilterPanelOpen()) {
				if (
					!(
						this.wsFilterPanelEl?.contains(tEl) ||
						this.wsFilterAddBtn?.contains(tEl) ||
						this.wsFilterChipsEl?.contains(tEl)
					)
				) {
					this.closeWorkspaceFilterPanel();
				}
			}
		});
		this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key !== 'Escape') return;
			if (this.isAreaVisibilityPanelOpen()) {
				evt.preventDefault();
				this.closeAreaVisibilityPanel();
				return;
			}
			if (this.isWorkspaceFilterPanelOpen()) {
				evt.preventDefault();
				this.closeWorkspaceFilterPanel();
				return;
			}
			if (this.isDateFilterPanelOpen()) {
				evt.preventDefault();
				this.closeDateFilterPanel();
				return;
			}
			if (!this.isTagFilterPanelOpen()) return;
			evt.preventDefault();
			this.closeTagFilterPanel();
		});

		const toolActions = toolBar.createDiv({ cls: 'csn-dash-tool-actions' });

		const paneToggles = toolActions.createDiv({ cls: 'csn-dash-toolbar csn-dash-pane-toggles' });
		this.leftPaneToggleBtn = paneToggles.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-dash-left-toggle-btn',
			attr: {
				'aria-label': t('DASH_LEFT_PANE_TOGGLE_ARIA'),
				'aria-pressed': this.plugin.settings.dashboardLeftPaneCollapsed ? 'false' : 'true'
			}
		});
		setIcon(this.leftPaneToggleBtn, 'panel-left');
		this.registerDomEvent(this.leftPaneToggleBtn, 'click', () => {
			void this.toggleLeftPaneCollapsed();
		});

		this.composerToggleBtn = paneToggles.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-dash-composer-toggle-btn',
			attr: {
				'aria-label': t('DASH_COMPOSER_TOGGLE_ARIA'),
				'aria-pressed': this.plugin.settings.dashboardComposerHidden ? 'false' : 'true'
			}
		});
		setIcon(this.composerToggleBtn, 'panel-top');
		this.registerDomEvent(this.composerToggleBtn, 'click', () => {
			void this.toggleComposerHidden();
		});
		this.syncLeftPaneToggleBtn();
		this.syncComposerToggleBtn();

		const toolbar = toolActions.createDiv({ cls: 'csn-dash-toolbar' });

		const newStickyBtn = toolbar.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-dash-new-sticky-btn',
			attr: { 'aria-label': t('NEW_STICKY_ARIA') }
		});
		setIcon(newStickyBtn, 'plus');
		this.registerDomEvent(newStickyBtn, 'click', () => {
			void this.createStickyFromToolbar();
		});

		this.sortDropdownBtn = toolbar.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.registerDomEvent(this.sortDropdownBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openSortDropdownMenu(evt);
		});

		this.listBulkEditBtn = toolbar.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-list-bulk-edit-btn',
			attr: {
				'aria-label': t('LIST_EDIT_CARDS_TOGGLE_ARIA'),
				'aria-pressed': 'false'
			}
		});
		setIcon(this.listBulkEditBtn, 'square-check');
		this.registerDomEvent(this.listBulkEditBtn, 'click', () => {
			this.listArchiveCheckboxEditMode = !this.listArchiveCheckboxEditMode;
			this.syncListArchiveCheckboxEditUI();
		});

		this.listCardOverflowClipBtn = toolbar.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-list-card-overflow-clip-btn',
			attr: {
				'aria-label': t('SETTINGS_LIST_CARD_OVERFLOW_NAME'),
				'aria-pressed': this.plugin.settings.noteListCardOverflowHidden ? 'true' : 'false'
			}
		});
		setIcon(this.listCardOverflowClipBtn, 'crop');
		this.registerDomEvent(this.listCardOverflowClipBtn, 'click', async () => {
			this.plugin.settings.noteListCardOverflowHidden = !this.plugin.settings.noteListCardOverflowHidden;
			await this.plugin.saveSettings();
			this.plugin.syncNoteListGridMetricsToOpenViews();
		});

		const gridPane = main.createDiv({ cls: 'csn-dash-grid-pane' });
		this.gridEl = gridPane.createDiv({ cls: 'csn-dash-grid' });
		this.registerGridDelegatedEvents();
		this.paginationEl = gridPane.createDiv({ cls: 'csn-list-pagination csn-dash-pagination' });
		this.paginationRowEl = this.paginationEl.createDiv({ cls: 'csn-list-pagination-row' });
		this.paginationPrevBtn = this.paginationRowEl.createEl('button', {
			type: 'button',
			text: t('PREV_PAGE'),
			cls: 'csn-list-pagination-btn csn-list-pagination-btn--nav'
		});
		this.paginationPagesEl = this.paginationRowEl.createDiv({ cls: 'csn-list-pagination-pages' });
		this.paginationNextBtn = this.paginationRowEl.createEl('button', {
			type: 'button',
			text: t('NEXT_PAGE'),
			cls: 'csn-list-pagination-btn csn-list-pagination-btn--nav'
		});
		this.paginationMetaEl = this.paginationEl.createDiv({ cls: 'csn-list-pagination-meta' });
		this.registerDomEvent(this.paginationPrevBtn, 'click', () => {
			if (this.listPageIndex <= 0) return;
			this.listPageIndex -= 1;
			void this.renderDash();
		});
		this.registerDomEvent(this.paginationNextBtn, 'click', () => {
			this.listPageIndex += 1;
			void this.renderDash();
		});
		this.registerDomEvent(this.paginationEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const btn = hit.closest('button[data-csn-list-page]');
			if (!btn || !this.paginationEl?.contains(btn)) return;
			const raw = (btn as HTMLButtonElement).dataset.csnListPage;
			const p0 = raw !== undefined ? parseInt(raw, 10) : NaN;
			if (!Number.isFinite(p0) || p0 < 0) return;
			evt.preventDefault();
			this.listPageIndex = p0;
			void this.renderDash();
		});

		this.registerVaultRefresh();
		this.loadCollapsedGroupsFromSettings();
		this.loadCollapsedLeftPanelsFromSettings();
		this.syncListGridMetricsFromSettings();
		this.syncViewContentZoomFromSettings();
		this.renderAreaNav();
		this.applyAllLeftPanelCollapsedClasses();
		this.syncColorButtons();
		this.syncTagFilterButton();
		this.syncSortToolbarBtn();
		this.syncWsTreeSortBtn();
		this.syncWsTreeShowArchivedBtn();
		this.syncListArchiveCheckboxEditUI();
		this.syncCardOverflowClipToolbarBtn();
		this.syncSearchClearVisibility();
		this.renderCalendar();
		this.renderWorkspaceTree();
		this.registerDashViewportWidthObserver();
		void this.renderDash();
	}

	private syncSearchClearVisibility(): void {
		const has = (this.searchInput?.value ?? '').length > 0;
		this.searchInnerEl?.toggleClass('csn-dash-search-inner--has-clear', has);
		this.searchClearBtn?.toggleClass('csn-dash-search-clear--hidden', !has);
		this.searchClearBtn?.setAttr('aria-hidden', has ? 'false' : 'true');
		this.searchClearBtn?.setAttr('tabindex', has ? '0' : '-1');
	}

	private setArchiveFilter(mode: NoteListArchiveFilter): void {
		if (this.archiveFilter === mode) return;
		this.archiveFilter = mode;
		if (mode !== 'archived' && this.areaMode === 'archived') {
			this.areaMode = 'all';
		}
		this.listPageIndex = 0;
		this.syncArchiveFilterButtons();
		this.syncAreaButtons();
		void this.renderDash();
	}

	private syncArchiveFilterButtons(): void {
		for (const [mode, btn] of this.archiveFilterBtns) {
			const on = mode === this.archiveFilter;
			btn.toggleClass('is-active', on);
			btn.setAttr('aria-pressed', on ? 'true' : 'false');
		}
	}

	private setAreaMode(mode: DashAreaMode): void {
		const same = this.areaMode === mode && this.workspaceSel.kind === 'all';
		if (same && mode !== 'random') return;
		this.areaMode = mode;
		this.archiveFilter = mode === 'archived' ? 'archived' : 'unarchived';
		this.workspaceSel = { kind: 'all' };
		/* 进入/再次点击随机模式时重新洗牌 */
		this.randomOrderPaths = null;
		this.listPageIndex = 0;
		this.renderAreaNav();
		this.syncArchiveFilterButtons();
		this.syncWorkspaceFilterBar();
		this.renderWorkspaceTree();
		void this.renderDash();
	}

	private isAreaNavActive(mode: DashAreaMode): boolean {
		if (mode === 'all') return this.areaMode === 'all' && this.workspaceSel.kind === 'all';
		return this.areaMode === mode;
	}

	private isAreaModeVisible(mode: DashAreaMode): boolean {
		const visible = normalizeDashboardVisibleAreaModes(this.plugin.settings.dashboardVisibleAreaModes);
		return visible.includes(mode);
	}

	private getVisibleAreaModeSpecs(): typeof DASH_AREA_MODE_SPECS {
		return DASH_AREA_MODE_SPECS.filter(spec => this.isAreaModeVisible(spec.mode));
	}

	/** 当前区域模式被隐藏时，回退到第一个可见项。 */
	private ensureVisibleAreaMode(): boolean {
		if (this.isAreaModeVisible(this.areaMode)) return false;
		const first = this.getVisibleAreaModeSpecs()[0]?.mode ?? 'all';
		this.areaMode = first;
		this.archiveFilter = first === 'archived' ? 'archived' : this.archiveFilter === 'archived' ? 'all' : this.archiveFilter;
		return true;
	}

	private isAreaVisibilityPanelOpen(): boolean {
		return !!this.areaVisibilityPanelEl && !this.areaVisibilityPanelEl.hasClass('csn-dash-area-vis-panel--hidden');
	}

	private buildAreaVisibilityPanel(host: HTMLElement): void {
		this.areaVisibilityPanelEl = host.createDiv({
			cls: 'csn-dash-area-vis-panel csn-dash-area-vis-panel--hidden',
			attr: { role: 'group', 'aria-label': t('DASH_AREA_VISIBILITY_ARIA') }
		});
		this.areaVisibilityPanelEl.createDiv({
			cls: 'csn-dash-area-vis-panel-hint',
			text: t('DASH_AREA_VISIBILITY_HINT')
		});
		const list = this.areaVisibilityPanelEl.createDiv({ cls: 'csn-dash-area-vis-panel-list' });
		this.areaVisibilityItemBtns.clear();
		for (const spec of DASH_AREA_MODE_SPECS) {
			const btn = list.createEl('button', {
				type: 'button',
				cls: 'csn-dash-area-vis-item',
				attr: { 'data-csn-area-mode': spec.mode }
			});
			setIcon(btn.createSpan({ cls: 'csn-dash-area-vis-item-icon' }), spec.icon);
			btn.createSpan({ cls: 'csn-dash-area-vis-item-label', text: t(spec.titleKey) });
			const check = btn.createSpan({ cls: 'csn-dash-area-vis-item-check', attr: { 'aria-hidden': 'true' } });
			setIcon(check, 'check');
			this.areaVisibilityItemBtns.set(spec.mode, btn);
			this.registerDomEvent(btn, 'click', (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				void this.toggleAreaModeVisibility(spec.mode);
			});
		}
		this.syncAreaVisibilityPanelChrome();
	}

	private toggleAreaVisibilityPanel(): void {
		if (this.isAreaVisibilityPanelOpen()) this.closeAreaVisibilityPanel();
		else this.openAreaVisibilityPanel();
	}

	private openAreaVisibilityPanel(): void {
		const panel = this.areaVisibilityPanelEl;
		const btn = this.areaVisibilityBtn;
		if (!panel || !btn) return;
		this.syncAreaVisibilityPanelChrome();
		/* 挂到 body，避免被左侧栏 / panel 的 overflow:hidden 裁切 */
		document.body.appendChild(panel);
		panel.removeClass('csn-dash-area-vis-panel--hidden');
		this.positionAreaVisibilityPanel();
		this.areaVisibilityBtn?.setAttr('aria-expanded', 'true');
		this.areaVisibilityBtn?.addClass('is-active');
		this.areaVisibilityBtn?.closest('.csn-dash-area-vis-wrap')?.addClass('is-open');
	}

	private positionAreaVisibilityPanel(): void {
		const panel = this.areaVisibilityPanelEl;
		const btn = this.areaVisibilityBtn;
		if (!panel || !btn) return;
		const r = btn.getBoundingClientRect();
		const pad = 8;
		const gap = 6;
		panel.style.position = 'fixed';
		panel.style.zIndex = '1000';
		panel.style.left = 'auto';
		panel.style.right = `${Math.max(pad, Math.round(window.innerWidth - r.right))}px`;
		panel.style.top = `${Math.round(r.bottom + gap)}px`;
		panel.style.maxHeight = `${Math.max(120, Math.round(window.innerHeight - r.bottom - gap - pad))}px`;
	}

	private closeAreaVisibilityPanel(): void {
		const panel = this.areaVisibilityPanelEl;
		const wrap = this.areaVisibilityBtn?.closest('.csn-dash-area-vis-wrap');
		if (panel) {
			panel.addClass('csn-dash-area-vis-panel--hidden');
			panel.style.position = '';
			panel.style.zIndex = '';
			panel.style.left = '';
			panel.style.right = '';
			panel.style.top = '';
			panel.style.maxHeight = '';
			if (wrap instanceof HTMLElement && panel.parentElement !== wrap) {
				wrap.appendChild(panel);
			}
		}
		wrap?.removeClass('is-open');
		this.areaVisibilityBtn?.setAttr('aria-expanded', 'false');
		this.areaVisibilityBtn?.removeClass('is-active');
	}

	private syncAreaVisibilityPanelChrome(): void {
		const visible = new Set(
			normalizeDashboardVisibleAreaModes(this.plugin.settings.dashboardVisibleAreaModes)
		);
		for (const [mode, btn] of this.areaVisibilityItemBtns) {
			const on = visible.has(mode);
			btn.toggleClass('is-active', on);
			btn.setAttr('aria-checked', on ? 'true' : 'false');
		}
	}

	private async toggleAreaModeVisibility(mode: DashAreaMode): Promise<void> {
		const cur = normalizeDashboardVisibleAreaModes(this.plugin.settings.dashboardVisibleAreaModes);
		const next = cur.includes(mode) ? cur.filter(m => m !== mode) : [...cur, mode];
		if (next.length === 0) {
			new Notice(t('DASH_AREA_VISIBILITY_KEEP_ONE'));
			return;
		}
		/* 保持 DASH_AREA_MODE_SPECS 顺序 */
		const ordered = DASH_AREA_MODE_SPECS.map(s => s.mode).filter(m => next.includes(m));
		this.plugin.settings.dashboardVisibleAreaModes = ordered;
		await this.plugin.saveSettings();
		this.syncAreaVisibilityPanelChrome();
		const modeChanged = this.ensureVisibleAreaMode();
		this.renderAreaNav();
		if (modeChanged) {
			this.syncWorkspaceFilterBar();
			void this.renderDash();
		}
	}

	private renderAreaNav(): void {
		const host = this.areaNavEl;
		if (!host) return;
		host.empty();
		this.areaBtns.clear();
		for (const spec of this.getVisibleAreaModeSpecs()) {
			const btn = host.createEl('button', {
				type: 'button',
				cls: `csn-dash-area-item${this.isAreaNavActive(spec.mode) ? ' is-active' : ''}`
			});
			this.areaBtns.set(spec.mode, btn);
			setIcon(btn.createSpan({ cls: 'csn-dash-area-item-icon' }), spec.icon);
			btn.createSpan({ cls: 'csn-dash-area-item-label', text: t(spec.titleKey) });
			if (spec.showCount) {
				const n = this.areaCounts[spec.mode];
				btn.createSpan({
					cls: 'csn-dash-area-item-count',
					text: typeof n === 'number' ? String(n) : ''
				});
			}
			this.registerDomEvent(btn, 'click', () => {
				this.setAreaMode(spec.mode);
			});
		}
	}

	private syncAreaButtons(): void {
		for (const [mode, btn] of this.areaBtns) {
			btn.toggleClass('is-active', this.isAreaNavActive(mode));
		}
	}

	private syncAreaCountLabels(): void {
		for (const spec of DASH_AREA_MODE_SPECS) {
			if (!spec.showCount) continue;
			const btn = this.areaBtns.get(spec.mode);
			const countEl = btn?.querySelector('.csn-dash-area-item-count');
			if (!(countEl instanceof HTMLElement)) continue;
			const n = this.areaCounts[spec.mode];
			countEl.setText(typeof n === 'number' ? String(n) : '');
		}
	}

	private async refreshAreaCounts(allFiles: TFile[]): Promise<void> {
		const mgr = this.plugin.stickies;
		const file = mgr.workspaces;
		const assigned = mgr.getAllAssignedWorkspaceMemberPathSet();
		const ungroupedPaths = new Set<string>();
		for (const ws of file.workspaces) {
			if (resolveWorkspaceTabGroupId(ws, file.tabGroups) !== WS_TAB_GROUP_UNGROUPED_ID) continue;
			for (const p of mgr.getWorkspaceMemberPathSet(ws)) ungroupedPaths.add(p);
		}
		let all = 0;
		let ungrouped = 0;
		let uncategorized = 0;
		let archived = 0;
		for (const f of allFiles) {
			const isArchived = await resolveStickyArchivedForFile(this.app, f);
			if (isArchived) {
				archived++;
				continue;
			}
			all++;
			const path = normalizePath(f.path);
			if (!assigned.has(path)) uncategorized++;
			else if (ungroupedPaths.has(path)) ungrouped++;
		}
		this.areaCounts = { all, ungrouped, uncategorized, archived };
		this.syncAreaCountLabels();
	}

	private syncColorButtons(): void {
		const sel = new Set(this.colorFilters);
		for (const [id, btn] of this.colorBtns) {
			btn.toggleClass('is-active', sel.has(id));
		}
	}

	private activeTagFilterCount(): number {
		return this.tagIncludeFilters.length + this.tagExcludeFilters.length;
	}

	/** 多项筛选时在芯片栏显示省略号；点击打开对应面板，X 清空该项筛选。 */
	private appendFilterMoreChip(
		host: HTMLElement,
		chipCls: string,
		count: number,
		onOpen: () => void,
		onClear: () => void,
		clearAria: string
	): void {
		const chip = host.createEl('button', {
			type: 'button',
			cls: `${chipCls} csn-dash-filter-chip--more`,
			attr: {
				'data-csn-filter-more': '1',
				title: t('DASH_FILTER_CHIPS_MORE_ARIA', { n: count }),
				'aria-label': t('DASH_FILTER_CHIPS_MORE_ARIA', { n: count })
			}
		});
		chip.createSpan({ cls: 'csn-dash-filter-chip-more-text', text: t('DASH_FILTER_CHIPS_MORE') });
		chip.createSpan({ cls: 'csn-dash-filter-chip-more-count', text: String(count) });
		const remove = chip.createSpan({
			cls: 'csn-dash-filter-chip-more-remove',
			attr: {
				role: 'button',
				tabindex: '0',
				'data-csn-filter-more-clear': '1',
				'aria-label': clearAria
			}
		});
		setIcon(remove, 'x');
		this.registerDomEvent(chip, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (hit instanceof Element && hit.closest('[data-csn-filter-more-clear]')) {
				evt.preventDefault();
				evt.stopPropagation();
				onClear();
				return;
			}
			evt.preventDefault();
			evt.stopPropagation();
			onOpen();
		});
	}

	private syncTagFilterButton(): void {
		const btn = this.tagFilterBtn;
		const chipsEl = this.tagChipsEl;
		const hasFilters = this.activeTagFilterCount() > 0;
		if (btn) {
			/* 仅面板打开时高亮；已有筛选用 chips 表达，勿点亮 + */
			btn.toggleClass('is-active', this.isTagFilterPanelOpen());
			btn.setAttr('aria-expanded', this.isTagFilterPanelOpen() ? 'true' : 'false');
		}
		if (!chipsEl) return;
		chipsEl.empty();
		const total = this.activeTagFilterCount();
		if (total === 0) return;
		if (total > 1) {
			this.appendFilterMoreChip(
				chipsEl,
				'csn-dash-tag-chip',
				total,
				() => {
					this.tagPanelGroup = 'selected';
					this.openTagFilterPanel();
				},
				() => this.clearAllTagFilters(),
				t('DASH_TAG_CLEAR_ARIA')
			);
			return;
		}
		const addChip = (tag: string, mode: 'include' | 'exclude') => {
			const chip = chipsEl.createEl('button', {
				type: 'button',
				cls: `csn-dash-tag-chip csn-dash-tag-chip--${mode}`,
				attr: {
					'data-csn-tag-chip': tag,
					title: displayStickyTag(tag),
					'aria-label': displayStickyTag(tag)
				}
			});
			chip.createSpan({ cls: 'csn-dash-tag-chip-text', text: displayStickyTag(tag) });
			const remove = chip.createEl('span', {
				cls: 'csn-dash-tag-chip-remove',
				attr: {
					role: 'button',
					tabindex: '0',
					'data-csn-tag-chip-remove': tag,
					'aria-label': t('DASH_TAG_CHIP_REMOVE_ARIA', { tag: displayStickyTag(tag) })
				}
			});
			setIcon(remove, 'x');
		};
		for (const tag of this.tagIncludeFilters) addChip(tag, 'include');
		for (const tag of this.tagExcludeFilters) addChip(tag, 'exclude');
	}

	private clearAllTagFilters(): void {
		if (this.tagIncludeFilters.length === 0 && this.tagExcludeFilters.length === 0) return;
		this.tagIncludeFilters = [];
		this.tagExcludeFilters = [];
		this.listPageIndex = 0;
		this.syncTagFilterButton();
		if (this.isTagFilterPanelOpen()) this.renderTagPanelBody();
		void this.renderDash();
	}

	private removeTagFilter(tagRaw: string): void {
		const tag = normalizeStickyTag(tagRaw);
		if (!tag) return;
		this.tagIncludeFilters = this.tagIncludeFilters.filter(x => x !== tag);
		this.tagExcludeFilters = this.tagExcludeFilters.filter(x => x !== tag);
		this.listPageIndex = 0;
		this.syncTagFilterButton();
		if (this.isTagFilterPanelOpen()) this.renderTagPanelBody();
		void this.renderDash();
	}

	private isTagFilterPanelOpen(): boolean {
		return !!this.tagPanelEl && !this.tagPanelEl.hasClass('csn-dash-tag-panel--hidden');
	}

	private buildTagFilterPanel(host: HTMLElement): void {
		const panel = host.createDiv({
			cls: 'csn-dash-tag-panel csn-dash-tag-panel--hidden',
			attr: {
				id: 'csn-dash-tag-panel',
				role: 'dialog',
				'aria-label': t('DASH_TAG_PANEL_ARIA')
			}
		});
		this.tagPanelEl = panel;

		const tools = panel.createDiv({ cls: 'csn-dash-tag-panel-tools' });
		const searchInner = tools.createDiv({ cls: 'csn-dash-tag-search-inner' });
		const searchIcon = searchInner.createSpan({ cls: 'csn-dash-tag-search-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(searchIcon, 'search');
		this.tagPanelSearchInput = searchInner.createEl('input', {
			type: 'text',
			cls: 'csn-dash-tag-search-input',
			attr: {
				placeholder: t('DASH_TAG_SEARCH_PLACEHOLDER'),
				spellcheck: 'false',
				autocomplete: 'off'
			}
		});
		this.registerDomEvent(this.tagPanelSearchInput, 'input', () => {
			this.tagPanelSearch = this.tagPanelSearchInput?.value ?? '';
			this.renderTagPanelBody();
		});
		this.registerDomEvent(this.tagPanelSearchInput, 'click', (evt: MouseEvent) => {
			evt.stopPropagation();
		});

		const logic = tools.createDiv({ cls: 'csn-dash-tag-logic' });
		logic.createSpan({ cls: 'csn-dash-tag-logic-label', text: t('DASH_TAG_LOGIC') });
		this.tagLogicOrBtn = logic.createEl('button', {
			type: 'button',
			cls: 'csn-dash-tag-logic-btn',
			text: t('DASH_TAG_LOGIC_OR'),
			attr: { 'aria-pressed': 'true' }
		});
		this.tagLogicAndBtn = logic.createEl('button', {
			type: 'button',
			cls: 'csn-dash-tag-logic-btn',
			text: t('DASH_TAG_LOGIC_AND'),
			attr: { 'aria-pressed': 'false' }
		});
		this.registerDomEvent(this.tagLogicOrBtn, 'click', () => {
			this.tagFilterLogic = 'or';
			this.syncTagLogicButtons();
			this.listPageIndex = 0;
			void this.renderDash();
		});
		this.registerDomEvent(this.tagLogicAndBtn, 'click', () => {
			this.tagFilterLogic = 'and';
			this.syncTagLogicButtons();
			this.listPageIndex = 0;
			void this.renderDash();
		});

		const body = panel.createDiv({ cls: 'csn-dash-tag-panel-body' });
		this.tagPanelGroupsEl = body.createDiv({ cls: 'csn-dash-tag-groups' });
		const mkGroup = (id: 'selected' | 'all', label: string) => {
			const btn = this.tagPanelGroupsEl!.createEl('button', {
				type: 'button',
				cls: 'csn-dash-tag-group-btn',
				attr: { 'data-csn-tag-group': id }
			});
			btn.createSpan({ cls: 'csn-dash-tag-group-label', text: label });
			btn.createSpan({ cls: 'csn-dash-tag-group-count', text: '0' });
			this.registerDomEvent(btn, 'click', () => {
				this.tagPanelGroup = id;
				this.renderTagPanelBody();
			});
		};
		mkGroup('selected', t('DASH_TAG_GROUP_SELECTED'));
		mkGroup('all', t('DASH_TAG_GROUP_ALL'));

		this.tagPanelListEl = body.createDiv({ cls: 'csn-dash-tag-list' });
		this.registerDomEvent(this.tagPanelListEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const item = hit.closest('button[data-csn-tag]');
			if (!item || !this.tagPanelListEl?.contains(item)) return;
			const tag = (item as HTMLButtonElement).dataset.csnTag;
			if (!tag) return;
			evt.preventDefault();
			/* 已选分组：单击取消该项；全部：切换包含 */
			if (this.tagPanelGroup === 'selected') this.removeTagFilter(tag);
			else this.toggleTagInclude(tag);
		});
		this.registerDomEvent(this.tagPanelListEl, 'contextmenu', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const item = hit.closest('button[data-csn-tag]');
			if (!item || !this.tagPanelListEl?.contains(item)) return;
			const tag = (item as HTMLButtonElement).dataset.csnTag;
			if (!tag) return;
			evt.preventDefault();
			if (this.tagPanelGroup === 'selected') this.removeTagFilter(tag);
			else this.toggleTagExclude(tag);
		});

		const foot = panel.createDiv({ cls: 'csn-dash-tag-panel-foot' });
		foot.createSpan({ cls: 'csn-dash-tag-hint', text: t('DASH_TAG_HINT_SELECT') });
		foot.createSpan({ cls: 'csn-dash-tag-hint', text: t('DASH_TAG_HINT_EXCLUDE') });
		foot.createSpan({ cls: 'csn-dash-tag-hint csn-dash-tag-hint--end', text: t('DASH_TAG_HINT_CLOSE') });

		this.syncTagLogicButtons();
	}

	private syncTagLogicButtons(): void {
		this.tagLogicOrBtn?.toggleClass('is-active', this.tagFilterLogic === 'or');
		this.tagLogicAndBtn?.toggleClass('is-active', this.tagFilterLogic === 'and');
		this.tagLogicOrBtn?.setAttr('aria-pressed', this.tagFilterLogic === 'or' ? 'true' : 'false');
		this.tagLogicAndBtn?.setAttr('aria-pressed', this.tagFilterLogic === 'and' ? 'true' : 'false');
	}

	private toggleTagFilterPanel(): void {
		if (this.isTagFilterPanelOpen()) this.closeTagFilterPanel();
		else {
			this.tagPanelGroup = 'all';
			this.openTagFilterPanel();
		}
	}

	private openTagFilterPanel(): void {
		if (!this.tagPanelEl) return;
		this.refreshTagCatalogFromVault();
		this.tagPanelEl.removeClass('csn-dash-tag-panel--hidden');
		this.syncTagFilterButton();
		this.renderTagPanelBody();
		window.setTimeout(() => this.tagPanelSearchInput?.focus(), 0);
	}

	private closeTagFilterPanel(): void {
		this.tagPanelEl?.addClass('csn-dash-tag-panel--hidden');
		this.syncTagFilterButton();
	}

	/** 从便笺目录收集标签目录（工作区筛选后），供面板展示与计数。 */
	private refreshTagCatalogFromVault(): void {
		const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const folderAbs = this.app.vault.getAbstractFileByPath(folder);
		if (!folderAbs || !(folderAbs instanceof TFolder)) {
			this.tagCatalog = [];
			return;
		}
		let files = collectMarkdownUnderFolder(folderAbs);
		const wsPaths = this.resolveWorkspacePathFilter();
		if (wsPaths) files = files.filter(f => wsPaths.has(normalizePath(f.path)));
		this.tagCatalog = collectStickyTagCatalog(this.app, files);
	}

	private renderTagPanelBody(): void {
		const groupsEl = this.tagPanelGroupsEl;
		const listEl = this.tagPanelListEl;
		if (!groupsEl || !listEl) return;

		const selectedSet = new Set([...this.tagIncludeFilters, ...this.tagExcludeFilters]);
		const selectedCount = selectedSet.size;
		const allCount = this.tagCatalog.length;

		for (const btn of Array.from(groupsEl.querySelectorAll('.csn-dash-tag-group-btn'))) {
			if (!(btn instanceof HTMLElement)) continue;
			const id = btn.dataset.csnTagGroup;
			const countEl = btn.querySelector('.csn-dash-tag-group-count');
			if (countEl) countEl.setText(String(id === 'selected' ? selectedCount : allCount));
			btn.toggleClass('is-active', this.tagPanelGroup === id);
		}

		const q = this.tagPanelSearch.trim().toLowerCase().replace(/^#/, '');
		let rows = this.tagCatalog;
		if (this.tagPanelGroup === 'selected') {
			rows = rows.filter(r => selectedSet.has(r.tag));
		}
		if (q) {
			rows = rows.filter(r => displayStickyTag(r.tag).toLowerCase().includes(q) || r.tag.includes(q));
		}

		listEl.empty();
		if (rows.length === 0) {
			listEl.createDiv({ cls: 'csn-dash-tag-empty', text: t('DASH_TAG_EMPTY') });
			return;
		}

		const include = new Set(this.tagIncludeFilters);
		const exclude = new Set(this.tagExcludeFilters);
		for (const row of rows) {
			const item = listEl.createEl('button', {
				type: 'button',
				cls: 'csn-dash-tag-item',
				attr: { 'data-csn-tag': row.tag }
			});
			const check = item.createSpan({ cls: 'csn-dash-tag-check', attr: { 'aria-hidden': 'true' } });
			if (include.has(row.tag)) {
				item.addClass('is-included');
				setIcon(check, 'check-square');
			} else if (exclude.has(row.tag)) {
				item.addClass('is-excluded');
				setIcon(check, 'x-square');
			} else {
				setIcon(check, 'square');
			}
			const icon = item.createSpan({ cls: 'csn-dash-tag-icon', attr: { 'aria-hidden': 'true' } });
			setIcon(icon, 'tags');
			item.createSpan({ cls: 'csn-dash-tag-name', text: displayStickyTag(row.tag) });
			item.createSpan({ cls: 'csn-dash-tag-count', text: String(row.count) });
		}
	}

	private toggleTagInclude(tagRaw: string): void {
		const tag = normalizeStickyTag(tagRaw);
		if (!tag) return;
		this.tagExcludeFilters = this.tagExcludeFilters.filter(x => x !== tag);
		const i = this.tagIncludeFilters.indexOf(tag);
		if (i >= 0) this.tagIncludeFilters.splice(i, 1);
		else this.tagIncludeFilters.push(tag);
		this.listPageIndex = 0;
		this.syncTagFilterButton();
		this.renderTagPanelBody();
		void this.renderDash();
	}

	private toggleTagExclude(tagRaw: string): void {
		const tag = normalizeStickyTag(tagRaw);
		if (!tag) return;
		this.tagIncludeFilters = this.tagIncludeFilters.filter(x => x !== tag);
		const i = this.tagExcludeFilters.indexOf(tag);
		if (i >= 0) this.tagExcludeFilters.splice(i, 1);
		else this.tagExcludeFilters.push(tag);
		this.listPageIndex = 0;
		this.syncTagFilterButton();
		this.renderTagPanelBody();
		void this.renderDash();
	}

	private applyDateFilter(next: StickyDateFilter | null): void {
		this.selectedDateFilter = next;
		this.listPageIndex = 0;
		this.renderCalendar();
		void this.renderDash();
	}

	private setDateFilter(next: StickyDateFilter | null): void {
		if (stickyDateFiltersEqual(this.selectedDateFilter, next)) {
			this.applyDateFilter(null);
		} else {
			this.applyDateFilter(next);
		}
	}

	private clearDateFilter(): void {
		if (!this.selectedDateFilter) return;
		this.lastCalDateClickKey = null;
		this.applyDateFilter(null);
	}

	private isDateKeySelected(key: string): boolean {
		const f = this.selectedDateFilter;
		if (!f) return false;
		if (f.kind === 'day') return f.dateKey === key;
		if (f.kind === 'days') return f.dateKeys.includes(key);
		return false;
	}

	/** 将多日结果规范为 day / days / null。 */
	private applyDayKeysFilter(keys: Iterable<string>): void {
		const sorted = [...new Set(keys)].sort();
		if (sorted.length === 0) {
			this.applyDateFilter(null);
			return;
		}
		if (sorted.length === 1) {
			this.applyDateFilter({ kind: 'day', dateKey: sorted[0]! });
			return;
		}
		this.applyDateFilter({ kind: 'days', dateKeys: sorted });
	}

	/** Ctrl/Cmd 点击切换多日筛选。 */
	private toggleDayMultiSelect(dateKey: string): void {
		const cur = this.selectedDateFilter;
		const keys = new Set<string>();
		if (cur?.kind === 'day') keys.add(cur.dateKey);
		else if (cur?.kind === 'days') {
			for (const k of cur.dateKeys) keys.add(k);
		}

		if (cur?.kind === 'day' || cur?.kind === 'days') {
			if (keys.has(dateKey)) keys.delete(dateKey);
			else keys.add(dateKey);
		} else {
			keys.clear();
			keys.add(dateKey);
		}

		this.lastCalDateClickKey = dateKey;
		this.applyDayKeysFilter(keys);
	}

	/** Shift 点击：从锚点到当前日的连续区间（含端点）。 */
	private selectDayRangeFromAnchor(dateKey: string): void {
		const anchor = this.lastCalDateClickKey;
		if (!anchor) {
			this.lastCalDateClickKey = dateKey;
			this.applyDateFilter({ kind: 'day', dateKey });
			return;
		}
		const keys = listLocalDateKeysInclusive(anchor, dateKey);
		this.applyDayKeysFilter(keys);
		/* 保留锚点，便于连续 Shift 调整另一端 */
	}

	private calendarHeatMax(): number {
		let max = 0;
		for (const n of this.noteDateCounts.values()) {
			if (n > max) max = n;
		}
		return max;
	}

	private calendarHeatField(): StickyDateField {
		return this.plugin.settings.dashboardCalendarHeatField === 'mtime' ? 'mtime' : 'ctime';
	}

	private async toggleCalendarHeatField(): Promise<void> {
		const next: StickyDateField = this.calendarHeatField() === 'mtime' ? 'ctime' : 'mtime';
		this.plugin.settings.dashboardCalendarHeatField = next;
		await this.plugin.saveSettings();
		this.renderCalendar();
		void this.renderDash();
	}

	/** 某年创建便笺总数（日期键 YYYY-MM-DD）。 */
	private noteCountForYear(year: number): number {
		const prefix = `${year}-`;
		let total = 0;
		for (const [key, count] of this.noteDateCounts) {
			if (key.startsWith(prefix)) total += count;
		}
		return total;
	}

	/** 某年月创建便笺总数。 */
	private noteCountForYearMonth(year: number, month0: number): number {
		const prefix = `${year}-${String(month0 + 1).padStart(2, '0')}-`;
		let total = 0;
		for (const [key, count] of this.noteDateCounts) {
			if (key.startsWith(prefix)) total += count;
		}
		return total;
	}

	private applyCalPopoverHeat(
		el: HTMLElement,
		count: number,
		heatMax: number,
		labelKey: string
	): void {
		const level = heatmapLevelFromCount(count, heatMax);
		if (level > 0) el.addClass(`heat-${level}`);
		const aria =
			count > 0
				? t('DASH_CALENDAR_DAY_ARIA', { date: labelKey, count })
				: t('DASH_CALENDAR_DAY_ARIA_EMPTY', { date: labelKey });
		el.setAttribute('aria-label', aria);
		el.title = count > 0 ? aria : labelKey;
	}

	private syncDayCellHeat(el: HTMLElement, key: string): void {
		for (let i = 0; i <= 4; i++) el.removeClass(`heat-${i}`);
		el.removeClass('has-notes');
		const count = this.noteDateCounts.get(key) ?? 0;
		const level = heatmapLevelFromCount(count, this.calendarHeatMax());
		if (level > 0) el.addClass(`heat-${level}`);
		el.setAttribute(
			'aria-label',
			count > 0
				? t('DASH_CALENDAR_DAY_ARIA', { date: key, count })
				: t('DASH_CALENDAR_DAY_ARIA_EMPTY', { date: key })
		);
		el.title = count > 0 ? t('DASH_CALENDAR_DAY_ARIA', { date: key, count }) : key;
	}

	private goToToday(): void {
		const now = new Date();
		this.calYear = now.getFullYear();
		this.calMonth0 = now.getMonth();
		this.calPicker = null;
		this.detachCalPickerDocClose();
		this.afterCalViewChanged();
	}

	/** 日历年/月变更后：若当前是年或月筛选，同步到当前视图。 */
	private afterCalViewChanged(): void {
		const f = this.selectedDateFilter;
		if (f?.kind === 'year' && f.year !== this.calYear) {
			this.applyDateFilter({ kind: 'year', year: this.calYear });
			return;
		}
		if (
			f?.kind === 'month' &&
			(f.year !== this.calYear || f.month0 !== this.calMonth0)
		) {
			this.applyDateFilter({ kind: 'month', year: this.calYear, month0: this.calMonth0 });
			return;
		}
		this.renderCalendar();
	}

	private detachCalPickerDocClose(): void {
		if (!this.calPickerDocClose) return;
		document.removeEventListener('mousedown', this.calPickerDocClose, true);
		this.calPickerDocClose = null;
	}

	private openCalPicker(kind: 'year' | 'month'): void {
		if (this.calPicker === kind) {
			this.calPicker = null;
			this.detachCalPickerDocClose();
			this.renderCalendar();
			return;
		}
		this.calPicker = kind;
		if (kind === 'year') {
			this.calDecadeStart = Math.floor(this.calYear / 10) * 10;
		}
		this.renderCalendar();
	}

	private closeCalPicker(): void {
		if (!this.calPicker) return;
		this.calPicker = null;
		this.detachCalPickerDocClose();
		this.afterCalViewChanged();
	}

	private formatCalYearText(year: number): string {
		return t('DASH_CALENDAR_YEAR_TEXT', { year });
	}

	private formatCalMonthText(month0: number): string {
		const labels = monthShortLabels();
		return t('DASH_CALENDAR_MONTH_TEXT', {
			n: month0 + 1,
			month: labels[month0] ?? String(month0 + 1)
		});
	}

	private renderCalYearPopover(pickers: HTMLElement): void {
		const pop = pickers.createDiv({ cls: 'csn-dash-cal-popover csn-dash-cal-popover--year' });
		const head = pop.createDiv({ cls: 'csn-dash-cal-popover-head' });
		head.createSpan({
			cls: 'csn-dash-cal-popover-title',
			text: this.formatCalYearText(this.calYear)
		});
		const nav = head.createDiv({ cls: 'csn-dash-cal-popover-nav' });
		const prev = nav.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-cal-popover-nav-btn',
			attr: { 'aria-label': t('DASH_CALENDAR_DECADE_PREV') }
		});
		setIcon(prev, 'chevron-left');
		const next = nav.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-cal-popover-nav-btn',
			attr: { 'aria-label': t('DASH_CALENDAR_DECADE_NEXT') }
		});
		setIcon(next, 'chevron-right');
		this.registerDomEvent(prev, 'click', evt => {
			evt.stopPropagation();
			this.calDecadeStart -= 10;
			this.renderCalendar();
		});
		this.registerDomEvent(next, 'click', evt => {
			evt.stopPropagation();
			this.calDecadeStart += 10;
			this.renderCalendar();
		});

		const grid = pop.createDiv({ cls: 'csn-dash-cal-popover-grid csn-dash-cal-year-grid' });
		const yearCounts: number[] = [];
		let heatMax = 0;
		for (let y = this.calDecadeStart; y < this.calDecadeStart + 10; y++) {
			const count = this.noteCountForYear(y);
			yearCounts.push(count);
			if (count > heatMax) heatMax = count;
		}
		for (let i = 0; i < 10; i++) {
			const y = this.calDecadeStart + i;
			const count = yearCounts[i] ?? 0;
			const btn = grid.createEl('button', {
				type: 'button',
				cls: `csn-dash-cal-popover-item${y === this.calYear ? ' is-selected' : ''}`,
				text: String(y)
			});
			this.applyCalPopoverHeat(btn, count, heatMax, String(y));
			this.registerDomEvent(btn, 'click', evt => {
				evt.stopPropagation();
				this.calYear = y;
				this.closeCalPicker();
			});
		}
	}

	private renderCalMonthPopover(pickers: HTMLElement): void {
		const pop = pickers.createDiv({ cls: 'csn-dash-cal-popover csn-dash-cal-popover--month' });
		const head = pop.createDiv({ cls: 'csn-dash-cal-popover-head' });
		head.createSpan({
			cls: 'csn-dash-cal-popover-title',
			text: this.formatCalMonthText(this.calMonth0)
		});
		const grid = pop.createDiv({ cls: 'csn-dash-cal-popover-grid csn-dash-cal-month-grid' });
		const monthCounts: number[] = [];
		let heatMax = 0;
		for (let m = 0; m < 12; m++) {
			const count = this.noteCountForYearMonth(this.calYear, m);
			monthCounts.push(count);
			if (count > heatMax) heatMax = count;
		}
		for (let m = 0; m < 12; m++) {
			const count = monthCounts[m] ?? 0;
			const ym = `${this.calYear}-${String(m + 1).padStart(2, '0')}`;
			const btn = grid.createEl('button', {
				type: 'button',
				cls: `csn-dash-cal-popover-item${m === this.calMonth0 ? ' is-selected' : ''}`,
				text: this.formatCalMonthText(m)
			});
			this.applyCalPopoverHeat(btn, count, heatMax, ym);
			this.registerDomEvent(btn, 'click', evt => {
				evt.stopPropagation();
				this.calMonth0 = m;
				this.closeCalPicker();
			});
		}
	}

	private bindCalPickerOutsideClose(pickers: HTMLElement): void {
		this.detachCalPickerDocClose();
		const close = (evt: MouseEvent) => {
			const target = evt.target;
			if (target instanceof Node && pickers.contains(target)) return;
			this.calPicker = null;
			this.detachCalPickerDocClose();
			this.renderCalendar();
		};
		this.calPickerDocClose = close;
		window.setTimeout(() => {
			if (this.calPickerDocClose === close) {
				document.addEventListener('mousedown', close, true);
			}
		}, 0);
	}

	private renderCalendar(): void {
		const host = this.calendarEl;
		if (!host) return;
		host.empty();

		const head = host.createDiv({ cls: 'csn-dash-cal-head' });

		const navGroup = head.createDiv({ cls: 'csn-dash-cal-nav-group' });
		const prev = navGroup.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-cal-nav',
			attr: { 'aria-label': t('DASH_CALENDAR_PREV') }
		});
		setIcon(prev, 'chevron-left');

		const pickers = navGroup.createDiv({ cls: 'csn-dash-cal-pickers' });
		const yearBtn = pickers.createEl('button', {
			type: 'button',
			cls: `csn-dash-cal-ym csn-dash-cal-ym-year${this.calPicker === 'year' ? ' is-open' : ''}`,
			text: this.formatCalYearText(this.calYear),
			attr: {
				'aria-label': t('DASH_CALENDAR_YEAR_ARIA'),
				'aria-expanded': this.calPicker === 'year' ? 'true' : 'false'
			}
		});
		const monthBtn = pickers.createEl('button', {
			type: 'button',
			cls: `csn-dash-cal-ym csn-dash-cal-ym-month${this.calPicker === 'month' ? ' is-open' : ''}`,
			text: this.formatCalMonthText(this.calMonth0),
			attr: {
				'aria-label': t('DASH_CALENDAR_MONTH_ARIA'),
				'aria-expanded': this.calPicker === 'month' ? 'true' : 'false'
			}
		});

		if (this.calPicker === 'year') this.renderCalYearPopover(pickers);
		else if (this.calPicker === 'month') this.renderCalMonthPopover(pickers);
		if (this.calPicker) this.bindCalPickerOutsideClose(pickers);

		const next = navGroup.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-cal-nav',
			attr: { 'aria-label': t('DASH_CALENDAR_NEXT') }
		});
		setIcon(next, 'chevron-right');

		const actions = head.createDiv({ cls: 'csn-dash-cal-actions' });
		const yearFilterBtn = actions.createEl('button', {
			type: 'button',
			cls: `clickable-icon csn-dash-cal-scope-btn csn-dash-cal-scope-year${
				this.selectedDateFilter?.kind === 'year' ? ' is-active' : ''
			}`,
			attr: { 'aria-label': t('DASH_CALENDAR_SELECT_YEAR', { year: this.calYear }) }
		});
		setIcon(yearFilterBtn, 'calendar-range');
		const monthFilterBtn = actions.createEl('button', {
			type: 'button',
			cls: `clickable-icon csn-dash-cal-scope-btn csn-dash-cal-scope-month${
				this.selectedDateFilter?.kind === 'month' ? ' is-active' : ''
			}`,
			attr: {
				'aria-label': t('DASH_CALENDAR_SELECT_MONTH', {
					year: this.calYear,
					month: String(this.calMonth0 + 1).padStart(2, '0')
				})
			}
		});
		setIcon(monthFilterBtn, 'calendar');
		const heatField = this.calendarHeatField();
		const heatToggleBtn = actions.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-cal-heat-toggle',
			attr: {
				'aria-label':
					heatField === 'mtime'
						? t('DASH_CALENDAR_HEAT_MTIME_ARIA')
						: t('DASH_CALENDAR_HEAT_CTIME_ARIA')
			}
		});
		setIcon(heatToggleBtn, heatField === 'mtime' ? 'calendar-clock' : 'calendar-plus');
		const todayBtn = actions.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-dash-cal-today',
			attr: { 'aria-label': t('DASH_CALENDAR_TODAY_ARIA') }
		});
		setIcon(todayBtn, 'crosshair');

		this.registerDomEvent(prev, 'click', () => {
			this.calPicker = null;
			this.detachCalPickerDocClose();
			if (this.calMonth0 === 0) {
				this.calMonth0 = 11;
				this.calYear -= 1;
			} else {
				this.calMonth0 -= 1;
			}
			this.afterCalViewChanged();
		});
		this.registerDomEvent(next, 'click', () => {
			this.calPicker = null;
			this.detachCalPickerDocClose();
			if (this.calMonth0 === 11) {
				this.calMonth0 = 0;
				this.calYear += 1;
			} else {
				this.calMonth0 += 1;
			}
			this.afterCalViewChanged();
		});
		this.registerDomEvent(todayBtn, 'click', () => this.goToToday());
		this.registerDomEvent(heatToggleBtn, 'click', () => {
			void this.toggleCalendarHeatField();
		});
		this.registerDomEvent(yearBtn, 'click', evt => {
			evt.stopPropagation();
			this.openCalPicker('year');
		});
		this.registerDomEvent(monthBtn, 'click', evt => {
			evt.stopPropagation();
			this.openCalPicker('month');
		});
		this.registerDomEvent(yearFilterBtn, 'click', () => {
			this.setDateFilter({ kind: 'year', year: this.calYear });
		});
		this.registerDomEvent(monthFilterBtn, 'click', () => {
			this.setDateFilter({ kind: 'month', year: this.calYear, month0: this.calMonth0 });
		});

		const weekHead = host.createDiv({ cls: 'csn-dash-cal-week' });
		for (const d of weekdayMinLabels()) {
			weekHead.createSpan({ cls: 'csn-dash-cal-weekday', text: d });
		}

		const grid = host.createDiv({ cls: 'csn-dash-cal-grid' });
		const todayKey = localDateKeyFromMs(Date.now());
		const heatMax = this.calendarHeatMax();
		const rows = buildMonthWeekRows(this.calYear, this.calMonth0);
		for (const row of rows) {
			for (const day of row) {
				const key = localDateKeyFromMs(new Date(day.y, day.m0, day.d).getTime());
				const count = this.noteDateCounts.get(key) ?? 0;
				const level = heatmapLevelFromCount(count, heatMax);
				const cell = grid.createEl('button', {
					type: 'button',
					cls: `csn-dash-cal-cell csn-dash-cal-day${day.inMonth ? '' : ' is-outside'}${
						level > 0 ? ` heat-${level}` : ''
					}`,
					text: String(day.d),
					attr: {
						'data-csn-date': key,
						'aria-label':
							count > 0
								? t('DASH_CALENDAR_DAY_ARIA', { date: key, count })
								: t('DASH_CALENDAR_DAY_ARIA_EMPTY', { date: key })
					}
				});
				if (count > 0) cell.title = t('DASH_CALENDAR_DAY_ARIA', { date: key, count });
				if (key === todayKey) cell.addClass('is-today');
				if (this.isDateKeySelected(key)) cell.addClass('is-selected');
				this.registerDomEvent(cell, 'click', (evt: MouseEvent) => {
					if (!day.inMonth) {
						this.calYear = day.y;
						this.calMonth0 = day.m0;
					}
					if (evt.shiftKey) {
						this.selectDayRangeFromAnchor(key);
						return;
					}
					if (evt.ctrlKey || evt.metaKey) {
						this.toggleDayMultiSelect(key);
						return;
					}
					this.lastCalDateClickKey = key;
					this.setDateFilter({ kind: 'day', dateKey: key });
				});
			}
		}

		this.updateCalendarMarks();
		if (this.isDateFilterPanelOpen()) {
			this.syncDateFilterModeLabels();
			this.fillDateFilterInputDefault(true);
		}
	}

	private updateCalendarMarks(): void {
		const host = this.calendarEl;
		if (!host) return;

		for (const el of Array.from(host.querySelectorAll('button.csn-dash-cal-cell[data-csn-date]'))) {
			if (!(el instanceof HTMLElement)) continue;
			const key = el.dataset.csnDate;
			if (!key) continue;
			this.syncDayCellHeat(el, key);
			el.toggleClass('is-selected', this.isDateKeySelected(key));
			el.toggleClass('is-today', key === localDateKeyFromMs(Date.now()));
		}

		host.querySelector('.csn-dash-cal-scope-year')?.toggleClass(
			'is-active',
			this.selectedDateFilter?.kind === 'year'
		);
		host.querySelector('.csn-dash-cal-scope-month')?.toggleClass(
			'is-active',
			this.selectedDateFilter?.kind === 'month'
		);

		this.syncDateFilterBar();
	}

	private formatDateFilterChipLabel(filter: StickyDateFilter): string {
		switch (filter.kind) {
			case 'year':
				return t('DASH_DATE_FILTER_YEAR', { year: filter.year });
			case 'month':
				return t('DASH_DATE_FILTER_MONTH', {
					year: filter.year,
					n: filter.month0 + 1,
					month: String(filter.month0 + 1).padStart(2, '0')
				});
			case 'week':
				return t('DASH_DATE_FILTER_WEEK', { year: filter.year, week: filter.week });
			case 'day':
				return filter.dateKey;
			case 'days':
				return filter.dateKeys.join(', ');
		}
	}

	private removeDateFilterChip(removeKey: string): void {
		const f = this.selectedDateFilter;
		if (!f) return;
		if (f.kind === 'days') {
			this.toggleDayMultiSelect(removeKey);
			return;
		}
		if (f.kind === 'day' && f.dateKey === removeKey) {
			this.clearDateFilter();
			return;
		}
		if (removeKey === 'all' || removeKey === stickyDateFilterKey(f)) {
			this.clearDateFilter();
		}
	}

	/** 追加日期到筛选（支持连续多加，不切换移除）。 */
	private addDateToFilter(dateKey: string): void {
		const key = dateKey.trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
		const cur = this.selectedDateFilter;
		const keys = new Set<string>();
		if (cur?.kind === 'day') keys.add(cur.dateKey);
		else if (cur?.kind === 'days') {
			for (const k of cur.dateKeys) keys.add(k);
		}
		keys.add(key);
		if (keys.size === 1) {
			this.applyDateFilter({ kind: 'day', dateKey: [...keys][0]! });
		} else {
			this.applyDateFilter({ kind: 'days', dateKeys: [...keys].sort() });
		}
	}

	private setDateFilterAddMode(mode: 'day' | 'month' | 'year'): void {
		if (this.dateFilterAddMode === mode) {
			this.syncDateFilterAddModeUi();
			return;
		}
		this.dateFilterAddMode = mode;
		this.syncDateFilterAddModeUi();
		this.fillDateFilterInputDefault(true);
		window.setTimeout(() => this.dateFilterInput?.focus(), 0);
	}

	/** 默认值跟随日历当前年/月（csn-dash-cal-ym），按模式写入对应控件格式。 */
	private fillDateFilterInputDefault(force = false): void {
		const input = this.dateFilterInput;
		if (!input) return;
		if (!force && input.value) return;
		const now = new Date();
		const y = this.calYear;
		const m0 = this.calMonth0;
		const m = String(m0 + 1).padStart(2, '0');
		let day = 1;
		if (now.getFullYear() === y && now.getMonth() === m0) {
			day = now.getDate();
		}
		const d = String(day).padStart(2, '0');
		/* 三种模式共用 date 控件外观，提交时再按粒度取值 */
		input.value = `${y}-${m}-${d}`;
	}

	private syncDateFilterModeLabels(): void {
		const yearBtn = this.dateFilterModeBtns.get('year');
		const monthBtn = this.dateFilterModeBtns.get('month');
		const dayBtn = this.dateFilterModeBtns.get('day');
		if (dayBtn) dayBtn.setText(t('DASH_DATE_FILTER_MODE_DAY'));
		if (monthBtn) monthBtn.setText(t('DASH_DATE_FILTER_MODE_MONTH'));
		if (yearBtn) yearBtn.setText(t('DASH_DATE_FILTER_MODE_YEAR'));
	}

	private syncDateFilterAddModeUi(): void {
		const mode = this.dateFilterAddMode;
		this.syncDateFilterModeLabels();
		for (const [id, btn] of this.dateFilterModeBtns) {
			btn.toggleClass('is-active', id === mode);
			btn.setAttr('aria-pressed', id === mode ? 'true' : 'false');
		}
		const input = this.dateFilterInput;
		if (!input) return;
		input.type = 'date';
		input.removeAttribute('min');
		input.removeAttribute('max');
		input.removeAttribute('step');
		if (mode === 'day') {
			input.setAttr('aria-label', t('DASH_DATE_FILTER_INPUT_ARIA'));
		} else if (mode === 'month') {
			input.setAttr('aria-label', t('DASH_DATE_FILTER_MONTH_INPUT_ARIA'));
		} else {
			input.setAttr('aria-label', t('DASH_DATE_FILTER_YEAR_INPUT_ARIA'));
		}
	}

	/** 日期筛选粒度：数值越大范围越大。大范围不得覆盖小范围。 */
	private dateFilterScopeRank(filter: StickyDateFilter | null): number {
		if (!filter) return 0;
		switch (filter.kind) {
			case 'year':
				return 3;
			case 'month':
			case 'week':
				return 2;
			case 'day':
			case 'days':
				return 1;
		}
	}

	/** + 面板提交；大范围不会覆盖已有更小范围。 */
	private commitDateFilterFromPanel(): void {
		const raw = this.dateFilterInput?.value?.trim() ?? '';
		if (!raw) return;
		const mode = this.dateFilterAddMode;
		const curRank = this.dateFilterScopeRank(this.selectedDateFilter);

		const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
		if (!parts) return;
		const year = Number(parts[1]);
		const month0 = Number(parts[2]) - 1;

		if (mode === 'day') {
			this.calYear = year;
			this.calMonth0 = month0;
			this.addDateToFilter(raw);
		} else if (mode === 'month') {
			if (!Number.isFinite(year) || month0 < 0 || month0 > 11) return;
			if (curRank > 0 && curRank < 2) {
				new Notice(t('DASH_DATE_FILTER_NO_OVERWRITE_SMALLER'));
				return;
			}
			this.calYear = year;
			this.calMonth0 = month0;
			this.applyDateFilter({ kind: 'month', year, month0 });
		} else {
			if (!Number.isInteger(year) || year < 1970 || year > 2100) return;
			if (curRank > 0 && curRank < 3) {
				new Notice(t('DASH_DATE_FILTER_NO_OVERWRITE_SMALLER'));
				return;
			}
			this.calYear = year;
			this.applyDateFilter({ kind: 'year', year });
		}
		this.dateFilterPanelGroup = 'selected';
		if (this.isDateFilterPanelOpen()) this.renderDateFilterPanelBody();
		window.setTimeout(() => this.dateFilterInput?.focus(), 0);
	}

	private isDateFilterPanelOpen(): boolean {
		return !!this.dateFilterPanelEl && !this.dateFilterPanelEl.hasClass('csn-dash-date-filter-panel--hidden');
	}

	private buildDateFilterPanel(host: HTMLElement): void {
		const panel = host.createDiv({
			cls: 'csn-dash-date-filter-panel csn-dash-date-filter-panel--hidden',
			attr: {
				id: 'csn-dash-date-filter-panel',
				role: 'dialog',
				'aria-label': t('DASH_DATE_FILTER_PANEL_ARIA')
			}
		});
		this.dateFilterPanelEl = panel;

		const tools = panel.createDiv({ cls: 'csn-dash-filter-panel-tools' });
		const row = tools.createDiv({ cls: 'csn-dash-date-filter-panel-row' });
		const modeRow = row.createDiv({ cls: 'csn-dash-date-filter-mode' });
		this.dateFilterModeEl = modeRow;
		this.dateFilterModeBtns.clear();
		const mkMode = (id: 'day' | 'month' | 'year', labelKey: MessageKey) => {
			const btn = modeRow.createEl('button', {
				type: 'button',
				cls: 'csn-dash-date-filter-mode-btn',
				text: t(labelKey),
				attr: {
					'data-csn-date-filter-mode': id,
					'aria-pressed': id === this.dateFilterAddMode ? 'true' : 'false'
				}
			});
			this.dateFilterModeBtns.set(id, btn);
			this.registerDomEvent(btn, 'click', (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.setDateFilterAddMode(id);
			});
		};
		mkMode('day', 'DASH_DATE_FILTER_MODE_DAY');
		mkMode('month', 'DASH_DATE_FILTER_MODE_MONTH');
		mkMode('year', 'DASH_DATE_FILTER_MODE_YEAR');

		this.dateFilterInput = row.createEl('input', {
			type: 'date',
			cls: 'csn-dash-date-filter-input',
			attr: { 'aria-label': t('DASH_DATE_FILTER_INPUT_ARIA') }
		});
		this.dateFilterConfirmBtn = row.createEl('button', {
			type: 'button',
			cls: 'csn-dash-date-filter-confirm-btn',
			attr: { 'aria-label': t('DASH_DATE_FILTER_CONFIRM_ARIA') }
		});
		setIcon(this.dateFilterConfirmBtn, 'check');
		this.registerDomEvent(this.dateFilterInput, 'click', (evt: MouseEvent) => {
			evt.stopPropagation();
		});
		this.registerDomEvent(this.dateFilterInput, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key !== 'Enter') return;
			evt.preventDefault();
			this.commitDateFilterFromPanel();
		});
		this.registerDomEvent(this.dateFilterConfirmBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.commitDateFilterFromPanel();
		});

		const body = panel.createDiv({ cls: 'csn-dash-filter-panel-body' });
		this.dateFilterPanelGroupsEl = body.createDiv({ cls: 'csn-dash-filter-panel-groups' });
		const mkGroup = (id: 'selected' | 'add', labelKey: MessageKey) => {
			const btn = this.dateFilterPanelGroupsEl!.createEl('button', {
				type: 'button',
				cls: 'csn-dash-filter-panel-group-btn',
				attr: { 'data-csn-date-group': id }
			});
			btn.createSpan({ cls: 'csn-dash-filter-panel-group-label', text: t(labelKey) });
			btn.createSpan({ cls: 'csn-dash-filter-panel-group-count', text: '0' });
			this.registerDomEvent(btn, 'click', () => {
				this.dateFilterPanelGroup = id;
				this.renderDateFilterPanelBody();
				if (id === 'add') window.setTimeout(() => this.dateFilterInput?.focus(), 0);
			});
		};
		mkGroup('selected', 'DASH_DATE_FILTER_GROUP_SELECTED');
		mkGroup('add', 'DASH_DATE_FILTER_GROUP_ADD');

		this.dateFilterPanelListEl = body.createDiv({ cls: 'csn-dash-filter-panel-list' });

		const foot = panel.createDiv({ cls: 'csn-dash-filter-panel-foot' });
		foot.createSpan({ cls: 'csn-dash-filter-panel-hint', text: t('DASH_DATE_FILTER_HINT_APPEND') });
		foot.createSpan({
			cls: 'csn-dash-filter-panel-hint csn-dash-filter-panel-hint--end',
			text: t('DASH_TAG_HINT_CLOSE')
		});

		this.syncDateFilterAddModeUi();
		this.fillDateFilterInputDefault(true);
		this.renderDateFilterPanelBody();
	}

	private collectDateFilterPanelRows(): { label: string; removeKey: string }[] {
		const f = this.selectedDateFilter;
		if (!f) return [];
		if (f.kind === 'days') return [...f.dateKeys].sort().map(key => ({ label: key, removeKey: key }));
		if (f.kind === 'day') return [{ label: f.dateKey, removeKey: f.dateKey }];
		return [{ label: this.formatDateFilterChipLabel(f), removeKey: stickyDateFilterKey(f) }];
	}

	/** 日期面板：已选列表 / 添加引导，布局对齐标签选择器。 */
	private renderDateFilterPanelBody(): void {
		const groupsEl = this.dateFilterPanelGroupsEl;
		const listEl = this.dateFilterPanelListEl;
		if (!groupsEl || !listEl) return;

		const rows = this.collectDateFilterPanelRows();
		for (const btn of Array.from(groupsEl.querySelectorAll('.csn-dash-filter-panel-group-btn'))) {
			if (!(btn instanceof HTMLElement)) continue;
			const id = btn.dataset.csnDateGroup;
			const countEl = btn.querySelector('.csn-dash-filter-panel-group-count');
			if (countEl) {
				countEl.setText(String(id === 'selected' ? rows.length : '·'));
			}
			btn.toggleClass('is-active', this.dateFilterPanelGroup === id);
		}

		listEl.empty();
		if (this.dateFilterPanelGroup === 'add') {
			listEl.createDiv({
				cls: 'csn-dash-filter-panel-empty',
				text: t('DASH_DATE_FILTER_ADD_GUIDE')
			});
			return;
		}
		if (rows.length === 0) {
			listEl.createDiv({
				cls: 'csn-dash-filter-panel-empty',
				text: t('DASH_DATE_FILTER_SELECTED_EMPTY')
			});
			return;
		}
		for (const row of rows) {
			const item = listEl.createEl('button', {
				type: 'button',
				cls: 'csn-dash-filter-panel-item is-selected',
				attr: { 'aria-label': row.label }
			});
			const check = item.createSpan({
				cls: 'csn-dash-filter-panel-item-check',
				attr: { 'aria-hidden': 'true' }
			});
			setIcon(check, 'check-square');
			const icon = item.createSpan({
				cls: 'csn-dash-filter-panel-item-icon',
				attr: { 'aria-hidden': 'true' }
			});
			setIcon(icon, 'calendar');
			item.createSpan({ cls: 'csn-dash-filter-panel-item-label', text: row.label });
			this.registerDomEvent(item, 'click', (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.removeDateFilterChip(row.removeKey);
			});
		}
	}

	private openDateFilterPanel(opts?: { group?: 'selected' | 'add' }): void {
		const panel = this.dateFilterPanelEl;
		const btn = this.dateFilterAddBtn;
		if (!panel) return;
		if (opts?.group) this.dateFilterPanelGroup = opts.group;
		this.renderDateFilterPanelBody();
		this.syncDateFilterAddModeUi();
		this.fillDateFilterInputDefault(false);
		panel.removeClass('csn-dash-date-filter-panel--hidden');
		btn?.addClass('is-active');
		btn?.setAttr('aria-expanded', 'true');
		window.setTimeout(() => this.dateFilterInput?.focus(), 0);
	}

	private closeDateFilterPanel(): void {
		const panel = this.dateFilterPanelEl;
		const btn = this.dateFilterAddBtn;
		if (!panel || panel.hasClass('csn-dash-date-filter-panel--hidden')) return;
		panel.addClass('csn-dash-date-filter-panel--hidden');
		btn?.removeClass('is-active');
		btn?.setAttr('aria-expanded', 'false');
	}

	private toggleDateFilterPanel(): void {
		if (this.isDateFilterPanelOpen()) this.closeDateFilterPanel();
		else this.openDateFilterPanel({ group: 'add' });
	}

	private syncDateFilterBar(): void {
		const chipsEl = this.dateFilterChipsEl;
		const addBtn = this.dateFilterAddBtn;
		if (addBtn) {
			/* 仅面板打开时高亮；已选日期用 chips 表达，勿点亮 + */
			addBtn.toggleClass('is-active', this.isDateFilterPanelOpen());
			addBtn.setAttr('aria-expanded', this.isDateFilterPanelOpen() ? 'true' : 'false');
		}
		if (this.isDateFilterPanelOpen()) this.renderDateFilterPanelBody();
		if (!chipsEl) return;
		chipsEl.empty();
		const f = this.selectedDateFilter;
		if (!f) return;

		const dayCount = f.kind === 'days' ? f.dateKeys.length : 1;
		if (dayCount > 1 && f.kind === 'days') {
			this.appendFilterMoreChip(
				chipsEl,
				'csn-dash-date-filter-chip',
				dayCount,
				() => this.openDateFilterPanel({ group: 'selected' }),
				() => this.clearDateFilter(),
				t('DASH_DATE_FILTER_CLEAR_ARIA')
			);
			return;
		}

		const addChip = (label: string, removeKey: string) => {
			const chip = chipsEl.createEl('button', {
				type: 'button',
				cls: 'csn-dash-date-filter-chip',
				attr: {
					title: label,
					'aria-label': label
				}
			});
			chip.createSpan({ cls: 'csn-dash-date-filter-chip-text', text: label });
			const remove = chip.createEl('span', {
				cls: 'csn-dash-date-filter-chip-remove',
				attr: {
					role: 'button',
					tabindex: '0',
					'data-csn-date-chip-remove': removeKey,
					'aria-label': t('DASH_DATE_FILTER_CHIP_REMOVE_ARIA', { label })
				}
			});
			setIcon(remove, 'x');
		};

		if (f.kind === 'day') {
			addChip(f.dateKey, f.dateKey);
			return;
		}
		if (f.kind === 'days') {
			addChip(f.dateKeys[0]!, f.dateKeys[0]!);
			return;
		}
		addChip(this.formatDateFilterChipLabel(f), stickyDateFilterKey(f));
	}

	private workspaceSelEquals(other: DashWorkspaceSel): boolean {
		if (this.workspaceSel.kind !== other.kind) return false;
		if (other.kind === 'all') return true;
		if (other.kind !== 'selection' || this.workspaceSel.kind !== 'selection') return false;
		const a = this.workspaceSel;
		const sameSorted = (x: string[], y: string[]) => {
			if (x.length !== y.length) return false;
			const sx = [...x].sort();
			const sy = [...y].sort();
			return sx.every((v, i) => v === sy[i]);
		};
		return (
			sameSorted(a.groupIds, other.groupIds) && sameSorted(a.workspaceIds, other.workspaceIds)
		);
	}

	private isGroupSelActive(groupId: string): boolean {
		return (
			this.workspaceSel.kind === 'selection' && this.workspaceSel.groupIds.includes(groupId)
		);
	}

	private isWorkspaceSelActive(workspaceId: string): boolean {
		return (
			this.workspaceSel.kind === 'selection' &&
			this.workspaceSel.workspaceIds.includes(workspaceId)
		);
	}

	/** 单击切换；Ctrl/Cmd 多选；再次单击已选项则取消。 */
	private clickWorkspaceTreeSel(
		target: { kind: 'group'; id: string } | { kind: 'workspace'; id: string },
		multi: boolean
	): void {
		const cur = this.workspaceSel;
		if (!multi) {
			const alone =
				cur.kind === 'selection' &&
				((target.kind === 'group' &&
					cur.groupIds.length === 1 &&
					cur.workspaceIds.length === 0 &&
					cur.groupIds[0] === target.id) ||
					(target.kind === 'workspace' &&
						cur.workspaceIds.length === 1 &&
						cur.groupIds.length === 0 &&
						cur.workspaceIds[0] === target.id));
			if (alone) {
				this.setWorkspaceSel({ kind: 'all' });
				return;
			}
			this.setWorkspaceSel(
				target.kind === 'group'
					? { kind: 'selection', groupIds: [target.id], workspaceIds: [] }
					: { kind: 'selection', groupIds: [], workspaceIds: [target.id] }
			);
			return;
		}

		const groupIds = cur.kind === 'selection' ? [...cur.groupIds] : [];
		const workspaceIds = cur.kind === 'selection' ? [...cur.workspaceIds] : [];
		if (target.kind === 'group') {
			const i = groupIds.indexOf(target.id);
			if (i >= 0) groupIds.splice(i, 1);
			else groupIds.push(target.id);
		} else {
			const i = workspaceIds.indexOf(target.id);
			if (i >= 0) workspaceIds.splice(i, 1);
			else workspaceIds.push(target.id);
		}
		if (groupIds.length === 0 && workspaceIds.length === 0) {
			this.setWorkspaceSel({ kind: 'all' });
			return;
		}
		this.setWorkspaceSel({ kind: 'selection', groupIds, workspaceIds });
	}

	/** 供外部在工作区变更后刷新左侧树。 */
	refreshWorkspaceTree(): void {
		this.renderWorkspaceTree();
	}

	/** 仅更新树节点成员数量，避免 `treeEl.empty()` 造成侧栏闪烁。 */
	syncWorkspaceTreeMemberCounts(): void {
		const host = this.treeEl;
		if (!host) return;
		const mgr = this.plugin.stickies;
		const file = mgr.workspaces;
		for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-csn-ws-id]'))) {
			const id = el.dataset.csnWsId;
			if (!id) continue;
			const ws =
				file.workspaces.find(w => w.id === id) ?? file.trash.find(w => w.id === id);
			if (!ws) continue;
			const countEl = el.querySelector('.csn-dash-tree-count:not(.csn-dash-tree-count--toggle)');
			if (countEl instanceof HTMLElement) {
				countEl.setText(String(mgr.getWorkspaceMemberPathSet(ws).size));
			}
		}
	}

	private openWsTreeSortMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const spec of DASH_WS_TREE_SORT_SPECS) {
			menu.addItem(item => {
				item
					.setTitle(t(spec.titleKey))
					.setIcon(spec.menuIcon)
					.setChecked(spec.mode === this.wsTreeSortMode)
					.onClick(() => {
						this.wsTreeSortMode = spec.mode;
						this.syncWsTreeSortBtn();
						this.renderWorkspaceTree();
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private syncWsTreeSortBtn(): void {
		const btn = this.wsTreeSortBtn;
		if (!btn) return;
		const spec = DASH_WS_TREE_SORT_SPECS.find(s => s.mode === this.wsTreeSortMode) ?? DASH_WS_TREE_SORT_SPECS[0]!;
		btn.empty();
		setIcon(btn, this.wsTreeSortMode === 'manual' ? 'arrow-up-down' : spec.menuIcon);
		btn.toggleClass('is-active', this.wsTreeSortMode !== 'manual');
		btn.setAttr('aria-label', t('DASH_WS_SORT_ARIA_WITH', { title: t(spec.titleKey) }));
	}

	private allWsTreeGroupsCollapsed(groupIds: readonly string[]): boolean {
		if (groupIds.length === 0) return false;
		return groupIds.every(id => this.collapsedGroupIds.has(id));
	}

	private syncWsTreeCollapseBtn(groupIds?: readonly string[]): void {
		const btn = this.wsTreeCollapseBtn;
		if (!btn) return;
		const ids =
			groupIds ??
			(this.plugin.stickies.workspaces.tabGroups.length > 0
				? this.plugin.stickies.workspaces.tabGroups.map(g => g.id)
				: [WS_TAB_GROUP_DEFAULT_ID]);
		const allCollapsed = this.allWsTreeGroupsCollapsed(ids);
		btn.empty();
		setIcon(btn, allCollapsed ? 'chevrons-up-down' : 'chevrons-down-up');
		btn.setAttr(
			'aria-label',
			allCollapsed ? t('DASH_WS_EXPAND_ALL_ARIA') : t('DASH_WS_COLLAPSE_ALL_ARIA')
		);
		/* 仅切换图标，不高亮 */
		btn.removeClass('is-active');
	}

	private toggleWsTreeCollapseAll(): void {
		const file = this.plugin.stickies.workspaces;
		const groupIds =
			file.tabGroups.length > 0
				? file.tabGroups.map(g => g.id)
				: [WS_TAB_GROUP_DEFAULT_ID];
		if (this.allWsTreeGroupsCollapsed(groupIds)) {
			this.collapsedGroupIds.clear();
		} else {
			for (const id of groupIds) this.collapsedGroupIds.add(id);
		}
		this.persistCollapsedGroups();
		this.syncWsTreeCollapseBtn(groupIds);
		this.renderWorkspaceTree();
	}

	private toggleWsTreeShowArchived(): void {
		this.wsTreeShowArchived = !this.wsTreeShowArchived;
		/* 切换列表模式时清空选中，避免跨模式残留筛选 */
		this.setWorkspaceSel({ kind: 'all' });
		this.syncWsTreeShowArchivedBtn();
		this.renderWorkspaceTree();
	}

	private syncWsTreeShowArchivedBtn(): void {
		const btn = this.wsTreeShowArchivedBtn;
		if (!btn) return;
		const on = this.wsTreeShowArchived;
		btn.toggleClass('is-active', on);
		btn.setAttr('aria-pressed', on ? 'true' : 'false');
		btn.setAttr('aria-label', on ? t('DASH_WS_HIDE_ARCHIVED_ARIA') : t('DASH_WS_SHOW_ARCHIVED_ARIA'));
		btn.title = on ? t('DASH_WS_HIDE_ARCHIVED_ARIA') : t('DASH_WS_SHOW_ARCHIVED_ARIA');
		this.wsTreeCollapseBtn?.toggleClass('csn-dash-ws-action-btn--hidden', on);
		const addBtn = this.wsTreeAddBtn;
		if (addBtn) {
			addBtn.removeClass('csn-dash-ws-add-btn--hidden');
			addBtn.setAttr(
				'aria-label',
				on ? t('DASH_WS_NEW_ARCHIVED_GROUP_ARIA') : t('DASH_WS_NEW_ARIA')
			);
			addBtn.title = on ? t('DASH_WS_NEW_ARCHIVED_GROUP_ARIA') : t('DASH_WS_NEW_ARIA');
		}
		const titleBtn = this.leftPanelTitleBtns.get('workspace');
		const titleText = titleBtn?.querySelector('.csn-dash-panel-title-text');
		if (titleText instanceof HTMLElement) {
			titleText.setText(on ? t('DASH_WS_ARCHIVED_SECTION') : t('DASH_WS_TREE_TITLE'));
		}
	}

	private loadCollapsedGroupsFromSettings(): void {
		const ids = this.plugin.settings.dashboardCollapsedWorkspaceGroupIds;
		this.collapsedGroupIds = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
	}

	private persistCollapsedGroups(): void {
		this.plugin.settings.dashboardCollapsedWorkspaceGroupIds = [...this.collapsedGroupIds];
		void this.plugin.saveSettings();
	}

	private loadCollapsedLeftPanelsFromSettings(): void {
		const allowed: DashLeftPanelId[] = ['area', 'workspace'];
		const ids = this.plugin.settings.dashboardCollapsedLeftPanelIds;
		this.collapsedLeftPanels = new Set(
			(Array.isArray(ids) ? ids : []).filter((id): id is DashLeftPanelId =>
				allowed.includes(id as DashLeftPanelId)
			)
		);
	}

	private persistCollapsedLeftPanels(): void {
		this.plugin.settings.dashboardCollapsedLeftPanelIds = [...this.collapsedLeftPanels];
		void this.plugin.saveSettings();
	}

	private leftPanelEl(id: DashLeftPanelId): HTMLElement | null {
		if (id === 'area') return this.areaPanelEl;
		return this.wsPanelEl;
	}

	private leftPanelTitle(id: DashLeftPanelId): string {
		if (id === 'area') return t('DASH_AREA_LABEL');
		return t('DASH_WS_TREE_TITLE');
	}

	private mountLeftPanel(
		parent: HTMLElement,
		id: DashLeftPanelId,
		title: string,
		opts?: {
			grow?: boolean;
			headExtra?: (head: HTMLElement) => void;
		}
	): { panel: HTMLElement; body: HTMLElement; titleBtn: HTMLButtonElement } {
		const panel = parent.createDiv({
			cls: `csn-dash-panel csn-dash-panel--${id}${opts?.grow ? ' csn-dash-panel--grow' : ''}`
		});
		const head = panel.createDiv({ cls: 'csn-dash-panel-head' });
		const titleBtn = head.createEl('button', {
			type: 'button',
			cls: 'csn-dash-panel-title',
			attr: {
				'aria-expanded': 'true',
				'aria-label': t('DASH_LEFT_PANEL_TOGGLE_ARIA', { title })
			}
		});
		const chevron = titleBtn.createSpan({ cls: 'csn-dash-panel-chevron', attr: { 'aria-hidden': 'true' } });
		setIcon(chevron, 'chevron-down');
		titleBtn.createSpan({ cls: 'csn-dash-panel-title-text', text: title });
		this.leftPanelTitleBtns.set(id, titleBtn);
		opts?.headExtra?.(head);
		const body = panel.createDiv({ cls: 'csn-dash-panel-body' });
		this.registerDomEvent(titleBtn, 'click', () => this.toggleLeftPanel(id));
		return { panel, body, titleBtn };
	}

	private toggleLeftPanel(id: DashLeftPanelId): void {
		if (this.collapsedLeftPanels.has(id)) this.collapsedLeftPanels.delete(id);
		else this.collapsedLeftPanels.add(id);
		this.persistCollapsedLeftPanels();
		this.applyLeftPanelCollapsedClass(id);
	}

	private applyLeftPanelCollapsedClass(id: DashLeftPanelId): void {
		const panel = this.leftPanelEl(id);
		const titleBtn = this.leftPanelTitleBtns.get(id);
		const collapsed = this.collapsedLeftPanels.has(id);
		panel?.toggleClass('is-collapsed', collapsed);
		titleBtn?.setAttr('aria-expanded', collapsed ? 'false' : 'true');
		const chevron = titleBtn?.querySelector('.csn-dash-panel-chevron');
		if (chevron instanceof HTMLElement) {
			chevron.empty();
			setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
		}
		titleBtn?.setAttr(
			'aria-label',
			t('DASH_LEFT_PANEL_TOGGLE_ARIA', { title: this.leftPanelTitle(id) })
		);
	}

	private applyAllLeftPanelCollapsedClasses(): void {
		for (const id of ['area', 'workspace'] as const) {
			this.applyLeftPanelCollapsedClass(id);
		}
	}

	private sortWorkspacesForTree(list: StickyWorkspace[]): StickyWorkspace[] {
		if (this.wsTreeSortMode === 'manual') return list;
		const arr = [...list];
		if (this.wsTreeSortMode === 'name-asc') {
			arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		} else if (this.wsTreeSortMode === 'name-desc') {
			arr.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }));
		} else {
			arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		}
		return arr;
	}

	/** 按当前树排序模式排列分组（最近更新取组内工作区最新 mtime）。 */
	private sortGroupsForTree(
		groups: StickyWorkspaceTabGroup[],
		workspaces: readonly StickyWorkspace[]
	): StickyWorkspaceTabGroup[] {
		if (this.wsTreeSortMode === 'manual' || groups.length <= 1) return groups;
		const arr = [...groups];
		if (this.wsTreeSortMode === 'name-asc') {
			arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		} else if (this.wsTreeSortMode === 'name-desc') {
			arr.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }));
		} else {
			const maxMtime = (g: StickyWorkspaceTabGroup): number => {
				let m = 0;
				for (const ws of workspaces) {
					if (resolveWorkspaceTabGroupId(ws, groups) !== g.id) continue;
					m = Math.max(m, ws.updatedAt ?? 0);
				}
				return m;
			};
			arr.sort((a, b) => maxMtime(b) - maxMtime(a));
		}
		return arr;
	}

	private snapshotDashboardFilters(): DashboardFilterState {
		return normalizeDashboardFilterState({
			areaMode: this.areaMode,
			archiveFilter: this.archiveFilter,
			colorFilters: [...this.colorFilters],
			workspaceSel: this.workspaceSel,
			tagIncludeFilters: [...this.tagIncludeFilters],
			tagExcludeFilters: [...this.tagExcludeFilters],
			tagFilterLogic: this.tagFilterLogic,
			workspaceFilterLogic: this.workspaceFilterLogic,
			dateFilter: this.selectedDateFilter,
			searchQuery: this.searchInput?.value ?? this.plugin.settings.dashboardFilters.searchQuery
		});
	}

	private persistDashboardFilters(): void {
		const next = this.snapshotDashboardFilters();
		if (dashboardFilterStateKey(next) === dashboardFilterStateKey(this.plugin.settings.dashboardFilters)) {
			return;
		}
		this.plugin.settings.dashboardFilters = next;
		void this.plugin.saveSettings();
	}

	private restoreDashboardFiltersFromSettings(): void {
		const saved = normalizeDashboardFilterState(this.plugin.settings.dashboardFilters);
		this.areaMode = saved.areaMode;
		this.archiveFilter = saved.areaMode === 'archived' ? 'archived' : saved.archiveFilter;
		this.colorFilters = [...saved.colorFilters];
		this.tagIncludeFilters = [...saved.tagIncludeFilters];
		this.tagExcludeFilters = [...saved.tagExcludeFilters];
		this.tagFilterLogic = saved.tagFilterLogic;
		this.workspaceFilterLogic = saved.workspaceFilterLogic;
		this.selectedDateFilter = saved.dateFilter;
		if (saved.dateFilter?.kind === 'day') {
			this.lastCalDateClickKey = saved.dateFilter.dateKey;
		} else if (saved.dateFilter?.kind === 'days' && saved.dateFilter.dateKeys.length > 0) {
			this.lastCalDateClickKey = saved.dateFilter.dateKeys[saved.dateFilter.dateKeys.length - 1]!;
		} else {
			this.lastCalDateClickKey = null;
		}
		this.applySavedDateFilterToCalendar(saved.dateFilter);
		this.workspaceSel = this.pruneWorkspaceSel(saved.workspaceSel);
		this.syncWorkspaceLogicButtons();
		this.ensureVisibleAreaMode();
		this.plugin.settings.dashboardFilters = {
			...saved,
			areaMode: this.areaMode,
			workspaceSel: this.workspaceSel,
			archiveFilter: this.archiveFilter
		};
	}

	private pruneWorkspaceSel(sel: DashWorkspaceSel): DashWorkspaceSel {
		if (sel.kind !== 'selection') return { kind: 'all' };
		const file = this.plugin.stickies?.workspaces;
		if (!file) return sel;
		const liveWs = new Set(file.workspaces.map(w => w.id));
		const liveGroups = new Set(file.tabGroups.map(g => g.id));
		const workspaceIds = sel.workspaceIds.filter(id => liveWs.has(id));
		const groupIds = sel.groupIds.filter(id => liveGroups.has(id) || id === WS_TAB_GROUP_UNGROUPED_ID);
		if (workspaceIds.length === 0 && groupIds.length === 0) return { kind: 'all' };
		return { kind: 'selection', groupIds, workspaceIds };
	}

	private applySavedDateFilterToCalendar(filter: DashboardFilterState['dateFilter']): void {
		if (!filter) return;
		if (filter.kind === 'year' || filter.kind === 'week') {
			this.calYear = filter.year;
			return;
		}
		if (filter.kind === 'month') {
			this.calYear = filter.year;
			this.calMonth0 = filter.month0;
			return;
		}
		const key = filter.kind === 'day' ? filter.dateKey : filter.dateKeys[0];
		if (!key) return;
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
		if (!m) return;
		this.calYear = Number(m[1]);
		this.calMonth0 = Math.max(0, Math.min(11, Number(m[2]) - 1));
	}

	private setWorkspaceSel(next: DashWorkspaceSel): void {
		if (this.workspaceSelEquals(next)) return;
		this.workspaceSel = next;
		/* 点工作区树时退出智能区域；归档筛选保持用户当前选择 */
		if (next.kind !== 'all') {
			this.areaMode = 'all';
			this.randomOrderPaths = null;
		}
		this.listPageIndex = 0;
		this.syncAreaButtons();
		this.syncArchiveFilterButtons();
		this.syncWorkspaceFilterBar();
		this.renderWorkspaceTree();
		void this.renderDash();
	}

	private removeWorkspaceFilterChip(kind: 'group' | 'workspace', id: string): void {
		const cur = this.workspaceSel;
		if (cur.kind !== 'selection') return;
		const groupIds =
			kind === 'group' ? cur.groupIds.filter(g => g !== id) : [...cur.groupIds];
		const workspaceIds =
			kind === 'workspace' ? cur.workspaceIds.filter(w => w !== id) : [...cur.workspaceIds];
		if (groupIds.length === 0 && workspaceIds.length === 0) {
			this.setWorkspaceSel({ kind: 'all' });
			return;
		}
		this.setWorkspaceSel({ kind: 'selection', groupIds, workspaceIds });
	}

	/** + 面板「全部」：仅追加，不覆盖、不切换取消。 */
	private appendWorkspaceFilterSel(
		target: { kind: 'group'; id: string } | { kind: 'workspace'; id: string }
	): void {
		if (target.kind === 'group') {
			if (this.isGroupSelActive(target.id)) return;
		} else if (this.isWorkspaceSelActive(target.id)) {
			return;
		}
		const cur = this.workspaceSel;
		const groupIds = cur.kind === 'selection' ? [...cur.groupIds] : [];
		const workspaceIds = cur.kind === 'selection' ? [...cur.workspaceIds] : [];
		if (target.kind === 'group') groupIds.push(target.id);
		else workspaceIds.push(target.id);
		this.setWorkspaceSel({ kind: 'selection', groupIds, workspaceIds });
	}

	private isWorkspaceFilterPanelOpen(): boolean {
		return !!this.wsFilterPanelEl && !this.wsFilterPanelEl.hasClass('csn-dash-ws-filter-panel--hidden');
	}

	private buildWorkspaceFilterPanel(host: HTMLElement): void {
		const panel = host.createDiv({
			cls: 'csn-dash-ws-filter-panel csn-dash-ws-filter-panel--hidden',
			attr: {
				id: 'csn-dash-ws-filter-panel',
				role: 'dialog',
				'aria-label': t('DASH_WS_FILTER_PANEL_ARIA')
			}
		});
		this.wsFilterPanelEl = panel;

		const tools = panel.createDiv({ cls: 'csn-dash-filter-panel-tools' });
		const searchInner = tools.createDiv({ cls: 'csn-dash-filter-panel-search-inner' });
		const searchIcon = searchInner.createSpan({
			cls: 'csn-dash-filter-panel-search-icon',
			attr: { 'aria-hidden': 'true' }
		});
		setIcon(searchIcon, 'search');
		this.wsFilterPanelSearchInput = searchInner.createEl('input', {
			type: 'text',
			cls: 'csn-dash-filter-panel-search-input',
			attr: {
				placeholder: t('DASH_WS_FILTER_SEARCH_PLACEHOLDER'),
				spellcheck: 'false',
				autocomplete: 'off'
			}
		});
		this.registerDomEvent(this.wsFilterPanelSearchInput, 'input', () => {
			this.wsFilterPanelSearch = this.wsFilterPanelSearchInput?.value ?? '';
			this.renderWorkspaceFilterPanelList();
		});
		this.registerDomEvent(this.wsFilterPanelSearchInput, 'click', (evt: MouseEvent) => {
			evt.stopPropagation();
		});

		const logic = tools.createDiv({ cls: 'csn-dash-tag-logic' });
		logic.createSpan({ cls: 'csn-dash-tag-logic-label', text: t('DASH_TAG_LOGIC') });
		this.wsLogicOrBtn = logic.createEl('button', {
			type: 'button',
			cls: 'csn-dash-tag-logic-btn',
			text: t('DASH_TAG_LOGIC_OR'),
			attr: { 'aria-pressed': 'true' }
		});
		this.wsLogicAndBtn = logic.createEl('button', {
			type: 'button',
			cls: 'csn-dash-tag-logic-btn',
			text: t('DASH_TAG_LOGIC_AND'),
			attr: { 'aria-pressed': 'false' }
		});
		this.registerDomEvent(this.wsLogicOrBtn, 'click', () => {
			this.workspaceFilterLogic = 'or';
			this.syncWorkspaceLogicButtons();
			this.listPageIndex = 0;
			void this.renderDash();
		});
		this.registerDomEvent(this.wsLogicAndBtn, 'click', () => {
			this.workspaceFilterLogic = 'and';
			this.syncWorkspaceLogicButtons();
			this.listPageIndex = 0;
			void this.renderDash();
		});
		this.syncWorkspaceLogicButtons();

		const body = panel.createDiv({ cls: 'csn-dash-filter-panel-body' });
		this.wsFilterPanelGroupsEl = body.createDiv({ cls: 'csn-dash-filter-panel-groups' });
		const mkGroup = (id: 'selected' | 'all', labelKey: MessageKey) => {
			const btn = this.wsFilterPanelGroupsEl!.createEl('button', {
				type: 'button',
				cls: 'csn-dash-filter-panel-group-btn',
				attr: { 'data-csn-ws-group': id }
			});
			btn.createSpan({ cls: 'csn-dash-filter-panel-group-label', text: t(labelKey) });
			btn.createSpan({ cls: 'csn-dash-filter-panel-group-count', text: '0' });
			this.registerDomEvent(btn, 'click', () => {
				this.wsFilterPanelGroup = id;
				this.renderWorkspaceFilterPanelList();
			});
		};
		mkGroup('selected', 'DASH_WS_FILTER_GROUP_SELECTED');
		mkGroup('all', 'DASH_WS_FILTER_GROUP_ALL');

		this.wsFilterPanelListEl = body.createDiv({ cls: 'csn-dash-filter-panel-list' });

		const foot = panel.createDiv({ cls: 'csn-dash-filter-panel-foot' });
		foot.createSpan({ cls: 'csn-dash-filter-panel-hint', text: t('DASH_WS_FILTER_HINT_SELECT') });
		foot.createSpan({ cls: 'csn-dash-filter-panel-hint', text: t('DASH_WS_FILTER_HINT_MULTI') });
		foot.createSpan({
			cls: 'csn-dash-filter-panel-hint csn-dash-filter-panel-hint--end',
			text: t('DASH_TAG_HINT_CLOSE')
		});
	}

	private syncWorkspaceLogicButtons(): void {
		this.wsLogicOrBtn?.toggleClass('is-active', this.workspaceFilterLogic === 'or');
		this.wsLogicAndBtn?.toggleClass('is-active', this.workspaceFilterLogic === 'and');
		this.wsLogicOrBtn?.setAttr('aria-pressed', this.workspaceFilterLogic === 'or' ? 'true' : 'false');
		this.wsLogicAndBtn?.setAttr('aria-pressed', this.workspaceFilterLogic === 'and' ? 'true' : 'false');
	}

	private clearWorkspaceFilters(): void {
		if (this.workspaceSel.kind !== 'selection') return;
		this.setWorkspaceSel({ kind: 'all' });
		if (this.isWorkspaceFilterPanelOpen()) this.renderWorkspaceFilterPanelList();
	}

	private openWorkspaceFilterPanel(opts?: { group?: 'selected' | 'all' }): void {
		const panel = this.wsFilterPanelEl;
		const btn = this.wsFilterAddBtn;
		if (!panel) return;
		if (opts?.group) this.wsFilterPanelGroup = opts.group;
		this.renderWorkspaceFilterPanelList();
		panel.removeClass('csn-dash-ws-filter-panel--hidden');
		btn?.addClass('is-active');
		btn?.setAttr('aria-expanded', 'true');
		window.setTimeout(() => this.wsFilterPanelSearchInput?.focus(), 0);
	}

	private closeWorkspaceFilterPanel(): void {
		const panel = this.wsFilterPanelEl;
		const btn = this.wsFilterAddBtn;
		if (!panel || panel.hasClass('csn-dash-ws-filter-panel--hidden')) return;
		panel.addClass('csn-dash-ws-filter-panel--hidden');
		btn?.removeClass('is-active');
		btn?.setAttr('aria-expanded', 'false');
	}

	private toggleWorkspaceFilterPanel(): void {
		if (this.isWorkspaceFilterPanelOpen()) this.closeWorkspaceFilterPanel();
		else this.openWorkspaceFilterPanel({ group: 'all' });
	}

	private collectWorkspaceFilterPanelRows(): {
		kind: 'group' | 'workspace';
		id: string;
		label: string;
		indent?: boolean;
	}[] {
		const file = this.plugin.stickies.workspaces;
		const tabGroups = file.tabGroups;
		const groups =
			tabGroups.length > 0
				? tabGroups
				: [{ id: WS_TAB_GROUP_DEFAULT_ID, name: t('WS_TAB_GROUP_DEFAULT') }];
		const rows: {
			kind: 'group' | 'workspace';
			id: string;
			label: string;
			indent?: boolean;
		}[] = [];
		const ungrouped = file.workspaces.filter(ws => isWorkspaceUngrouped(ws, tabGroups));
		for (const ws of ungrouped) {
			rows.push({ kind: 'workspace', id: ws.id, label: ws.name, indent: true });
		}
		for (const g of groups) {
			rows.push({ kind: 'group', id: g.id, label: g.name });
			for (const ws of file.workspaces.filter(
				w => resolveWorkspaceTabGroupId(w, tabGroups) === g.id
			)) {
				rows.push({ kind: 'workspace', id: ws.id, label: ws.name, indent: true });
			}
		}
		return rows;
	}

	private renderWorkspaceFilterPanelList(): void {
		const groupsEl = this.wsFilterPanelGroupsEl;
		const list = this.wsFilterPanelListEl;
		if (!list) return;
		list.empty();

		const allRows = this.collectWorkspaceFilterPanelRows();
		const selectedCount = allRows.filter(r =>
			r.kind === 'group' ? this.isGroupSelActive(r.id) : this.isWorkspaceSelActive(r.id)
		).length;

		if (groupsEl) {
			for (const btn of Array.from(groupsEl.querySelectorAll('.csn-dash-filter-panel-group-btn'))) {
				if (!(btn instanceof HTMLElement)) continue;
				const id = btn.dataset.csnWsGroup;
				const countEl = btn.querySelector('.csn-dash-filter-panel-group-count');
				if (countEl) {
					countEl.setText(String(id === 'selected' ? selectedCount : allRows.length));
				}
				btn.toggleClass('is-active', this.wsFilterPanelGroup === id);
			}
		}

		const q = this.wsFilterPanelSearch.trim().toLowerCase();
		let rows = allRows;
		if (this.wsFilterPanelGroup === 'selected') {
			rows = rows.filter(r =>
				r.kind === 'group' ? this.isGroupSelActive(r.id) : this.isWorkspaceSelActive(r.id)
			);
		}
		if (q) rows = rows.filter(r => r.label.toLowerCase().includes(q));

		if (rows.length === 0) {
			list.createDiv({
				cls: 'csn-dash-filter-panel-empty',
				text: t('DASH_WS_FILTER_EMPTY')
			});
			return;
		}

		for (const row of rows) {
			const active =
				row.kind === 'group' ? this.isGroupSelActive(row.id) : this.isWorkspaceSelActive(row.id);
			const item = list.createEl('button', {
				type: 'button',
				cls: `csn-dash-filter-panel-item${row.indent ? ' is-indent' : ''}${
					active ? ' is-selected' : ''
				}`,
				attr: { 'aria-pressed': active ? 'true' : 'false' }
			});
			const check = item.createSpan({
				cls: 'csn-dash-filter-panel-item-check',
				attr: { 'aria-hidden': 'true' }
			});
			setIcon(check, active ? 'check-square' : 'square');
			const icon = item.createSpan({
				cls: 'csn-dash-filter-panel-item-icon',
				attr: { 'aria-hidden': 'true' }
			});
			setIcon(icon, row.kind === 'group' ? 'folder' : 'layers');
			item.createSpan({ cls: 'csn-dash-filter-panel-item-label', text: row.label });
			this.registerDomEvent(item, 'click', (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				/* 已选：单击取消单项；全部：单击只追加，不覆盖/切换 */
				if (this.wsFilterPanelGroup === 'selected') {
					this.removeWorkspaceFilterChip(row.kind, row.id);
				} else {
					this.appendWorkspaceFilterSel({ kind: row.kind, id: row.id });
				}
				this.renderWorkspaceFilterPanelList();
			});
		}
	}

	private syncWorkspaceFilterBar(): void {
		const chipsEl = this.wsFilterChipsEl;
		const addBtn = this.wsFilterAddBtn;
		if (!chipsEl) return;
		chipsEl.empty();
		const sel = this.workspaceSel;
		const has = sel.kind === 'selection';
		if (addBtn) {
			/* 仅面板打开时高亮；左侧树选中不应点亮 + 按钮 */
			addBtn.toggleClass('is-active', this.isWorkspaceFilterPanelOpen());
			addBtn.setAttr('aria-expanded', this.isWorkspaceFilterPanelOpen() ? 'true' : 'false');
		}
		if (!has) return;

		const count = sel.groupIds.length + sel.workspaceIds.length;
		if (count > 1) {
			this.appendFilterMoreChip(
				chipsEl,
				'csn-dash-ws-filter-chip',
				count,
				() => this.openWorkspaceFilterPanel({ group: 'selected' }),
				() => this.clearWorkspaceFilters(),
				t('DASH_WS_FILTER_CLEAR_ARIA')
			);
			return;
		}

		const file = this.plugin.stickies.workspaces;
		const groupName = (id: string) =>
			file.tabGroups.find(g => g.id === id)?.name ?? id;
		const wsName = (id: string) =>
			file.workspaces.find(w => w.id === id)?.name ??
			file.trash.find(w => w.id === id)?.name ??
			id;

		const addChip = (kind: 'group' | 'workspace', id: string, label: string) => {
			const chip = chipsEl.createEl('button', {
				type: 'button',
				cls: `csn-dash-ws-filter-chip csn-dash-ws-filter-chip--${kind}`,
				attr: {
					title: label,
					'aria-label': label
				}
			});
			const icon = chip.createSpan({
				cls: 'csn-dash-ws-filter-chip-icon',
				attr: { 'aria-hidden': 'true' }
			});
			setIcon(icon, kind === 'group' ? 'folder' : 'layers');
			chip.createSpan({ cls: 'csn-dash-ws-filter-chip-text', text: label });
			const remove = chip.createEl('span', {
				cls: 'csn-dash-ws-filter-chip-remove',
				attr: {
					role: 'button',
					tabindex: '0',
					'data-csn-ws-chip-kind': kind,
					'data-csn-ws-chip-remove': id,
					'aria-label': t('DASH_WS_FILTER_CHIP_REMOVE_ARIA', { label })
				}
			});
			setIcon(remove, 'x');
		};

		for (const id of sel.groupIds) addChip('group', id, groupName(id));
		for (const id of sel.workspaceIds) addChip('workspace', id, wsName(id));
	}

	private clearTreeDropTargets(): void {
		this.treeEl?.querySelectorAll('.csn-dash-tree-item--drop-target').forEach(el => {
			el.classList.remove('csn-dash-tree-item--drop-target');
		});
	}

	/**
	 * 分组折叠图标：直接写入 Lucide 路径，避免部分环境下 folder / folder-open 显示相同或缺失。
	 * viewBox 0 0 24 24，与 Obsidian 内置图标一致。
	 */
	private setWsGroupFoldIcon(el: HTMLElement, collapsed: boolean): void {
		el.empty();
		const svg = el.createSvg('svg', {
			attr: {
				xmlns: 'http://www.w3.org/2000/svg',
				width: '24',
				height: '24',
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				'stroke-width': '2',
				'stroke-linecap': 'round',
				'stroke-linejoin': 'round',
				class: 'svg-icon'
			}
		});
		if (collapsed) {
			/* lucide: folder-closed */
			svg.createSvg('path', {
				attr: {
					d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
				}
			});
		} else {
			/* lucide: folder-open */
			svg.createSvg('path', {
				attr: {
					d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'
				}
			});
		}
	}

	private async openNewWorkspaceModal(tabGroupId?: string): Promise<void> {
		const mgr = this.plugin.stickies;
		const autoName = t('WS_NEW_WORKSPACE_AUTO_NAME', {
			n: mgr.workspaces.workspaces.length + 1
		});
		new NewBlankWorkspaceModal(this.app, autoName, async ({ name, remark }) => {
			await mgr.createBlankWorkspace({
				name: name.trim() || undefined,
				remark,
				tabGroupId: tabGroupId ?? WS_TAB_GROUP_UNGROUPED_ID
			});
			this.renderWorkspaceTree();
			void this.renderDash();
		}).open();
	}

	/** 工作区列表「+」：新建顶部分组（非工作区）。 */
	private async openNewGroupModal(): Promise<void> {
		const mgr = this.plugin.stickies;
		const nextN = mgr.workspaces.tabGroups.length + 1;
		const autoPreview = t('WS_TAB_GROUP_AUTO_NAME', { n: nextN });
		new NewWorkspaceTabGroupModal(this.app, autoPreview, async name => {
			await mgr.createWorkspaceTabGroup(name.trim() ? name : undefined);
			this.renderWorkspaceTree();
			this.syncWorkspaceFilterBar();
		}).open();
	}

	private async openNewArchivedGroupModal(): Promise<void> {
		const mgr = this.plugin.stickies;
		const nextN =
			(mgr.workspaces.trashTabGroups?.length ?? 0) + mgr.workspaces.tabGroups.length + 1;
		const autoPreview = t('WS_TAB_GROUP_AUTO_NAME', { n: nextN });
		new NewWorkspaceTabGroupModal(this.app, autoPreview, async name => {
			await mgr.createTrashTabGroup(name.trim() ? name : undefined);
			this.renderWorkspaceTree();
		}).open();
	}

	private renameWorkspace(ws: StickyWorkspace): void {
		const row = this.treeEl?.querySelector(
			`.csn-dash-tree-ws[data-csn-ws-id="${CSS.escape(ws.id)}"]`
		);
		if (!(row instanceof HTMLElement)) return;
		this.beginInlineTreeRename(row, ws.name, async name => {
			await this.plugin.stickies.updateWorkspace(ws.id, name, ws.remark ?? '');
			this.renderWorkspaceTree();
			this.syncWorkspaceFilterBar();
		});
	}

	private renameWorkspaceGroup(group: StickyWorkspaceTabGroup): void {
		const row = this.treeEl?.querySelector(
			`.csn-dash-tree-group-btn[data-csn-ws-group="${CSS.escape(group.id)}"], .csn-dash-tree-group-btn[data-csn-ws-group-archived="${CSS.escape(group.id)}"]`
		);
		if (!(row instanceof HTMLElement)) return;
		this.beginInlineTreeRename(row, group.name, async name => {
			await this.plugin.stickies.renameWorkspaceTabGroup(group.id, name);
			this.renderWorkspaceTree();
			this.syncWorkspaceFilterBar();
		});
	}

	/** 工作区树内联重命名：双击后在行内输入，Enter/失焦提交，Esc 取消。 */
	private beginInlineTreeRename(
		rowEl: HTMLElement,
		initialName: string,
		onCommit: (name: string) => void | Promise<void>
	): void {
		if (rowEl.querySelector('.csn-dash-tree-rename-input')) return;
		const label = rowEl.querySelector('.csn-dash-tree-label');
		if (!(label instanceof HTMLElement)) return;

		const wasDraggable = rowEl.getAttr('draggable');
		rowEl.removeAttribute('draggable');
		rowEl.addClass('is-renaming');
		label.addClass('csn-dash-tree-label--hidden');

		const input = rowEl.createEl('input', {
			type: 'text',
			cls: 'csn-dash-tree-rename-input',
			attr: {
				value: initialName,
				spellcheck: 'false',
				autocomplete: 'off',
				'aria-label': t('DASH_WS_MENU_RENAME')
			}
		});
		const count = rowEl.querySelector('.csn-dash-tree-count');
		if (count) count.before(input);
		else label.after(input);
		input.value = initialName;
		input.focus();
		input.select();

		let finished = false;
		const restoreChrome = (): void => {
			input.remove();
			label.removeClass('csn-dash-tree-label--hidden');
			rowEl.removeClass('is-renaming');
			if (wasDraggable != null) rowEl.setAttr('draggable', wasDraggable);
		};
		const finish = (save: boolean): void => {
			if (finished) return;
			finished = true;
			const next = input.value.trim();
			restoreChrome();
			if (!save) return;
			if (!next) {
				new Notice(t('NOTICE_NAME_EMPTY'));
				return;
			}
			if (next === initialName) return;
			void onCommit(next);
		};

		this.registerDomEvent(input, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				evt.stopPropagation();
				finish(true);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				evt.stopPropagation();
				finish(false);
			}
		});
		this.registerDomEvent(input, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		this.registerDomEvent(input, 'mousedown', (evt: MouseEvent) => {
			evt.stopPropagation();
		});
		this.registerDomEvent(input, 'dblclick', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		this.registerDomEvent(input, 'blur', () => {
			finish(true);
		});
	}

	private openWorkspaceContextMenu(evt: MouseEvent, ws: StickyWorkspace): void {
		evt.preventDefault();
		const menu = new Menu();
		const mgr = this.plugin.stickies;
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_RENAME')).setIcon('pencil').onClick(() => {
				this.renameWorkspace(ws);
			});
		});
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_DELETE')).setIcon('trash').onClick(() => {
				new DeleteStickyWorkspaceConfirmModal(this.app, ws.name, async () => {
					await mgr.deleteStickyWorkspace(ws.id);
					if (this.workspaceSel.kind === 'selection') {
						const workspaceIds = this.workspaceSel.workspaceIds.filter(id => id !== ws.id);
						this.workspaceSel =
							workspaceIds.length === 0 && this.workspaceSel.groupIds.length === 0
								? { kind: 'all' }
								: { kind: 'selection', groupIds: [...this.workspaceSel.groupIds], workspaceIds };
					}
					this.syncWorkspaceFilterBar();
					this.renderWorkspaceTree();
					void this.renderDash();
				}).open();
			});
		});
		menu.showAtMouseEvent(evt);
	}

	private openGroupContextMenu(evt: MouseEvent, group: StickyWorkspaceTabGroup): void {
		evt.preventDefault();
		const menu = new Menu();
		const mgr = this.plugin.stickies;
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_NEW')).setIcon('plus').onClick(() => {
				void this.openNewWorkspaceModal(group.id);
			});
		});
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_RENAME')).setIcon('pencil').onClick(() => {
				this.renameWorkspaceGroup(group);
			});
		});
		if (group.id !== WS_TAB_GROUP_DEFAULT_ID) {
			menu.addItem(item => {
				item.setTitle(t('DASH_WS_MENU_DELETE')).setIcon('trash').onClick(() => {
					const runDelete = async (): Promise<void> => {
						const result = await mgr.deleteWorkspaceTabGroup(group.id);
						if (this.workspaceSel.kind === 'selection') {
							const groupIds = this.workspaceSel.groupIds.filter(id => id !== group.id);
							this.workspaceSel =
								groupIds.length === 0 && this.workspaceSel.workspaceIds.length === 0
									? { kind: 'all' }
									: {
											kind: 'selection',
											groupIds,
											workspaceIds: [...this.workspaceSel.workspaceIds]
										};
						}
						this.syncWorkspaceFilterBar();
						this.renderWorkspaceTree();
						void this.renderDash();
						if (result === 'archived') new Notice(t('NOTICE_TAB_GROUP_ARCHIVED'));
						else if (result === 'deleted') new Notice(t('NOTICE_TAB_GROUP_DELETED'));
					};
					if (mgr.countWorkspacesInTabGroup(group.id) === 0) {
						void runDelete();
						return;
					}
					new DeleteWorkspaceTabGroupConfirmModal(this.app, group.name, () => runDelete()).open();
				});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private ensureManualWsTreeSort(): void {
		if (this.wsTreeSortMode === 'manual') return;
		this.wsTreeSortMode = 'manual';
		this.syncWsTreeSortBtn();
	}

	private bindWorkspaceTreeDrop(
		el: HTMLElement,
		opts: {
			acceptSticky?: boolean;
			onStickyDrop?: (paths: string[], evt: DragEvent) => void | Promise<void>;
			acceptWorkspace?: boolean;
			onWorkspaceDrop?: (workspaceId: string) => void | Promise<void>;
			acceptGroup?: boolean;
			onGroupDrop?: (groupId: string) => void | Promise<void>;
		}
	): void {
		this.registerDomEvent(el, 'dragover', (e: DragEvent) => {
			const sticky =
				opts.acceptSticky &&
				(this.wsTreeDragKind === 'sticky' || dragEventHasMime(e, STICKY_PATHS_DND_MIME));
			const group =
				opts.acceptGroup &&
				(this.wsTreeDragKind === 'group' || dragEventHasMime(e, WORKSPACE_GROUP_DND_MIME));
			const ws =
				opts.acceptWorkspace &&
				(this.wsTreeDragKind === 'workspace' || dragEventHasMime(e, WORKSPACE_DND_MIME));
			if (!sticky && !ws && !group) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = sticky
					? e.ctrlKey || e.metaKey
						? 'copy'
						: 'move'
					: 'move';
			}
			el.addClass('csn-dash-tree-item--drop-target');
		});
		this.registerDomEvent(el, 'dragleave', (e: DragEvent) => {
			const related = e.relatedTarget;
			if (related instanceof Node && el.contains(related)) return;
			el.removeClass('csn-dash-tree-item--drop-target');
		});
		this.registerDomEvent(el, 'drop', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			el.removeClass('csn-dash-tree-item--drop-target');
			this.clearTreeDropTargets();
			const paths = readStickyPathsDragData(e.dataTransfer);
			if (opts.acceptSticky && paths.length > 0 && opts.onStickyDrop) {
				void opts.onStickyDrop(paths, e);
				return;
			}
			/* 分组优先于工作区：展开分组时拖到子项也应重排分组，不能被工作区处理器吞掉 */
			let groupId = e.dataTransfer?.getData(WORKSPACE_GROUP_DND_MIME)?.trim() ?? '';
			if (!groupId) {
				const plain = e.dataTransfer?.getData('text/plain')?.trim() ?? '';
				if (plain.startsWith('csn-wsg:')) groupId = plain.slice('csn-wsg:'.length);
			}
			if (opts.acceptGroup && groupId && opts.onGroupDrop) {
				void opts.onGroupDrop(groupId);
				return;
			}
			const wsId = e.dataTransfer?.getData(WORKSPACE_DND_MIME)?.trim();
			if (opts.acceptWorkspace && wsId && opts.onWorkspaceDrop) {
				void opts.onWorkspaceDrop(wsId);
			}
		});
	}

	private async addStickyPathsToWorkspace(wsId: string, paths: string[]): Promise<void> {
		await this.dropStickyPathsOnWorkspace(wsId, paths, true);
	}

	private async dropStickyPathsOnWorkspace(
		wsId: string,
		paths: string[],
		copy: boolean
	): Promise<void> {
		const files: TFile[] = [];
		for (const p of paths) {
			const abs = this.app.vault.getAbstractFileByPath(normalizePath(p));
			if (abs instanceof TFile) files.push(abs);
		}
		if (files.length === 0) return;
		if (copy) await this.plugin.stickies.addFilesToWorkspace(wsId, files);
		else await this.plugin.stickies.moveFilesToWorkspace(wsId, files);
		this.renderWorkspaceTree();
		void this.renderDash();
	}

	private renderWorkspaceTree(): void {
		const host = this.treeEl;
		if (!host) return;
		host.empty();
		const mgr = this.plugin.stickies;
		const file = mgr.workspaces;
		const q = this.wsTreeFilterQuery.trim().toLowerCase();
		const matchText = (s: string) => !q || s.toLowerCase().includes(q);

		this.syncWsTreeShowArchivedBtn();
		if (this.wsTreeShowArchived) {
			this.renderArchivedWorkspaceTree(host, q, matchText);
			this.syncWsTreeSortBtn();
			this.syncWsTreeCollapseBtn([]);
			this.syncWorkspaceFilterBar();
			this.applyCardFocusWorkspaceChrome(false);
			return;
		}

		const tabGroups = file.tabGroups;
		const rawGroups: StickyWorkspaceTabGroup[] =
			tabGroups.length > 0
				? tabGroups
				: [{ id: WS_TAB_GROUP_DEFAULT_ID, name: t('WS_TAB_GROUP_DEFAULT') }];
		const groups = this.sortGroupsForTree(rawGroups, file.workspaces);

		/* 拖到树空白处 → 移入根目录（未分组） */
		this.bindWorkspaceTreeDrop(host, {
			acceptWorkspace: true,
			onWorkspaceDrop: async workspaceId => {
				this.ensureManualWsTreeSort();
				await mgr.moveWorkspaceToTabGroup(workspaceId, WS_TAB_GROUP_UNGROUPED_ID);
				this.renderWorkspaceTree();
			}
		});

		/* 根目录未分组工作区 */
		let ungroupedWorkspaces = file.workspaces.filter(
			ws => resolveWorkspaceTabGroupId(ws, tabGroups) === WS_TAB_GROUP_UNGROUPED_ID
		);
		if (q) {
			ungroupedWorkspaces = ungroupedWorkspaces.filter(
				ws => matchText(ws.name) || matchText(ws.remark ?? '')
			);
		}
		ungroupedWorkspaces = this.sortWorkspacesForTree(ungroupedWorkspaces);
		for (const ws of ungroupedWorkspaces) {
			this.appendWorkspaceTreeItem(host, ws, {
				tabGroups,
				rootLevel: true,
				acceptGroupDrop: false
			});
		}

		for (const g of groups) {
			let groupWorkspaces = file.workspaces.filter(
				ws => resolveWorkspaceTabGroupId(ws, tabGroups) === g.id
			);
			if (q) {
				const groupMatch = matchText(g.name);
				groupWorkspaces = groupWorkspaces.filter(
					ws => groupMatch || matchText(ws.name) || matchText(ws.remark ?? '')
				);
				if (!groupMatch && groupWorkspaces.length === 0) continue;
			}
			groupWorkspaces = this.sortWorkspacesForTree(groupWorkspaces);

			/* 筛选时临时展开匹配分组，不改动已记住的折叠状态 */
			const collapsed = !q && this.collapsedGroupIds.has(g.id);
			const groupCount = groupWorkspaces.length;
			const groupRow = host.createDiv({ cls: 'csn-dash-tree-group' });
			const groupDraggable = tabGroups.some(tg => tg.id === g.id);
			const groupBtn = groupRow.createEl('button', {
				type: 'button',
				cls: `csn-dash-tree-item csn-dash-tree-group-btn${
					this.isGroupSelActive(g.id) ? ' is-active' : ''
				}`,
				attr: { 'data-csn-ws-group': g.id }
			});
			if (groupDraggable) groupBtn.setAttr('draggable', 'true');
			const folderIcon = groupBtn.createSpan({
				cls: `csn-dash-tree-icon csn-dash-tree-folder-toggle${collapsed ? ' is-collapsed' : ''}`,
				attr: {
					'aria-label': collapsed ? t('DASH_WS_EXPAND_GROUP_ARIA') : t('DASH_WS_COLLAPSE_GROUP_ARIA'),
					role: 'button'
				}
			});
			this.setWsGroupFoldIcon(folderIcon, collapsed);
			groupBtn.createSpan({ cls: 'csn-dash-tree-label', text: g.name });
			groupBtn.createSpan({
				cls: 'csn-dash-tree-count csn-dash-tree-count--toggle',
				text: String(groupCount),
				attr: {
					'aria-label': collapsed ? t('DASH_WS_EXPAND_GROUP_ARIA') : t('DASH_WS_COLLAPSE_GROUP_ARIA'),
					role: 'button'
				}
			});
			const toggleGroupCollapsed = (): void => {
				if (this.collapsedGroupIds.has(g.id)) this.collapsedGroupIds.delete(g.id);
				else this.collapsedGroupIds.add(g.id);
				this.persistCollapsedGroups();
				this.renderWorkspaceTree();
			};
			const isGroupToggleHit = (hit: EventTarget | null): boolean =>
				hit instanceof Element &&
				!!(
					hit.closest('.csn-dash-tree-folder-toggle') ||
					hit.closest('.csn-dash-tree-count--toggle')
				);
			this.registerDomEvent(groupBtn, 'click', (evt: MouseEvent) => {
				if (isGroupToggleHit(evt.target)) {
					toggleGroupCollapsed();
					return;
				}
				this.clickWorkspaceTreeSel(
					{ kind: 'group', id: g.id },
					evt.ctrlKey || evt.metaKey
				);
			});
			this.registerDomEvent(groupBtn, 'dblclick', (evt: MouseEvent) => {
				if (isGroupToggleHit(evt.target)) return;
				evt.preventDefault();
				evt.stopPropagation();
				this.renameWorkspaceGroup(g);
			});
			this.registerDomEvent(groupBtn, 'contextmenu', (evt: MouseEvent) => {
				this.openGroupContextMenu(evt, g);
			});
			const onGroupReorderDrop = async (draggedGroupId: string): Promise<void> => {
				if (draggedGroupId === g.id) return;
				this.ensureManualWsTreeSort();
				await mgr.reorderWorkspaceTabGroupBefore(draggedGroupId, g.id);
				this.renderWorkspaceTree();
			};
			if (groupDraggable) {
				this.registerDomEvent(groupBtn, 'dragstart', (e: DragEvent) => {
					if (isGroupToggleHit(e.target)) {
						e.preventDefault();
						return;
					}
					this.wsTreeDragKind = 'group';
					e.dataTransfer?.setData(WORKSPACE_GROUP_DND_MIME, g.id);
					/* 部分环境仅认可 text/plain，前缀避免与便签路径拖拽混淆 */
					e.dataTransfer?.setData('text/plain', `csn-wsg:${g.id}`);
					if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
					groupBtn.addClass('csn-dash-tree-item--dragging');
				});
				this.registerDomEvent(groupBtn, 'dragend', () => {
					this.wsTreeDragKind = 'none';
					groupBtn.removeClass('csn-dash-tree-item--dragging');
					this.clearTreeDropTargets();
				});
			}
			this.bindWorkspaceTreeDrop(groupBtn, {
				acceptWorkspace: true,
				onWorkspaceDrop: async workspaceId => {
					this.ensureManualWsTreeSort();
					await mgr.moveWorkspaceToTabGroup(workspaceId, g.id);
					this.renderWorkspaceTree();
				},
				acceptGroup: groupDraggable,
				onGroupDrop: onGroupReorderDrop
			});

			if (collapsed) continue;
			for (const ws of groupWorkspaces) {
				this.appendWorkspaceTreeItem(groupRow, ws, {
					tabGroups,
					rootLevel: false,
					acceptGroupDrop: groupDraggable,
					onGroupDrop: onGroupReorderDrop
				});
			}
		}
		this.syncWsTreeSortBtn();
		this.syncWsTreeCollapseBtn(groups.map(g => g.id));
		this.syncWsTreeShowArchivedBtn();
		this.syncWorkspaceFilterBar();
		this.applyCardFocusWorkspaceChrome(false);
	}

	/** 仅显示已归档（trash）工作区，按归档时分组展示。 */
	private renderArchivedWorkspaceTree(
		host: HTMLElement,
		q: string,
		matchText: (s: string) => boolean
	): void {
		const file = this.plugin.stickies.workspaces;
		let list = [...file.trash];
		if (q) {
			list = list.filter(ws => matchText(ws.name) || matchText(ws.remark ?? ''));
		}
		list = this.sortWorkspacesForTree(list);

		type Bucket = { key: string; label: string; items: StickyWorkspace[]; editable: boolean };
		const tabGroups = file.tabGroups;
		const trashTabGroups = file.trashTabGroups ?? [];
		const bucketMap = new Map<string, Bucket>();
		const ensure = (key: string, label: string, editable: boolean): Bucket => {
			let b = bucketMap.get(key);
			if (!b) {
				b = { key, label, items: [], editable };
				bucketMap.set(key, b);
			}
			return b;
		};

		/* 已归档分组即使暂无工作区也展示，便于新建后编辑/迁入 */
		for (const g of trashTabGroups) {
			if (q && !matchText(g.name)) continue;
			ensure(g.id, g.name, true);
		}

		for (const ws of list) {
			const { key, label } = resolveTrashWorkspaceGroupLabel(ws, tabGroups, trashTabGroups);
			const editable =
				key !== WS_TAB_GROUP_UNGROUPED_ID &&
				!key.startsWith('missing:') &&
				(tabGroups.some(g => g.id === key) || trashTabGroups.some(g => g.id === key));
			ensure(key, label, editable).items.push(ws);
		}

		if (bucketMap.size === 0) {
			host.createDiv({
				cls: 'csn-dash-ws-tree-empty',
				text: t('DASH_WS_ARCHIVED_EMPTY')
			});
			return;
		}

		const ordered: Bucket[] = [];
		const knownOrder = [...tabGroups, ...trashTabGroups];
		for (const g of knownOrder) {
			const b = bucketMap.get(g.id);
			if (b && !ordered.includes(b)) ordered.push(b);
		}
		const ungrouped = bucketMap.get(WS_TAB_GROUP_UNGROUPED_ID);
		if (ungrouped && !ordered.includes(ungrouped)) ordered.push(ungrouped);
		for (const [, b] of bucketMap) {
			if (!ordered.includes(b)) ordered.push(b);
		}

		for (const bucket of ordered) {
			if (q && bucket.items.length === 0 && !matchText(bucket.label)) continue;
			const groupRow = host.createDiv({ cls: 'csn-dash-tree-group' });
			const groupBtn = groupRow.createEl('button', {
				type: 'button',
				cls: 'csn-dash-tree-item csn-dash-tree-group-btn',
				attr: { 'data-csn-ws-group-archived': bucket.key }
			});
			setIcon(
				groupBtn.createSpan({ cls: 'csn-dash-tree-icon csn-dash-tree-folder-toggle' }),
				'folder'
			);
			groupBtn.createSpan({ cls: 'csn-dash-tree-label', text: bucket.label });
			groupBtn.createSpan({
				cls: 'csn-dash-tree-count',
				text: String(bucket.items.length)
			});

			if (bucket.editable) {
				const group: StickyWorkspaceTabGroup = { id: bucket.key, name: bucket.label };
				this.registerDomEvent(groupBtn, 'dblclick', (evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.renameWorkspaceGroup(group);
				});
				this.registerDomEvent(groupBtn, 'contextmenu', (evt: MouseEvent) => {
					this.openArchivedGroupContextMenu(evt, group);
				});
			}

			for (const ws of bucket.items) {
				this.appendArchivedWorkspaceTreeItem(groupRow, ws);
			}
		}
	}

	private appendArchivedWorkspaceTreeItem(host: HTMLElement, ws: StickyWorkspace): void {
		const mgr = this.plugin.stickies;
		const memberCount = mgr.getWorkspaceMemberPathSet(ws).size;
		const wsBtn = host.createEl('button', {
			type: 'button',
			cls: `csn-dash-tree-item csn-dash-tree-ws csn-dash-tree-ws--archived${
				this.isWorkspaceSelActive(ws.id) ? ' is-active' : ''
			}`,
			attr: { 'data-csn-ws-id': ws.id, 'data-csn-ws-archived': 'true' }
		});
		setIcon(wsBtn.createSpan({ cls: 'csn-dash-tree-icon' }), 'archive');
		wsBtn.createSpan({ cls: 'csn-dash-tree-label', text: ws.name });
		wsBtn.createSpan({ cls: 'csn-dash-tree-count', text: String(memberCount) });
		this.registerDomEvent(wsBtn, 'click', (evt: MouseEvent) => {
			this.clickWorkspaceTreeSel(
				{ kind: 'workspace', id: ws.id },
				evt.ctrlKey || evt.metaKey
			);
		});
		this.registerDomEvent(wsBtn, 'dblclick', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.renameWorkspace(ws);
		});
		this.registerDomEvent(wsBtn, 'contextmenu', (evt: MouseEvent) => {
			this.openArchivedWorkspaceContextMenu(evt, ws);
		});
	}

	private openArchivedGroupContextMenu(evt: MouseEvent, group: StickyWorkspaceTabGroup): void {
		evt.preventDefault();
		const menu = new Menu();
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_RENAME')).setIcon('pencil').onClick(() => {
				this.renameWorkspaceGroup(group);
			});
		});
		menu.showAtMouseEvent(evt);
	}

	private openArchivedWorkspaceContextMenu(evt: MouseEvent, ws: StickyWorkspace): void {
		evt.preventDefault();
		const menu = new Menu();
		const mgr = this.plugin.stickies;
		const file = mgr.workspaces;
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_RENAME')).setIcon('pencil').onClick(() => {
				this.renameWorkspace(ws);
			});
		});

		const moveTargets: StickyWorkspaceTabGroup[] = [];
		const seen = new Set<string>();
		for (const g of [...file.tabGroups, ...(file.trashTabGroups ?? [])]) {
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			moveTargets.push(g);
		}
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_MOVE_TO')).setIcon('folder-input');
			const sub = item.setSubmenu();
			sub.addItem(subItem => {
				subItem.setTitle(t('DASH_AREA_UNGROUPED')).onClick(() => {
					void mgr.moveTrashWorkspaceToTabGroup(ws.id, WS_TAB_GROUP_UNGROUPED_ID).then(() => {
						this.renderWorkspaceTree();
					});
				});
			});
			for (const g of moveTargets) {
				sub.addItem(subItem => {
					subItem.setTitle(g.name).onClick(() => {
						void mgr.moveTrashWorkspaceToTabGroup(ws.id, g.id).then(() => {
							this.renderWorkspaceTree();
						});
					});
				});
			}
		});

		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_RESTORE')).setIcon('rotate-ccw').onClick(() => {
				void (async () => {
					await mgr.restoreStickyWorkspaceFromTrash(ws.id);
					if (this.workspaceSel.kind === 'selection') {
						const workspaceIds = this.workspaceSel.workspaceIds.filter(id => id !== ws.id);
						this.workspaceSel =
							workspaceIds.length === 0 && this.workspaceSel.groupIds.length === 0
								? { kind: 'all' }
								: {
										kind: 'selection',
										groupIds: [...this.workspaceSel.groupIds],
										workspaceIds
									};
					}
					this.syncWorkspaceFilterBar();
					this.renderWorkspaceTree();
					void this.renderDash();
				})();
			});
		});
		menu.addItem(item => {
			item.setTitle(t('DASH_WS_MENU_PERMANENT_DELETE')).setIcon('trash').onClick(() => {
				new PermanentlyDeleteStickyWorkspaceConfirmModal(this.app, ws.name, async () => {
					await mgr.permanentlyDeleteStickyWorkspaceFromTrash(ws.id);
					if (this.workspaceSel.kind === 'selection') {
						const workspaceIds = this.workspaceSel.workspaceIds.filter(id => id !== ws.id);
						this.workspaceSel =
							workspaceIds.length === 0 && this.workspaceSel.groupIds.length === 0
								? { kind: 'all' }
								: {
										kind: 'selection',
										groupIds: [...this.workspaceSel.groupIds],
										workspaceIds
									};
					}
					this.syncWorkspaceFilterBar();
					this.renderWorkspaceTree();
					void this.renderDash();
				}).open();
			});
		});
		menu.showAtMouseEvent(evt);
	}

	private appendWorkspaceTreeItem(
		host: HTMLElement,
		ws: StickyWorkspace,
		opts: {
			tabGroups: readonly StickyWorkspaceTabGroup[];
			rootLevel: boolean;
			acceptGroupDrop: boolean;
			onGroupDrop?: (groupId: string) => void | Promise<void>;
		}
	): void {
		const mgr = this.plugin.stickies;
		const memberCount = mgr.getWorkspaceMemberPathSet(ws).size;
		const wsBtn = host.createEl('button', {
			type: 'button',
			cls: `csn-dash-tree-item csn-dash-tree-ws${opts.rootLevel ? ' csn-dash-tree-ws--root' : ''}${
				this.isWorkspaceSelActive(ws.id) ? ' is-active' : ''
			}`,
			attr: { 'data-csn-ws-id': ws.id, draggable: 'true' }
		});
		setIcon(wsBtn.createSpan({ cls: 'csn-dash-tree-icon' }), 'layers');
		wsBtn.createSpan({ cls: 'csn-dash-tree-label', text: ws.name });
		wsBtn.createSpan({ cls: 'csn-dash-tree-count', text: String(memberCount) });
		this.registerDomEvent(wsBtn, 'click', (evt: MouseEvent) => {
			this.clickWorkspaceTreeSel(
				{ kind: 'workspace', id: ws.id },
				evt.ctrlKey || evt.metaKey
			);
		});
		this.registerDomEvent(wsBtn, 'dblclick', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.renameWorkspace(ws);
		});
		this.registerDomEvent(wsBtn, 'contextmenu', (evt: MouseEvent) => {
			this.openWorkspaceContextMenu(evt, ws);
		});
		this.registerDomEvent(wsBtn, 'dragstart', (e: DragEvent) => {
			this.wsTreeDragKind = 'workspace';
			e.dataTransfer?.setData(WORKSPACE_DND_MIME, ws.id);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
			wsBtn.addClass('csn-dash-tree-item--dragging');
		});
		this.registerDomEvent(wsBtn, 'dragend', () => {
			this.wsTreeDragKind = 'none';
			wsBtn.removeClass('csn-dash-tree-item--dragging');
			this.clearTreeDropTargets();
		});
		this.bindWorkspaceTreeDrop(wsBtn, {
			acceptSticky: true,
			onStickyDrop: (paths, e) =>
				this.dropStickyPathsOnWorkspace(ws.id, paths, e.ctrlKey || e.metaKey),
			acceptWorkspace: true,
			onWorkspaceDrop: async draggedId => {
				if (draggedId === ws.id) return;
				this.ensureManualWsTreeSort();
				await mgr.reorderWorkspaceBefore(draggedId, ws.id);
				const targetGroup = resolveWorkspaceTabGroupId(ws, opts.tabGroups);
				await mgr.moveWorkspaceToTabGroup(draggedId, targetGroup);
				this.renderWorkspaceTree();
			},
			acceptGroup: opts.acceptGroupDrop,
			onGroupDrop: opts.onGroupDrop
		});
	}

	private resolveWorkspacePathFilter(): Set<string> | null {
		const file = this.plugin.stickies.workspaces;
		const sel = this.workspaceSel;
		if (sel.kind === 'all') return null;
		const groups = file.tabGroups;
		const criteria: Set<string>[] = [];
		const mgr = this.plugin.stickies;

		for (const wsId of sel.workspaceIds) {
			const ws =
				file.workspaces.find(w => w.id === wsId) ?? file.trash.find(w => w.id === wsId);
			if (!ws) continue;
			criteria.push(new Set(mgr.getWorkspaceMemberPathSet(ws)));
		}
		for (const groupId of sel.groupIds) {
			const groupPaths = new Set<string>();
			for (const ws of file.workspaces) {
				if (resolveWorkspaceTabGroupId(ws, groups) !== groupId) continue;
				for (const p of mgr.getWorkspaceMemberPathSet(ws)) groupPaths.add(p);
			}
			criteria.push(groupPaths);
		}
		if (criteria.length === 0) return new Set();

		if (this.workspaceFilterLogic !== 'and') {
			const union = new Set<string>();
			for (const set of criteria) {
				for (const p of set) union.add(p);
			}
			return union;
		}

		let inter = new Set(criteria[0]!);
		for (let i = 1; i < criteria.length; i++) {
			const next = criteria[i]!;
			const kept = new Set<string>();
			for (const p of inter) {
				if (next.has(p)) kept.add(p);
			}
			inter = kept;
		}
		return inter;
	}

	private selectedCreateColor(): StickyColorId {
		return this.composerCreateColor;
	}

	private syncComposerColorBtn(): void {
		const btn = this.composerColorBtn;
		if (!btn) return;
		btn.setAttr('data-csn-color', this.composerCreateColor);
		const label =
			SHEET_COLOR_ORDER.find(c => c.id === this.composerCreateColor)?.labelKey ??
			'COLOR_DEFAULT';
		btn.setAttr('aria-label', `${t('DASH_COMPOSER_COLOR_ARIA')}：${t(label)}`);
		btn.title = t(label);
		for (const [id, sw] of this.composerColorSwatchBtns) {
			sw.toggleClass('is-active', id === this.composerCreateColor);
			sw.setAttr('aria-pressed', id === this.composerCreateColor ? 'true' : 'false');
		}
	}

	private openComposerColorPalette(): void {
		if (!this.composerColorWrapEl || !this.composerColorBtn) return;
		this.composerColorWrapEl.addClass('is-expanded');
		this.composerColorBtn.setAttr('aria-expanded', 'true');
	}

	private closeComposerColorPalette(): void {
		this.composerColorWrapEl?.removeClass('is-expanded');
		this.composerColorBtn?.setAttr('aria-expanded', 'false');
	}

	/** 挂载 Obsidian 原生 Markdown 编辑器；失败时回退到 textarea。 */
	private mountComposerEditor(): void {
		const host = this.composerHostEl;
		if (!host) return;
		this.composerEditor?.destroy();
		this.composerEditor = null;
		this.composerFallbackEl = null;
		host.empty();

		const draft = this.plugin.settings.dashboardComposerDraft ?? '';
		const Ctor = this.plugin.markdownEditorClass;
		if (Ctor) {
			try {
				this.composerEditor = new EmbeddedMarkdownEditorHost({
					plugin: this.plugin,
					app: this.app,
					hostEl: host,
					MarkdownEditor: Ctor,
					/* 切勿绑定 workspace 当前文件，否则 Enter/内部同步会覆盖或清空输入 */
					getFile: () => null,
					placeholder: t('DASH_COMPOSER_PLACEHOLDER'),
					initialValue: draft,
					onSubmit: () => {
						void this.commitComposer();
					},
					onChange: md => {
						this.schedulePersistComposerDraft(md);
					}
				});
				this.composerEditor.mount();
				this.applyComposerContentZoom();
				return;
			} catch (e) {
				console.error('[colorful-sticky-notes] mount composer markdown editor failed', e);
				this.composerEditor?.destroy();
				this.composerEditor = null;
				host.empty();
			}
		}

		this.composerFallbackEl = host.createEl('textarea', {
			cls: 'csn-dash-composer-input',
			attr: {
				placeholder: t('DASH_COMPOSER_PLACEHOLDER'),
				spellcheck: 'false',
				rows: '5',
				'aria-label': t('DASH_COMPOSER_PLACEHOLDER')
			}
		});
		this.composerFallbackEl.value = draft;
		this.applyComposerContentZoom();
		this.registerDomEvent(this.composerFallbackEl, 'input', () => {
			this.schedulePersistComposerDraft(this.composerFallbackEl?.value ?? '');
		});
		this.registerDomEvent(this.composerFallbackEl, 'keydown', (evt: KeyboardEvent) => {
			if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
				evt.preventDefault();
				void this.commitComposer();
			}
		});
	}

	/** 插件稍后解析到内部 MarkdownEditor 类时，从 textarea 升级为 CM 编辑区。 */
	remountComposerEditor(): void {
		if (!this.composerHostEl) return;
		/* 已有可用 CM 时勿重挂，避免清空正在输入的内容 */
		if (this.composerEditor) return;
		this.flushComposerDraftToSettings();
		this.mountComposerEditor();
	}

	private getComposerMarkdownRaw(): string {
		if (this.composerEditor) return this.composerEditor.getValue();
		return this.composerFallbackEl?.value ?? '';
	}

	private getComposerMarkdown(): string {
		return this.getComposerMarkdownRaw().trimEnd();
	}

	private ensureComposerDraftDebouncer(): Debouncer<[string], void> {
		if (!this.debouncedPersistComposerDraft) {
			this.debouncedPersistComposerDraft = debounce((text: string) => {
				this.persistComposerDraft(text);
			}, 400);
		}
		return this.debouncedPersistComposerDraft;
	}

	private schedulePersistComposerDraft(text: string): void {
		this.ensureComposerDraftDebouncer()(text);
	}

	private persistComposerDraft(text?: string): void {
		const next = text ?? this.getComposerMarkdownRaw();
		if (this.plugin.settings.dashboardComposerDraft === next) return;
		this.plugin.settings.dashboardComposerDraft = next;
		void this.plugin.saveSettings();
	}

	private flushComposerDraftToSettings(): void {
		this.debouncedPersistComposerDraft?.cancel();
		this.persistComposerDraft();
	}

	private clearComposer(): void {
		if (this.composerEditor) {
			this.composerEditor.setValue('');
		} else if (this.composerFallbackEl) {
			this.composerFallbackEl.value = '';
		}
		this.debouncedPersistComposerDraft?.cancel();
		this.persistComposerDraft('');
	}

	/**
	 * 仪表盘新建归属：按当前工作区筛选加入；「全部」或无选中工作区时保持未分类。
	 * 选中分组时加入该分组下全部工作区。
	 */
	private resolveCreateTargetWorkspaceIds(): string[] {
		if (this.areaMode === 'uncategorized') return [];
		const sel = this.workspaceSel;
		if (sel.kind !== 'selection') return [];
		const file = this.plugin.stickies.workspaces;
		const ids = new Set<string>();
		for (const wsId of sel.workspaceIds) {
			if (file.workspaces.some(w => w.id === wsId)) ids.add(wsId);
		}
		for (const gId of sel.groupIds) {
			for (const ws of file.workspaces) {
				if (resolveWorkspaceTabGroupId(ws, file.tabGroups) === gId) ids.add(ws.id);
			}
		}
		return [...ids];
	}

	private async assignCreatedStickyToFilterWorkspaces(file: TFile): Promise<void> {
		const wsIds = this.resolveCreateTargetWorkspaceIds();
		for (const wsId of wsIds) {
			await this.plugin.stickies.addFilesToWorkspace(wsId, [file], { skipListRefresh: true });
		}
	}

	private async createStickyFromToolbar(): Promise<void> {
		const created = await this.plugin.stickies.addStickyWindow(
			{ color: this.selectedCreateColor() },
			undefined,
			{ deferListRefresh: true, skipActiveWorkspace: true }
		);
		if (!created) return;
		try {
			await this.assignCreatedStickyToFilterWorkspaces(created);
			this.listPageIndex = 0;
			this.plugin.refreshStickyListIfOpen({ tree: 'counts' });
		} finally {
			window.setTimeout(() => this.plugin.muteStickyListModifyPaths.delete(created.path), 400);
		}
	}

	private async commitComposer(): Promise<void> {
		if (this.composing) return;
		const extra = this.getComposerMarkdown().trim();
		if (!extra) return;
		this.composing = true;
		try {
			const created = await this.plugin.stickies.addStickyWindow(
				{ color: this.selectedCreateColor() },
				undefined,
				{ openFloating: false, deferListRefresh: true, skipActiveWorkspace: true }
			);
			if (!created) return;
			try {
				const cur = await this.app.vault.read(created);
				await this.app.vault.modify(created, injectMarkdownAfterFrontmatter(cur, extra));
				await this.assignCreatedStickyToFilterWorkspaces(created);
				this.clearComposer();
				this.listPageIndex = 0;
				this.plugin.refreshStickyListIfOpen({ tree: 'counts' });
			} finally {
				window.setTimeout(() => this.plugin.muteStickyListModifyPaths.delete(created.path), 400);
			}
		} finally {
			this.composing = false;
		}
	}

	private async showCardMenu(evt: MouseEvent, anchorPath: string, anchorCard: HTMLElement): Promise<void> {
		const files = this.resolveMenuTargetFiles(anchorPath);
		if (files.length === 0) return;
		const n = files.length;
		const isBatch = n > 1;
		const openPaths = this.plugin.stickies.getOpenStickyNotePaths();

		const colors = files.map(f => this.getListCardColorFromDom(f));
		const allSameColor = colors.length > 0 && colors.every(c => c === colors[0]) && colors[0] !== null;
		const sharedColor = allSameColor ? colors[0]! : null;

		const archiveStates: boolean[] = [];
		for (const f of files) {
			if (files.length === 1) {
				archiveStates.push(anchorCard.dataset.csnArchived === 'true');
			} else {
				const fromDom = this.getListCardArchivedFromDom(f);
				archiveStates.push(
					fromDom !== null ? fromDom : await resolveStickyArchivedForFile(this.app, f)
				);
			}
		}
		const archivedCount = archiveStates.filter(Boolean).length;
		const allArchived = archivedCount === n;
		const allUnarchived = archivedCount === 0;
		const anyFloatOpen = files.some(f => openPaths.has(f.path));

		const menu = new Menu();
		menu.addItem(item => {
			item.setTitle(this.titleWithBatchCount(t('CHANGE_BG'), n)).setIcon('palette');
			const sub = item.setSubmenu();
			for (const c of SHEET_COLOR_ORDER) {
				const selected = sharedColor !== null && c.id === sharedColor;
				sub.addItem(si => {
					si.setTitle(buildStickyBgSubmenuTitle(document, c.id, t(c.labelKey), selected));
					si.setIcon(null);
					queueMicrotask(() => {
						si.dom?.classList.add('csn-list-bg-menu-item', `csn-list-bg-menu-item--${c.id}`);
						if (selected) si.dom?.classList.add('csn-list-bg-menu-item--selected');
					});
					si.onClick(() => {
						void (async () => {
							for (const f of files) {
								await this.plugin.stickies.setStickyBackgroundColorForFile(f, c.id);
								this.getCardElForPath(f.path)?.setAttr('data-csn-list-color', c.id);
							}
						})();
					});
				});
			}
		});
		menu.addItem(item => {
			item
				.setTitle(this.titleWithBatchCount(t('OPEN_STICKY_FLOAT'), n))
				.setIcon('square-pen')
				.onClick(() => {
					void (async () => {
						for (const f of files) await this.plugin.stickies.openStickyForFile(f);
					})();
				});
		});
		if (!isBatch) {
			menu.addItem(item => {
				item
					.setTitle(t('OPEN_NOTE'))
					.setIcon('file-text')
					.onClick(() => {
						void this.app.workspace.getLeaf('tab').openFile(files[0]!);
					});
			});
		}
		menu.addItem(item => {
			item
				.setTitle(this.titleWithBatchCount(t('CLOSE_STICKY_FLOAT'), n))
				.setIcon('x')
				.setDisabled(!anyFloatOpen)
				.onClick(() => {
					if (!anyFloatOpen) return;
					void (async () => {
						for (const f of files) {
							if (this.plugin.stickies.getOpenStickyNotePaths().has(f.path)) {
								await this.plugin.stickies.closeStickyWindowForFile(f);
							}
						}
					})();
				});
		});
		const activeWs = this.plugin.stickies.activeWorkspace();
		this.appendListCardWorkspaceTransferMenus(menu, files, activeWs ?? null, n);
		menu.addSeparator();

		const applyArchive = (targets: TFile[], next: boolean) => {
			void (async () => {
				let needRerender = false;
				for (const f of targets) {
					await this.plugin.stickies.setStickyArchivedForFile(f, next);
					if (this.listShouldRerenderForArchiveState(next)) needRerender = true;
				}
				if (needRerender) {
					void this.renderDash();
				} else {
					for (const f of targets) {
						const cardEl = this.getCardElForPath(f.path);
						if (cardEl) this.syncArchiveChromeOnCard(cardEl, next);
					}
				}
			})();
		};

		if (allArchived) {
			menu.addItem(item => {
				item
					.setTitle(this.titleWithBatchCount(t('LIST_UNARCHIVE_CARD'), n))
					.setIcon('archive-restore')
					.onClick(() => applyArchive(files, false));
			});
		} else if (allUnarchived) {
			menu.addItem(item => {
				item
					.setTitle(this.titleWithBatchCount(t('LIST_ARCHIVE_CARD'), n))
					.setIcon('archive')
					.onClick(() => applyArchive(files, true));
			});
		} else {
			const unarchivedFiles = files.filter((_, i) => !archiveStates[i]);
			const archivedFiles = files.filter((_, i) => archiveStates[i]);
			menu.addItem(item => {
				item
					.setTitle(
						this.titleWithBatchCount(t('LIST_BATCH_ARCHIVE_UNARCHIVED'), unarchivedFiles.length)
					)
					.setIcon('archive')
					.onClick(() => applyArchive(unarchivedFiles, true));
			});
			menu.addItem(item => {
				item
					.setTitle(
						this.titleWithBatchCount(t('LIST_BATCH_UNARCHIVE_ARCHIVED'), archivedFiles.length)
					)
					.setIcon('archive-restore')
					.onClick(() => applyArchive(archivedFiles, false));
			});
		}

		menu.addSeparator();
		menu.addItem(item => {
			item
				.setTitle(this.titleWithBatchCount(t('DELETE_NOTE'), n))
				.setIcon('trash-2')
				.onClick(() => {
					if (isBatch) {
						new ListBatchDeleteConfirmModal(this.app, {
							count: n,
							onConfirm: () => {
								void this.trashMenuTargetFiles(files);
							}
						}).open();
					} else {
						void this.plugin.stickies.trashStickyNoteFile(files[0]!);
					}
				});
		});
		menu.showAtMouseEvent(evt);
	}

	private appendListCardWorkspaceTransferMenus(
		menu: Menu,
		files: TFile[],
		_activeWs: { id: string; name: string } | null,
		batchCount: number
	): void {
		const file = this.plugin.stickies.workspaces;
		if (file.workspaces.length === 0) return;

		const addGroups = buildWorkspaceMenuGroups(
			file,
			() => true,
			ws => ({
				id: ws.id,
				name: ws.name,
				alreadyIn: files.every(f => this.plugin.stickies.isStickyInWorkspace(f, ws.id))
			})
		);
		if (addGroups.some(g => g.workspaces.length > 0)) {
			menu.addItem(item => {
				item
					.setTitle(this.titleWithBatchCount(t('LIST_ADD_TO_WORKSPACE'), batchCount))
					.setIcon('folder-plus');
				appendGroupedWorkspacePicker(item.setSubmenu(), addGroups, wsId => {
					void this.plugin.stickies.addFilesToWorkspace(wsId, files);
				});
			});
		}

		const removeGroups = buildWorkspaceMenuGroups(
			file,
			ws => files.some(f => this.plugin.stickies.isStickyInWorkspace(f, ws.id)),
			ws => ({ id: ws.id, name: ws.name })
		);
		if (removeGroups.some(g => g.workspaces.length > 0)) {
			menu.addItem(item => {
				item
					.setTitle(this.titleWithBatchCount(t('REMOVE_FROM_WORKSPACE'), batchCount))
					.setIcon('folder-minus');
				appendGroupedWorkspacePicker(item.setSubmenu(), removeGroups, wsId => {
					const targets = files.filter(f => this.plugin.stickies.isStickyInWorkspace(f, wsId));
					void this.plugin.stickies.removeFilesFromWorkspace(wsId, targets);
				});
			});
		}

		const moveGroups = buildWorkspaceMenuGroups(
			file,
			ws => files.some(f => !this.plugin.stickies.isStickyInWorkspace(f, ws.id)),
			ws => ({ id: ws.id, name: ws.name })
		);
		if (moveGroups.some(g => g.workspaces.length > 0)) {
			menu.addItem(item => {
				item
					.setTitle(this.titleWithBatchCount(t('LIST_MOVE_TO_WORKSPACE'), batchCount))
					.setIcon('folder-input');
				appendGroupedWorkspacePicker(item.setSubmenu(), moveGroups, wsId => {
					void this.plugin.stickies.moveFilesToWorkspace(wsId, files);
				});
			});
		}
	}

	private async renderCardPreview(previewEl: HTMLElement, f: TFile): Promise<void> {
		previewEl.empty();
		const md = listPreviewEmbedMarkdown(f);
		const host = this.ensureMarkdownHostForPath(f.path);
		await MarkdownRenderer.render(this.app, md, previewEl, f.path, host);
	}

	private updateCardChrome(
		card: HTMLElement,
		f: TFile,
		color: StickyColorId | null,
		pinnedSet: ReadonlySet<string>,
		archived: boolean
	): void {
		card.setAttr('data-csn-note-path', f.path);
		if (color == null) card.removeAttribute('data-csn-list-color');
		else card.setAttr('data-csn-list-color', color);
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
		const titleEl = card.querySelector('.csn-list-card-title');
		if (titleEl) titleEl.setText(f.basename);
		this.syncPinButton(card, f.path, pinnedSet);
		this.syncArchiveChromeOnCard(card, archived);
	}

	private async createCard(
		f: TFile,
		color: StickyColorId | null,
		pinnedSet: ReadonlySet<string>,
		archived: boolean
	): Promise<HTMLElement> {
		const cardAttr: Record<string, string> = {
			'data-csn-note-path': f.path,
			'data-csn-archived': archived ? 'true' : 'false',
			title: t('DOUBLE_CLICK_OPEN_TITLE')
		};
		if (color != null) cardAttr['data-csn-list-color'] = color;
		const card = this.contentEl.createDiv({
			cls: 'csn-list-card csn-dash-card',
			attr: cardAttr
		});
		card.remove();
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
		const head = card.createDiv({ cls: 'csn-list-card-head' });
		const headLeft = head.createDiv({ cls: 'csn-list-card-head-left' });
		const archiveWrap = headLeft.createEl('label', {
			cls: `csn-list-card-archive-wrap${archived ? ' is-archived' : ''}`,
			attr: { 'aria-hidden': 'false' }
		});
		const archiveCb = archiveWrap.createEl('input', {
			type: 'checkbox',
			cls: 'csn-list-card-archive-checkbox',
			attr: {
				'aria-label': archived
					? t('LIST_CARD_ARCHIVE_CBOX_ARIA_CHECKED')
					: t('LIST_CARD_ARCHIVE_CBOX_ARIA_UNCHECKED')
			}
		});
		archiveCb.checked = archived;
		headLeft.createDiv(
			{
				cls: 'csn-list-card-drag-handle',
				attr: {
					draggable: 'true',
					'aria-label': t('DASH_CARD_DRAG_ARIA'),
					title: t('DASH_CARD_DRAG_TITLE')
				}
			},
			(el: HTMLDivElement) => setIcon(el, 'grip-vertical')
		);
		headLeft.createDiv({
			cls: 'csn-list-card-title',
			text: f.basename,
			attr: { title: f.basename }
		});
		const headRight = head.createDiv({ cls: 'csn-list-card-head-right' });
		const isPinned = pinnedSet.has(normalizePath(f.path));
		headRight.createEl(
			'button',
			{
				type: 'button',
				cls: `clickable-icon csn-list-card-pin-btn${isPinned ? ' is-active' : ''}`,
				attr: {
					'aria-label': isPinned ? t('UNPIN_ARIA') : t('PIN_ARIA'),
					'aria-pressed': isPinned ? 'true' : 'false'
				}
			},
			(btn: HTMLButtonElement) => setIcon(btn, 'pin')
		);
		headRight.createEl(
			'button',
			{
				type: 'button',
				cls: 'clickable-icon csn-list-card-menu-btn',
				attr: { 'aria-label': t('MORE_ACTIONS_ARIA'), 'aria-haspopup': 'true' }
			},
			(btn: HTMLButtonElement) => setIcon(btn, 'more-horizontal')
		);
		const main = card.createDiv({ cls: 'csn-list-card-main' });
		const previewEl = main.createDiv({
			cls: 'csn-list-card-body csn-list-card-body--rendered csn-list-card-body--embed markdown-rendered'
		});
		await this.renderCardPreview(previewEl, f);
		card.dataset.csnEmbedMtime = String(f.stat.mtime);
		this.syncPinButton(card, f.path, pinnedSet);
		return card;
	}

	private async maybeRefreshCardPreview(card: HTMLElement, f: TFile): Promise<void> {
		const cur = card.dataset.csnEmbedMtime ?? '';
		const next = String(f.stat.mtime);
		if (cur === next) return;
		const previewEl = card.querySelector('.csn-list-card-body.csn-list-card-body--rendered');
		if (!(previewEl instanceof HTMLElement)) return;
		await this.renderCardPreview(previewEl, f);
		card.dataset.csnEmbedMtime = next;
	}

	private async renderCardsFull(
		container: HTMLElement,
		pageFiles: TFile[],
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		for (const f of pageFiles) {
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			const card = await this.createCard(f, color, pinnedSet, archived);
			container.appendChild(card);
		}
	}

	/**
	 * 筛选切换：旧卡片保持可见，新页准备好后一次性替换，避免 grid 清空后只剩输入区的闪烁。
	 */
	private async syncPageSwapReady(
		container: HTMLElement,
		pageFiles: TFile[],
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		const wantedSet = new Set(pageFiles.map(x => x.path));
		const existing = new Map<string, HTMLElement>();
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (p) existing.set(p, el);
		}

		const nextCards: HTMLElement[] = [];
		for (const f of pageFiles) {
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			const prev = existing.get(f.path);
			if (prev) {
				this.updateCardChrome(prev, f, color, pinnedSet, archived);
				await this.maybeRefreshCardPreview(prev, f);
				nextCards.push(prev);
			} else {
				nextCards.push(await this.createCard(f, color, pinnedSet, archived));
			}
		}

		const frag = document.createDocumentFragment();
		for (const card of nextCards) {
			frag.appendChild(card);
		}
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement)) {
				el.remove();
				continue;
			}
			if (el.hasClass('csn-list-card')) {
				const p = el.dataset.csnNotePath;
				if (p && !wantedSet.has(p)) this.disposeMarkdownHostForPath(p);
			}
			el.remove();
		}
		container.appendChild(frag);
	}

	private async syncPageIncremental(
		container: HTMLElement,
		pageFiles: TFile[],
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		const wantedSet = new Set(pageFiles.map(x => x.path));
		const existing = new Map<string, HTMLElement>();
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (!p) continue;
			if (!wantedSet.has(p)) {
				this.disposeMarkdownHostForPath(p);
				el.remove();
			} else {
				existing.set(p, el);
			}
		}
		for (let i = 0; i < pageFiles.length; i++) {
			const f = pageFiles[i]!;
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			let card = existing.get(f.path);
			if (!card) {
				card = await this.createCard(f, color, pinnedSet, archived);
			} else {
				this.updateCardChrome(card, f, color, pinnedSet, archived);
				await this.maybeRefreshCardPreview(card, f);
			}
			const at = container.children[i] ?? null;
			if (card !== at) {
				container.insertBefore(card, at);
			}
		}
	}

	private async syncPageContentOnly(
		container: HTMLElement,
		pageFiles: TFile[],
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		const byPath = new Map<string, HTMLElement>();
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (p) byPath.set(p, el);
		}
		if (byPath.size !== pageFiles.length) {
			await this.syncPageSwapReady(container, pageFiles, pinnedSet);
			return;
		}
		for (const f of pageFiles) {
			const card = byPath.get(f.path);
			if (!card) {
				await this.syncPageSwapReady(container, pageFiles, pinnedSet);
				return;
			}
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			this.updateCardChrome(card, f, color, pinnedSet, archived);
			await this.maybeRefreshCardPreview(card, f);
		}
	}

	private buildDashFilterKey(
		workspaceSel: DashWorkspaceSel,
		workspaceLogic: 'and' | 'or',
		dateFilter: StickyDateFilter | null,
		query: string,
		colorFilters: readonly StickyColorId[],
		areaMode: DashAreaMode,
		archiveFilter: NoteListArchiveFilter,
		tagInclude: readonly string[],
		tagExclude: readonly string[],
		tagLogic: 'and' | 'or',
		sortMode: NoteListSort,
		pageSize: number
	): string {
		return JSON.stringify({
			workspaceSel,
			workspaceLogic,
			dateFilter: stickyDateFilterKey(dateFilter),
			search: query,
			colors: [...colorFilters].sort(),
			area: areaMode,
			archive: archiveFilter,
			tagInclude: [...tagInclude].sort(),
			tagExclude: [...tagExclude].sort(),
			tagLogic,
			sort: sortMode,
			pageSize
		});
	}

	private buildDashStructureKey(
		workspaceSel: DashWorkspaceSel,
		workspaceLogic: 'and' | 'or',
		dateFilter: StickyDateFilter | null,
		query: string,
		colorFilters: readonly StickyColorId[],
		areaMode: DashAreaMode,
		archiveFilter: NoteListArchiveFilter,
		tagInclude: readonly string[],
		tagExclude: readonly string[],
		tagLogic: 'and' | 'or',
		sortMode: NoteListSort,
		pageSize: number,
		prioPath: string | null,
		filtered: TFile[],
		pinnedPaths: readonly string[]
	): string {
		return JSON.stringify({
			filter: this.buildDashFilterKey(
				workspaceSel,
				workspaceLogic,
				dateFilter,
				query,
				colorFilters,
				areaMode,
				archiveFilter,
				tagInclude,
				tagExclude,
				tagLogic,
				sortMode,
				pageSize
			),
			prio: prioPath ?? '',
			paths: filtered.map(f => f.path),
			pinned: [...pinnedPaths]
		});
	}

	/** 区域管理：未分组 / 未分类等（归档已由 archiveFilter 处理）。 */
	private applyAreaModeFilters(files: TFile[]): TFile[] {
		if (this.areaMode === 'ungrouped') {
			const mgr = this.plugin.stickies;
			const file = mgr.workspaces;
			const paths = new Set<string>();
			for (const ws of file.workspaces) {
				if (resolveWorkspaceTabGroupId(ws, file.tabGroups) !== WS_TAB_GROUP_UNGROUPED_ID) {
					continue;
				}
				for (const p of mgr.getWorkspaceMemberPathSet(ws)) paths.add(p);
			}
			return files.filter(f => paths.has(normalizePath(f.path)));
		}
		if (this.areaMode === 'uncategorized') {
			const assigned = this.plugin.stickies.getAllAssignedWorkspaceMemberPathSet();
			return files.filter(f => !assigned.has(normalizePath(f.path)));
		}
		return files;
	}

	/** 随机模式：锁定路径顺序，新增便笺追加到末尾。 */
	private applyRandomOrder(files: TFile[]): TFile[] {
		const byPath = new Map(files.map(f => [normalizePath(f.path), f] as const));
		if (!this.randomOrderPaths) {
			const shuffled = [...files];
			for (let i = shuffled.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const tmp = shuffled[i]!;
				shuffled[i] = shuffled[j]!;
				shuffled[j] = tmp;
			}
			this.randomOrderPaths = shuffled.map(f => normalizePath(f.path));
			return shuffled;
		}
		const ordered: TFile[] = [];
		const seen = new Set<string>();
		for (const p of this.randomOrderPaths) {
			const f = byPath.get(p);
			if (!f) continue;
			ordered.push(f);
			seen.add(p);
		}
		for (const f of files) {
			const p = normalizePath(f.path);
			if (seen.has(p)) continue;
			ordered.push(f);
			this.randomOrderPaths.push(p);
		}
		return ordered;
	}

	async renderDash(): Promise<void> {
		const run = this.dashRenderChain.catch(() => undefined).then(() => this.renderDashImpl());
		this.dashRenderChain = run;
		await run;
	}

	private async renderDashImpl(): Promise<void> {
		const container = this.gridEl;
		if (!container || !this.paginationEl || !this.paginationMetaEl) return;

		const query = (this.searchInput?.value ?? '').trim();

		try {
			const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
			const folderAbs = this.app.vault.getAbstractFileByPath(folder);
			if (!folderAbs || !(folderAbs instanceof TFolder)) {
				this.disposeAllMarkdownHosts();
				this.lastDashStructureKey = '';
				this.lastDashFilterKey = '';
				this.lastRenderedPageIndex = null;
				container.empty();
				container.createDiv({
					text: t('DASH_FOLDER_MISSING', { folder }),
					cls: 'csn-list-empty'
				});
				this.paginationPagesEl?.empty();
				this.paginationMetaEl.setText('');
				this.paginationEl.hide();
				return;
			}

			let files = collectMarkdownUnderFolder(folderAbs);
			await this.refreshAreaCounts(files);
			const wsPaths = this.resolveWorkspacePathFilter();
			if (wsPaths) files = files.filter(f => wsPaths.has(normalizePath(f.path)));

			const keywords = query
				.split(/\s+/)
				.filter(Boolean)
				.map(k => k.toLowerCase());
			if (keywords.length > 0) {
				files = await filterStickyFilesByKeywords(this.app, files, keywords);
			}

			files = await filterStickyFilesByColors(this.app, files, this.colorFilters);
			files = await filterStickyFilesByArchiveFilter(this.app, files, this.archiveFilter);
			files = filterStickyFilesByTags(
				this.app,
				files,
				this.tagIncludeFilters,
				this.tagExcludeFilters,
				this.tagFilterLogic
			);
			files = this.applyAreaModeFilters(files);

			this.noteDateCounts = dateCountsForFiles(files, this.calendarHeatField());
			this.noteDateKeys = new Set(this.noteDateCounts.keys());
			this.updateCalendarMarks();

			files = filterStickyFilesByDateFilter(
				files,
				this.selectedDateFilter,
				this.calendarHeatField()
			);
			const pinnedNorm = this.plugin.settings.noteListPinnedPaths.map(p => normalizePath(p));
			const pinnedSet = new Set(pinnedNorm);
			const prio = this.plugin.listPrioritizeStickyPath;
			const sortMode =
				this.areaMode === 'recent' ? 'mtime-desc' : this.plugin.settings.noteListSort;
			if (this.areaMode === 'random') {
				files = this.applyRandomOrder(files);
			} else {
				files = sortStickyListFiles(files, sortMode, pinnedNorm, prio);
			}

			if (files.length === 0) {
				this.lastDashStructureKey = '';
				this.lastDashFilterKey = '';
				this.lastRenderedPageIndex = null;
				const emptyEl = document.createElement('div');
				emptyEl.addClass('csn-list-empty');
				emptyEl.setText(t('DASH_EMPTY'));
				for (const el of Array.from(container.children)) {
					if (el instanceof HTMLElement && el.hasClass('csn-list-card')) {
						const p = el.dataset.csnNotePath;
						if (p) this.disposeMarkdownHostForPath(p);
					}
				}
				container.replaceChildren(emptyEl);
				this.paginationPagesEl?.empty();
				this.paginationMetaEl.setText('');
				this.paginationEl.hide();
				return;
			}

			const pageSize = Math.max(4, Math.min(48, Math.round(this.plugin.settings.noteListPageSize)));
			const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
			if (this.listPageIndex >= totalPages) this.listPageIndex = totalPages - 1;
			if (this.listPageIndex < 0) this.listPageIndex = 0;
			const start = this.listPageIndex * pageSize;
			const pageFiles = files.slice(start, start + pageSize);

			const filterKey = this.buildDashFilterKey(
				this.workspaceSel,
				this.workspaceFilterLogic,
				this.selectedDateFilter,
				query,
				this.colorFilters,
				this.areaMode,
				this.archiveFilter,
				this.tagIncludeFilters,
				this.tagExcludeFilters,
				this.tagFilterLogic,
				sortMode,
				pageSize
			);
			const structureKey = this.buildDashStructureKey(
				this.workspaceSel,
				this.workspaceFilterLogic,
				this.selectedDateFilter,
				query,
				this.colorFilters,
				this.areaMode,
				this.archiveFilter,
				this.tagIncludeFilters,
				this.tagExcludeFilters,
				this.tagFilterLogic,
				sortMode,
				pageSize,
				prio,
				files,
				pinnedNorm
			);

			const filterChanged = filterKey !== this.lastDashFilterKey;
			const structureChanged = structureKey !== this.lastDashStructureKey;
			const paginationOnly =
				!structureChanged &&
				this.lastRenderedPageIndex !== null &&
				this.lastRenderedPageIndex !== this.listPageIndex;
			const samePageContentTouch =
				!structureChanged &&
				this.lastRenderedPageIndex !== null &&
				this.lastRenderedPageIndex === this.listPageIndex;
			const membershipOnlyChanged = structureChanged && !filterChanged;

			this.lastDashFilterKey = filterKey;
			this.lastDashStructureKey = structureKey;

			if (filterChanged) {
				/* 先保留旧卡片再一次性换页，避免清空后只露出输入区 */
				await this.syncPageSwapReady(container, pageFiles, pinnedSet);
			} else if (membershipOnlyChanged || paginationOnly) {
				/* 新建/删除/翻页：复用未变动卡片的 Markdown 宿主，避免整表闪烁 */
				await this.syncPageIncremental(container, pageFiles, pinnedSet);
			} else if (samePageContentTouch) {
				await this.syncPageContentOnly(container, pageFiles, pinnedSet);
			} else {
				await this.syncPageSwapReady(container, pageFiles, pinnedSet);
			}
			this.syncListCardSelectionChrome();
			const pageIndexChanged =
				this.lastRenderedPageIndex !== null && this.lastRenderedPageIndex !== this.listPageIndex;
			this.lastRenderedPageIndex = this.listPageIndex;

			this.paginationEl.show();
			this.paginationMetaEl.setText(
				t('LIST_PAGINATION_META', { pageCount: pageFiles.length, totalCount: files.length })
			);
			if (totalPages <= 1) {
				this.paginationPagesEl?.empty();
				this.paginationRowEl?.hide();
			} else {
				this.paginationRowEl?.show();
				this.paginationPrevBtn!.disabled = this.listPageIndex <= 0;
				this.paginationNextBtn!.disabled = this.listPageIndex >= totalPages - 1;
				const pagesWrap = this.paginationPagesEl;
				if (pagesWrap) {
					pagesWrap.empty();
					const entries = buildPaginationEntries(totalPages, this.listPageIndex);
					const cur1 = this.listPageIndex + 1;
					for (const ent of entries) {
						if (ent === 'gap') {
							pagesWrap.createSpan({
								cls: 'csn-list-pagination-ellipsis',
								text: '…',
								attr: { 'aria-hidden': 'true' }
							});
							continue;
						}
						const isActive = ent === cur1;
						const btn = pagesWrap.createEl('button', {
							type: 'button',
							cls: `csn-list-pagination-page${isActive ? ' is-active' : ''}`,
							text: String(ent),
							attr: {
								'data-csn-list-page': String(ent - 1),
								'aria-label': t('LIST_PAGINATION_PAGE_ARIA', { page: ent }),
								...(isActive ? { 'aria-current': 'page' as const } : {})
							}
						});
						if (isActive) btn.disabled = true;
					}
				}
			}

			/* 仅筛选变更或翻页时回顶；成员增减保持滚动位置，减少闪动感 */
			if (filterChanged || pageIndexChanged) {
				container.scrollTop = 0;
			}
		} finally {
			this.persistDashboardFilters();
			if (this.plugin.listPrioritizeStickyPath) {
				this.plugin.listPrioritizeStickyPath = null;
			}
		}
	}

	async onClose(): Promise<void> {
		this.closeAreaVisibilityPanel();
		this.lastCalDateClickKey = null;
		this.flushComposerDraftToSettings();
		this.debouncedPersistComposerDraft = null;
		this.persistDashboardFilters();
		this.detachCalPickerDocClose();
		this.calPicker = null;
		this.leftPaneAutoCollapsedForWidth = false;
		this.leftPaneKeepOpenWhenNarrow = false;
		this.hideCanvasDragBehaviorHint();
		this.cancelPendingRefresh();
		this.debouncedStructureRefresh = null;
		this.debouncedContentRefresh = null;
		this.disposeAllMarkdownHosts();
		this.gridDelegatedEvents = false;
		this.lastDashStructureKey = '';
		this.lastDashFilterKey = '';
		this.lastRenderedPageIndex = null;
		this.selectedListNotePaths.clear();
		this.lastSelectedListNotePath = null;
		this.calendarEl = null;
		this.dateFilterChipsEl = null;
		this.dateFilterWrapEl = null;
		this.dateFilterAddBtn = null;
		this.dateFilterPanelEl = null;
		this.dateFilterModeEl = null;
		this.dateFilterModeBtns.clear();
		this.dateFilterInput = null;
		this.dateFilterConfirmBtn = null;
		this.dateFilterPanelGroupsEl = null;
		this.dateFilterPanelListEl = null;
		this.wsFilterWrapEl = null;
		this.wsFilterChipsEl = null;
		this.wsFilterAddBtn = null;
		this.wsFilterPanelEl = null;
		this.wsFilterPanelListEl = null;
		this.wsFilterPanelGroupsEl = null;
		this.wsFilterPanelSearchInput = null;
		this.wsLogicOrBtn = null;
		this.wsLogicAndBtn = null;
		this.composerEditor?.destroy();
		this.composerEditor = null;
		this.composerHostEl = null;
		this.composerFallbackEl = null;
		this.composerColorBtn = null;
		this.composerColorWrapEl = null;
		this.composerPaletteEl = null;
		this.composerColorSwatchBtns.clear();
		this.composerDoneBtn = null;
		this.treeEl = null;
		this.areaNavEl = null;
		this.areaPanelEl = null;
		this.areaVisibilityBtn = null;
		this.areaVisibilityPanelEl = null;
		this.areaVisibilityItemBtns.clear();
		this.wsPanelEl = null;
		this.leftPanelTitleBtns.clear();
		this.wsTreeFilterInput = null;
		this.wsTreeSortBtn = null;
		this.wsTreeCollapseBtn = null;
		this.wsTreeShowArchivedBtn = null;
		this.wsTreeAddBtn = null;
		this.wsTreeCardFocusBtn = null;
		this.searchInput = null;
		this.searchInnerEl = null;
		this.searchClearBtn = null;
		this.sortDropdownBtn = null;
		this.listBulkEditBtn = null;
		this.listCardOverflowClipBtn = null;
		this.composerToggleBtn = null;
		this.leftPaneToggleBtn = null;
		this.gridEl = null;
		this.paginationEl = null;
		this.paginationRowEl = null;
		this.paginationPagesEl = null;
		this.paginationPrevBtn = null;
		this.paginationNextBtn = null;
		this.paginationMetaEl = null;
		this.areaBtns.clear();
		this.colorBtns.clear();
		this.archiveFilterBtns.clear();
		this.contentEl.empty();
	}
}
