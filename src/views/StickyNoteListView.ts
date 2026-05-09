import {
	Component,
	ItemView,
	MarkdownRenderer,
	Menu,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	debounce,
	normalizePath,
	setIcon,
	type App,
	type Debouncer
} from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { t } from '../lang/helpers';
import type { MessageKey } from '../lang/locale/en';
import { clampViewContentZoom } from '../settings';
import {
	VIEW_STICKY_NOTE_LIST,
	type NoteListArchiveFilter,
	type NoteListFloatOpenFilter,
	type NoteListSort,
	type StickyColorId
} from '../types';
import '../obsidian-augmentations';
import { resolveStickyBgColorForFile } from '../utils/sticky-bg-from-file';
import { resolveStickyArchivedForFile } from '../utils/sticky-archived-from-file';
import { SHEET_COLOR_ORDER } from '../sticky/sticky-color-order';
import { stickyWorkspacesJsonVaultPath } from '../workspace-store';

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

/** 工具栏「浮动窗口」筛选：与 `settings.noteListFloatOpenFilter` 一一对应。 */
const NOTE_LIST_FLOAT_OPEN_SPECS: readonly {
	mode: NoteListFloatOpenFilter;
	icon: string;
	titleKey: MessageKey;
}[] = [
		{ mode: 'all', icon: 'layout-grid', titleKey: 'FLOAT_ALL_STICKIES' },
		{ mode: 'open', icon: 'square-pen', titleKey: 'FLOAT_OPEN_ONLY' },
		{ mode: 'closed', icon: 'file', titleKey: 'FLOAT_CLOSED_ONLY' }
	];

/** 工具栏「归档」筛选：与 `settings.noteListArchiveFilter` 一一对应。 */
const NOTE_LIST_ARCHIVE_SPECS: readonly {
	mode: NoteListArchiveFilter;
	icon: string;
	titleKey: MessageKey;
}[] = [
		{ mode: 'all', icon: 'list', titleKey: 'ARCHIVE_FILTER_ALL' },
		{ mode: 'unarchived', icon: 'inbox', titleKey: 'ARCHIVE_FILTER_UNARCHIVED' },
		{ mode: 'archived', icon: 'archive', titleKey: 'ARCHIVE_FILTER_ARCHIVED' }
	];

/** `pinnedNorm` 为已 normalize 的路径数组，顺序即置顶顺序；不在数组中为未置顶。 */
function pinnedSortRank(notePath: string, pinnedNorm: readonly string[]): number {
	const i = pinnedNorm.indexOf(normalizePath(notePath));
	return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function compareStickyListFiles(a: TFile, b: TFile, sort: NoteListSort): number {
	switch (sort) {
		case 'ctime-desc': {
			const d = b.stat.ctime - a.stat.ctime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'ctime-asc': {
			const d = a.stat.ctime - b.stat.ctime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'mtime-desc': {
			const d = b.stat.mtime - a.stat.mtime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'mtime-asc': {
			const d = a.stat.mtime - b.stat.mtime;
			if (d !== 0) return d;
			return a.path.localeCompare(b.path);
		}
		case 'basename-asc': {
			const c = a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
			if (c !== 0) return c;
			return a.path.localeCompare(b.path);
		}
		case 'basename-desc': {
			const c = b.basename.localeCompare(a.basename, undefined, { numeric: true, sensitivity: 'base' });
			if (c !== 0) return c;
			return a.path.localeCompare(b.path);
		}
		default:
			return a.path.localeCompare(b.path);
	}
}

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
	if (selected) row.classList.add('csn-list-bg-menu-row--selected');

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

function collectMarkdownUnderFolder(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	for (const c of folder.children) {
		if (c instanceof TFile && c.extension === 'md') out.push(c);
		else if (c instanceof TFolder) out.push(...collectMarkdownUnderFolder(c));
	}
	return out;
}

/** 多个关键词为「且」关系；在标题、路径与全文（cachedRead，不区分大小写子串）中匹配。 */
async function filterStickyFilesByKeywords(
	app: App,
	files: TFile[],
	keywords: string[]
): Promise<TFile[]> {
	if (keywords.length === 0) return files;
	const flags = await Promise.all(
		files.map(async f => {
			let body = '';
			try {
				body = (await app.vault.cachedRead(f)).toLowerCase();
			} catch {
				/* 读取失败则仅以标题/路径参与匹配 */
			}
			const hay = `${f.basename}\n${f.path}\n${body}`.toLowerCase();
			return keywords.every(k => hay.includes(k));
		})
	);
	return files.filter((_, i) => flags[i]!);
}

/**
 * 生成 1-based 页码序列：含间断时用占位 `'gap'` 渲染为省略号。
 * 总页数较多时大致为「1 2 3 … 中间窗口 … 末三页」形态。
 */
function buildPaginationEntries(totalPages: number, currentPage0: number): Array<number | 'gap'> {
	const T = totalPages;
	const c = Math.min(Math.max(currentPage0 + 1, 1), T);
	if (T <= 1) return [1];
	if (T <= 9) return Array.from({ length: T }, (_, i) => i + 1);

	const s = new Set<number>();
	for (const p of [1, 2, 3, T - 2, T - 1, T, c - 1, c, c + 1]) {
		if (p >= 1 && p <= T) s.add(p);
	}
	const arr = [...s].sort((a, b) => a - b);
	const out: Array<number | 'gap'> = [];
	for (let i = 0; i < arr.length; i++) {
		if (i > 0 && arr[i]! - arr[i - 1]! > 1) out.push('gap');
		out.push(arr[i]!);
	}
	return out;
}

/** 空数组表示不过滤；否则保留解析颜色命中任一选中色的便笺（或关系）。 */
async function filterStickyFilesByColors(
	app: App,
	files: TFile[],
	colors: readonly StickyColorId[]
): Promise<TFile[]> {
	if (colors.length === 0) return files;
	const want = new Set(colors);
	const rows = await Promise.all(
		files.map(async f => {
			const c = (await resolveStickyBgColorForFile(app, f)) ?? 'default';
			return want.has(c) ? f : null;
		})
	);
	return rows.filter((f): f is TFile => f !== null);
}

async function filterStickyFilesByArchiveFilter(
	app: App,
	files: TFile[],
	mode: NoteListArchiveFilter
): Promise<TFile[]> {
	if (mode === 'all') return files;
	const flags = await Promise.all(files.map(f => resolveStickyArchivedForFile(app, f)));
	if (mode === 'archived') return files.filter((_, i) => flags[i]!);
	return files.filter((_, i) => !flags[i]!);
}

export class StickyNoteListView extends ItemView {
	private listItemsEl: HTMLElement | null = null;
	/** 搜索 + 工具栏外层容器（与卡片区分隔）。 */
	private listToolRegionEl: HTMLElement | null = null;
	private readonly colorFilterBtnById = new Map<StickyColorId, HTMLButtonElement>();
	private workspaceFilterDropdownBtn: HTMLButtonElement | null = null;
	private floatFilterDropdownBtn: HTMLButtonElement | null = null;
	private archiveFilterDropdownBtn: HTMLButtonElement | null = null;
	private sortDropdownBtn: HTMLButtonElement | null = null;
	/** 颜色筛选：调色板按钮 + 右侧展开的色条 */
	private colorFilterWrapEl: HTMLElement | null = null;
	private colorFilterPaletteBtn: HTMLButtonElement | null = null;
	private searchInput: HTMLInputElement | null = null;
	private searchInnerEl: HTMLElement | null = null;
	private searchClearBtn: HTMLButtonElement | null = null;
	private paginationEl: HTMLElement | null = null;
	private paginationRowEl: HTMLElement | null = null;
	private paginationPagesEl: HTMLElement | null = null;
	private paginationPrevBtn: HTMLButtonElement | null = null;
	private paginationNextBtn: HTMLButtonElement | null = null;
	private paginationMetaEl: HTMLElement | null = null;
	/** 每张列表卡片嵌入预览各自一个 Component，便于翻页时按路径卸载/复用。 */
	private readonly listCardMarkdownHosts = new Map<string, Component>();
	private listItemsDelegatedEvents = false;
	/** 上次渲染的列表结构指纹（排序、筛选、便笺集等）；一致时翻页可走 DOM 增量。 */
	private lastListStructureKey = '';
	private lastRenderedPageIndex: number | null = null;
	private listPageIndex = 0;
	private debouncedListStructureRefresh: Debouncer<[], void> | null = null;
	private debouncedListContentRefresh: Debouncer<[], void> | null = null;
	/** 串行执行列表渲染，避免并发清空/填充 DOM 或误清 `listPrioritizeStickyPath` 导致置顶与预览错乱。 */
	private listRenderChain: Promise<void> = Promise.resolve();
	/** 开启后卡片头部显示归档复选框，便于勾选修改。 */
	private listArchiveCheckboxEditMode = false;
	private listBulkEditBtn: HTMLButtonElement | null = null;
	/** 列表预览区是否在固定高度内裁剪/滚动（与 `settings.noteListCardOverflowHidden` 一致）。 */
	private listCardOverflowClipBtn: HTMLButtonElement | null = null;
	/** 颜色条 `aria-controls` / `id`，避免多开列表视图时 DOM id 冲突 */
	private readonly colorFilterStripDomId = `csn-list-cf-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())}`;
	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ColorfulStickyNotesPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_STICKY_NOTE_LIST;
	}

	getDisplayText(): string {
		return t('DISPLAY_STICKY_LIST');
	}

	getIcon(): string {
		return 'layout-list';
	}

	/** 立即整表重绘（不取消已排队的防抖；一般不要用在与 `create` 防抖叠加的场景）。 */
	requestRedraw(): void {
		void this.renderList();
	}

	/**
	 * 取消结构/正文防抖并立即重绘。新建便笺后由插件调用，避免 `vault.create` 已触发的防抖与主动刷新各跑一次 `renderList`。
	 */
	flushListRedraw(): void {
		this.cancelListRefreshDebouncers();
		void this.renderList();
	}

	/** 每页条数等变更时回到第一页并重绘。 */
	resetPageAndRedraw(): void {
		this.listPageIndex = 0;
		void this.renderList();
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

	private listShouldRerenderForArchiveState(archived: boolean): boolean {
		const m = this.plugin.settings.noteListArchiveFilter;
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
		void this.renderList();
	}

	/** 按设置里的 `noteListViewContentZoom` 更新已渲染卡片上的 CSS 变量，不重渲 Markdown。 */
	syncViewContentZoomFromSettings(): void {
		if (!this.listItemsEl) return;
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		this.listItemsEl.querySelectorAll('.csn-list-card').forEach(card => {
			if (card instanceof HTMLElement) {
				card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
			}
		});
	}

	/** 从设置写入根节点 CSS 变量（网格列宽、卡片高度）及预览区 overflow（`.csn-list-card-body--rendered`）。 */
	syncListGridMetricsFromSettings(): void {
		if (!this.contentEl.hasClass('csn-list-view')) return;
		const h = this.plugin.settings.noteListCardHeight;
		const w = this.plugin.settings.noteListGridMinWidth;
		this.contentEl.style.setProperty('--csn-list-card-height', `${h}px`);
		this.contentEl.style.setProperty('--csn-list-grid-min-width', `${w}px`);
		this.contentEl.toggleClass(
			'csn-list-view--card-overflow-visible',
			!this.plugin.settings.noteListCardOverflowHidden
		);
		this.syncCardOverflowClipToolbarBtn();
	}

	private syncCardOverflowClipToolbarBtn(): void {
		if (!this.listCardOverflowClipBtn) return;
		const clip = this.plugin.settings.noteListCardOverflowHidden;
		this.listCardOverflowClipBtn.toggleClass('is-active', clip);
		this.listCardOverflowClipBtn.setAttr('aria-pressed', clip ? 'true' : 'false');
	}

	private disposeMarkdownHostForPath(path: string): void {
		const c = this.listCardMarkdownHosts.get(path);
		if (c) {
			this.removeChild(c);
			this.listCardMarkdownHosts.delete(path);
		}
	}

	private disposeAllListCardMarkdownHosts(): void {
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

	private buildListStructureKey(
		sortMode: NoteListSort,
		query: string,
		colorFilters: readonly StickyColorId[],
		floatOpen: NoteListFloatOpenFilter,
		archiveFilter: NoteListArchiveFilter,
		pageSize: number,
		prioPath: string | null,
		filtered: TFile[],
		pinnedPaths: readonly string[]
	): string {
		return JSON.stringify({
			sort: sortMode,
			query,
			colors: [...colorFilters].sort(),
			workspace: this.plugin.settings.noteListWorkspaceFilterId ?? '',
			floatOpen,
			archive: archiveFilter,
			pageSize,
			prio: prioPath ?? '',
			paths: filtered.map(f => f.path),
			pinned: [...pinnedPaths]
		});
	}

	private registerListItemsDelegatedEvents(): void {
		if (this.listItemsDelegatedEvents || !this.listItemsEl) return;
		this.listItemsDelegatedEvents = true;

		this.registerDomEvent(this.listItemsEl, 'dragstart', (evt: DragEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const titleEl = hit.closest('.csn-list-card-title');
			if (!titleEl || !this.listItemsEl?.contains(titleEl)) return;
			const card = titleEl.closest('.csn-list-card');
			if (!card) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
			const md = this.app.fileManager.generateMarkdownLink(f, sourcePath);
			const dt = evt.dataTransfer;
			if (!dt) return;
			dt.setData('text/plain', md);
			dt.effectAllowed = 'copy';
		});

		this.registerDomEvent(this.listItemsEl, 'click', (evt: MouseEvent) => {
			const hit = evt.target;
			if (!(hit instanceof Element)) return;
			const pinBtn = hit.closest('.csn-list-card-pin-btn');
			if (pinBtn && this.listItemsEl?.contains(pinBtn)) {
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
			if (!btn || !this.listItemsEl?.contains(btn)) return;
			const card = btn.closest('.csn-list-card');
			if (!card) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			const rawListColor = (card as HTMLElement).dataset.csnListColor;
			const color: StickyColorId | null =
				rawListColor && rawListColor.length > 0 ? (rawListColor as StickyColorId) : null;
			const floatOpen = this.plugin.stickies.getOpenStickyNotePaths().has(f.path);
			const menu = new Menu();
			menu.addItem(item => {
				item.setTitle(t('CHANGE_BG')).setIcon('palette');
				const sub = item.setSubmenu();
				for (const c of SHEET_COLOR_ORDER) {
					const selected = color !== null && c.id === color;
					sub.addItem(si => {
						si.setTitle(buildStickyBgSubmenuTitle(document, c.id, t(c.labelKey), selected));
						si.setIcon(null);
						si.onClick(() => {
							void this.plugin.stickies.setStickyBackgroundColorForFile(f, c.id).then(() => {
								(card as HTMLElement).setAttr('data-csn-list-color', c.id);
							});
						});
					});
				}
			});
			menu.addItem(item => {
				item.setTitle(t('OPEN_STICKY_FLOAT'))
					.setIcon('square-pen')
					.onClick(() => {
						void this.plugin.stickies.openStickyForFile(f);
					});
			});
			menu.addItem(item => {
				item.setTitle(t('OPEN_NOTE'))
					.setIcon('file-text')
					.onClick(() => {
						void this.app.workspace.getLeaf('tab').openFile(f);
					});
			});
			menu.addItem(item => {
				item.setTitle(t('CLOSE_STICKY_FLOAT'))
					.setIcon('x')
					.setDisabled(!floatOpen)
					.onClick(() => {
						if (!floatOpen) return;
						void this.plugin.stickies.closeStickyWindowForFile(f);
					});
			});
			menu.addSeparator();
			const archivedNow = (card as HTMLElement).dataset.csnArchived === 'true';
			menu.addItem(item => {
				item.setTitle(archivedNow ? t('LIST_UNARCHIVE_CARD') : t('LIST_ARCHIVE_CARD'))
					.setIcon(archivedNow ? 'archive-restore' : 'archive')
					.onClick(() => {
						const next = !archivedNow;
						void this.plugin.stickies.setStickyArchivedForFile(f, next).then(() => {
							if (this.listShouldRerenderForArchiveState(next)) {
								void this.renderList();
							} else {
								this.syncArchiveChromeOnCard(card as HTMLElement, next);
							}
						});
					});
			});
			menu.addSeparator();
			menu.addItem(item => {
				item.setTitle(t('DELETE_NOTE'))
					.setIcon('trash-2')
					.onClick(() => {
						void this.plugin.stickies.trashStickyNoteFile(f);
					});
			});
			menu.showAtMouseEvent(evt);
		});

		this.registerDomEvent(this.listItemsEl, 'change', (evt: Event) => {
			const t = evt.target;
			if (!(t instanceof HTMLInputElement) || !t.classList.contains('csn-list-card-archive-checkbox')) return;
			const card = t.closest('.csn-list-card');
			if (!card || !this.listItemsEl?.contains(card)) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			const wantArchived = t.checked;
			void this.plugin.stickies.setStickyArchivedForFile(f, wantArchived).then(() => {
				if (this.listShouldRerenderForArchiveState(wantArchived)) {
					void this.renderList();
				} else {
					this.syncArchiveChromeOnCard(card as HTMLElement, wantArchived);
				}
			});
		});

		this.registerDomEvent(this.listItemsEl, 'dblclick', (evt: MouseEvent) => {
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
			if (!card || !this.listItemsEl?.contains(card)) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.plugin.openStickyForFile(f);
		});
	}

	private stickyFolderRoot(): string {
		return normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
	}

	private pathUnderStickyFolder(path: string): boolean {
		const root = this.stickyFolderRoot();
		const p = normalizePath(path);
		return p === root || p.startsWith(`${root}/`);
	}

	private cancelListRefreshDebouncers(): void {
		this.debouncedListStructureRefresh?.cancel();
		this.debouncedListContentRefresh?.cancel();
	}

	/** 取消防抖中的列表刷新（不重绘）。新建便笺时先调用，再延迟 `flushListRedraw`，避免与 `vault.create` 触发的结构防抖叠在 `openFile` 同一时段执行。 */
	cancelPendingListRefresh(): void {
		this.cancelListRefreshDebouncers();
	}

	private registerVaultListRefresh(): void {
		this.debouncedListStructureRefresh = debounce(() => {
			this.listPageIndex = 0;
			void this.renderList();
		}, 80, false);

		this.debouncedListContentRefresh = debounce(() => {
			void this.renderList();
		}, 280, false);

		this.register(() => {
			this.cancelListRefreshDebouncers();
		});

		this.registerEvent(
			this.app.vault.on('create', (f: TAbstractFile) => {
				if (!this.pathUnderStickyFolder(f.path)) return;
				/* 与 delete/rename 一致走结构防抖；插件新建末尾会 `flushListRedraw` 取消防抖并立刻重绘，避免双次整表渲染 */
				this.debouncedListStructureRefresh?.();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (f: TAbstractFile) => {
				if (this.pathUnderStickyFolder(f.path)) this.debouncedListStructureRefresh?.();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
				if (this.pathUnderStickyFolder(f.path) || this.pathUnderStickyFolder(oldPath)) {
					this.debouncedListStructureRefresh?.();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (f: TAbstractFile) => {
				if (f instanceof TFile && f.extension === 'md' && this.pathUnderStickyFolder(f.path)) {
					if (this.plugin.muteStickyListModifyPaths.has(f.path)) return;
					this.debouncedListContentRefresh?.();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', file => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.pathUnderStickyFolder(file.path)) return;
				if (this.plugin.muteStickyListModifyPaths.has(file.path)) return;
				this.debouncedListContentRefresh?.();
			})
		);
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('csn-list-view');

		const toolRegion = root.createDiv({ cls: 'csn-list-tool-region' });
		this.listToolRegionEl = toolRegion;

		const searchWrap = toolRegion.createDiv({ cls: 'csn-list-search' });
		const searchInner = searchWrap.createDiv({ cls: 'csn-list-search-inner' });
		this.searchInnerEl = searchInner;
		this.searchInput = searchInner.createEl('input', {
			type: 'text',
			cls: 'csn-list-search-input',
			attr: {
				placeholder: t('SEARCH_PLACEHOLDER'),
				spellcheck: 'false',
				'aria-label': t('SEARCH_ARIA'),
				role: 'searchbox',
				autocomplete: 'off'
			}
		});
		this.searchClearBtn = searchInner.createEl('button', {
			type: 'button',
			cls: 'csn-list-search-clear csn-list-search-clear--hidden',
			attr: { 'aria-label': t('CLEAR_SEARCH_ARIA') }
		});
		setIcon(this.searchClearBtn, 'x');
		this.registerDomEvent(this.searchClearBtn, 'click', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.searchInput) {
				this.searchInput.value = '';
				this.searchInput.focus();
			}
			this.syncSearchClearVisibility();
			this.listPageIndex = 0;
			void this.renderList();
		});

		const toolbar = toolRegion.createDiv({ cls: 'csn-list-toolbar' });

		const toolbarLeft = toolbar.createDiv({ cls: 'csn-list-toolbar-left' });

		const workspaceGroup = toolbarLeft.createDiv({ cls: 'csn-list-toolbar-dropdown-group' });
		this.workspaceFilterDropdownBtn = workspaceGroup.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.registerDomEvent(this.workspaceFilterDropdownBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openWorkspaceFilterMenu(evt);
		});

		const wsJsonPath = stickyWorkspacesJsonVaultPath(this.plugin);
		this.registerEvent(
			this.app.vault.on('modify', f => {
				if (normalizePath(f.path) !== wsJsonPath) return;
				this.syncToolbarDropdownHints();
				void this.renderList();
			})
		);

		const floatGroup = toolbarLeft.createDiv({ cls: 'csn-list-toolbar-dropdown-group' });
		this.floatFilterDropdownBtn = floatGroup.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.registerDomEvent(this.floatFilterDropdownBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openFloatFilterMenu(evt);
		});

		const archiveGroup = toolbarLeft.createDiv({ cls: 'csn-list-toolbar-dropdown-group' });
		this.archiveFilterDropdownBtn = archiveGroup.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.registerDomEvent(this.archiveFilterDropdownBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openArchiveFilterMenu(evt);
		});

		this.colorFilterWrapEl = toolbarLeft.createDiv({ cls: 'csn-list-toolbar-color-wrap' });
		this.colorFilterPaletteBtn = this.colorFilterWrapEl.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-list-color-palette-btn',
			attr: {
				'aria-haspopup': 'true',
				'aria-expanded': 'false',
				'aria-controls': this.colorFilterStripDomId
			}
		});
		setIcon(this.colorFilterPaletteBtn, 'palette');
		this.registerDomEvent(this.colorFilterPaletteBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleColorFilterStrip();
		});

		const colorStrip = this.colorFilterWrapEl.createDiv({
			cls: 'csn-list-color-filter-strip',
			attr: { id: this.colorFilterStripDomId, role: 'group' }
		});
		colorStrip.setAttr('aria-label', t('LIST_COLOR_FILTER_POPOVER_GROUP_ARIA'));
		const colorBtns = colorStrip.createDiv({
			cls: 'csn-list-color-filter-btns csn-list-color-filter-btns--compact'
		});
		this.colorFilterBtnById.clear();

		for (const c of SHEET_COLOR_ORDER) {
			const lab = t(c.labelKey);
			const sw = colorBtns.createEl('button', {
				type: 'button',
				cls: 'clickable-icon csn-list-color-filter-btn csn-list-color-filter-swatch',
				attr: {
					'aria-label': t('LIST_COLOR_SWATCH_FILTER_HINT', { label: lab }),
					'data-csn-list-color': c.id
				}
			});
			this.colorFilterBtnById.set(c.id, sw);
			this.registerDomEvent(sw, 'click', (e: MouseEvent) => {
				e.stopPropagation();
				void this.toggleListColorFilter(c.id);
			});
		}

		const toolbarActions = toolbar.createDiv({ cls: 'csn-list-toolbar-actions' });

		const newStickyBtn = toolbarActions.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn',
			attr: { 'aria-label': t('NEW_STICKY_ARIA') }
		});
		setIcon(newStickyBtn, 'plus');
		this.registerDomEvent(newStickyBtn, 'click', () => {
			void this.plugin.stickies.addStickyWindow();
		});

		this.listBulkEditBtn = toolbarActions.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn csn-list-bulk-edit-btn',
			attr: {
				'aria-label': t('LIST_EDIT_CARDS_TOGGLE_ARIA'),
				'aria-pressed': 'false'
			}
		});
		setIcon(this.listBulkEditBtn, 'pencil');
		this.registerDomEvent(this.listBulkEditBtn, 'click', () => {
			this.listArchiveCheckboxEditMode = !this.listArchiveCheckboxEditMode;
			this.syncListArchiveCheckboxEditUI();
		});

		this.sortDropdownBtn = toolbarActions.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-icon-btn',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.registerDomEvent(this.sortDropdownBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openSortDropdownMenu(evt);
		});

		this.listCardOverflowClipBtn = toolbarActions.createEl('button', {
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

		this.listItemsEl = root.createDiv({ cls: 'csn-list-items' });
		this.registerListItemsDelegatedEvents();
		this.syncListGridMetricsFromSettings();

		this.paginationEl = root.createDiv({ cls: 'csn-list-pagination' });
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
			void this.renderList();
		});
		this.registerDomEvent(this.paginationNextBtn, 'click', () => {
			this.listPageIndex += 1;
			void this.renderList();
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
			void this.renderList();
		});

		const render = debounce(
			() => {
				this.listPageIndex = 0;
				void this.renderList();
			},
			120,
			true
		);

		this.registerDomEvent(this.searchInput, 'input', () => {
			this.syncSearchClearVisibility();
			render();
		});
		this.registerVaultListRefresh();
		this.syncToolbarDropdownHints();
		this.syncColorFilterPaletteAria();
		this.syncColorFilterToolbarActive();
		this.syncListArchiveCheckboxEditUI();
		this.syncSearchClearVisibility();
		void this.renderList();
	}

	private syncSearchClearVisibility(): void {
		const has = ((this.searchInput?.value ?? '').length > 0);
		this.searchInnerEl?.toggleClass('csn-list-search-inner--has-clear', has);
		this.searchClearBtn?.toggleClass('csn-list-search-clear--hidden', !has);
		this.searchClearBtn?.setAttr('aria-hidden', has ? 'false' : 'true');
		this.searchClearBtn?.setAttr('tabindex', has ? '0' : '-1');
	}

	/** 下拉按钮：主图标与无障碍说明随当前筛选/排序同步。 */
	private syncToolbarDropdownHints(): void {
		if (this.workspaceFilterDropdownBtn) {
			this.workspaceFilterDropdownBtn.empty();
			setIcon(this.workspaceFilterDropdownBtn, 'layers');
			const wid = this.plugin.settings.noteListWorkspaceFilterId;
			const title =
				wid === null
					? t('LIST_WORKSPACE_FILTER_TOOLBAR_TITLE_NONE')
					: (this.plugin.stickies.workspaces.workspaces.find(w => w.id === wid)?.name ?? wid);
			this.workspaceFilterDropdownBtn.setAttr(
				'aria-label',
				t('LIST_TOOLBAR_WORKSPACE_PREFIX', { title })
			);
		}

		const sortSpec =
			NOTE_LIST_SORT_SPECS.find(s => s.mode === this.plugin.settings.noteListSort) ??
			NOTE_LIST_SORT_SPECS[0]!;
		if (this.sortDropdownBtn) {
			this.sortDropdownBtn.empty();
			setIcon(this.sortDropdownBtn, sortSpec.toolbarIcon ?? NOTE_LIST_SORT_TOOLBAR_ICON);
			const sortTitle = t(sortSpec.titleKey);
			this.sortDropdownBtn.setAttr('aria-label', t('LIST_TOOLBAR_SORT_PREFIX', { title: sortTitle }));
		}

		const archiveSpec =
			NOTE_LIST_ARCHIVE_SPECS.find(s => s.mode === this.plugin.settings.noteListArchiveFilter) ??
			NOTE_LIST_ARCHIVE_SPECS[0]!;
		if (this.archiveFilterDropdownBtn) {
			this.archiveFilterDropdownBtn.empty();
			setIcon(this.archiveFilterDropdownBtn, archiveSpec.icon);
			const archiveTitle = t(archiveSpec.titleKey);
			this.archiveFilterDropdownBtn.setAttr(
				'aria-label',
				t('LIST_TOOLBAR_ARCHIVE_PREFIX', { title: archiveTitle })
			);
		}

		const floatSpec =
			NOTE_LIST_FLOAT_OPEN_SPECS.find(
				s => s.mode === this.plugin.settings.noteListFloatOpenFilter
			) ?? NOTE_LIST_FLOAT_OPEN_SPECS[0]!;
		if (this.floatFilterDropdownBtn) {
			this.floatFilterDropdownBtn.empty();
			setIcon(this.floatFilterDropdownBtn, floatSpec.icon);
			const floatTitle = t(floatSpec.titleKey);
			this.floatFilterDropdownBtn.setAttr(
				'aria-label',
				t('LIST_TOOLBAR_WINDOW_PREFIX', { title: floatTitle })
			);
		}
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

	private openFloatFilterMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const cur = this.plugin.settings.noteListFloatOpenFilter;
		for (const spec of NOTE_LIST_FLOAT_OPEN_SPECS) {
			menu.addItem(item => {
				item
					.setTitle(t(spec.titleKey))
					.setIcon(spec.icon)
					.setChecked(spec.mode === cur)
					.onClick(() => {
						void this.setListFloatOpenFilter(spec.mode);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private openWorkspaceFilterMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const cur = this.plugin.settings.noteListWorkspaceFilterId;
		for (const ws of this.plugin.stickies.workspaces.workspaces) {
			const id = ws.id;
			menu.addItem(item => {
				item
					.setTitle(ws.name)
					.setIcon('layers')
					.setChecked(id === cur)
					.onClick(async () => {
						const current = this.plugin.settings.noteListWorkspaceFilterId;
						const next = current === id ? null : id;
						if (next === current) return;
						this.plugin.settings.noteListWorkspaceFilterId = next;
						await this.plugin.saveSettings();
						this.syncToolbarDropdownHints();
						this.listPageIndex = 0;
						void this.renderList();
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private syncSortToolbarActive(): void {
		this.syncToolbarDropdownHints();
	}

	private async setListSort(sort: NoteListSort): Promise<void> {
		if (this.plugin.settings.noteListSort === sort) return;
		this.plugin.settings.noteListSort = sort;
		await this.plugin.saveSettings();
		this.syncSortToolbarActive();
		this.listPageIndex = 0;
		void this.renderList();
	}

	private syncFloatOpenToolbarActive(): void {
		this.syncToolbarDropdownHints();
	}

	private async setListFloatOpenFilter(mode: NoteListFloatOpenFilter): Promise<void> {
		if (this.plugin.settings.noteListFloatOpenFilter === mode) return;
		this.plugin.settings.noteListFloatOpenFilter = mode;
		await this.plugin.saveSettings();
		this.syncFloatOpenToolbarActive();
		this.listPageIndex = 0;
		void this.renderList();
	}

	private syncArchiveToolbarActive(): void {
		this.syncToolbarDropdownHints();
	}

	private async setListArchiveFilter(mode: NoteListArchiveFilter): Promise<void> {
		if (this.plugin.settings.noteListArchiveFilter === mode) return;
		this.plugin.settings.noteListArchiveFilter = mode;
		await this.plugin.saveSettings();
		this.syncArchiveToolbarActive();
		this.listPageIndex = 0;
		void this.renderList();
	}

	private openArchiveFilterMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const cur = this.plugin.settings.noteListArchiveFilter;
		for (const spec of NOTE_LIST_ARCHIVE_SPECS) {
			menu.addItem(item => {
				item
					.setTitle(t(spec.titleKey))
					.setIcon(spec.icon)
					.setChecked(spec.mode === cur)
					.onClick(() => {
						void this.setListArchiveFilter(spec.mode);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private syncColorFilterPaletteAria(): void {
		if (!this.colorFilterPaletteBtn) return;
		const n = this.plugin.settings.noteListColorFilters.length;
		const title =
			n === 0 ? t('LIST_COLOR_FILTER_SUMMARY_ALL') : t('LIST_COLOR_FILTER_SUMMARY_SOME', { n });
		this.colorFilterPaletteBtn.setAttr('aria-label', title);
		this.colorFilterWrapEl?.toggleClass('has-color-filter', n > 0);
	}

	/** 展开后常驻，仅再次点击调色板按钮或关闭视图时收起（不响应点击外部）。 */
	private openColorFilterStrip(): void {
		if (!this.colorFilterWrapEl || !this.colorFilterPaletteBtn) return;
		this.colorFilterWrapEl.addClass('is-expanded');
		this.colorFilterPaletteBtn.setAttr('aria-expanded', 'true');
	}

	private closeColorFilterStrip(): void {
		this.colorFilterWrapEl?.removeClass('is-expanded');
		this.colorFilterPaletteBtn?.setAttr('aria-expanded', 'false');
	}

	private toggleColorFilterStrip(): void {
		if (this.colorFilterWrapEl?.hasClass('is-expanded')) this.closeColorFilterStrip();
		else this.openColorFilterStrip();
	}

	private syncColorFilterToolbarActive(): void {
		const sel = new Set(this.plugin.settings.noteListColorFilters);
		for (const [id, btn] of this.colorFilterBtnById) {
			btn.toggleClass('is-active', sel.has(id));
		}
		this.syncColorFilterPaletteAria();
	}

	/** 切换某色是否参与筛选；均未选中时显示全部便笺。 */
	private async toggleListColorFilter(color: StickyColorId): Promise<void> {
		const arr = [...this.plugin.settings.noteListColorFilters];
		const i = arr.indexOf(color);
		if (i >= 0) arr.splice(i, 1);
		else arr.push(color);
		this.plugin.settings.noteListColorFilters = arr;
		await this.plugin.saveSettings();
		this.syncColorFilterToolbarActive();
		this.listPageIndex = 0;
		void this.renderList();
	}

	private async renderCardPreview(previewEl: HTMLElement, f: TFile): Promise<void> {
		previewEl.empty();
		const md = listPreviewEmbedMarkdown(f);
		const host = this.ensureMarkdownHostForPath(f.path);
		await MarkdownRenderer.render(this.app, md, previewEl, f.path, host);
	}

	private updateListCardChrome(
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

	private async createListCardElement(
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
			cls: 'csn-list-card',
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
		headLeft.createDiv({
			cls: 'csn-list-card-title',
			text: f.basename,
			attr: {
				draggable: 'true',
				'aria-label': t('LIST_CARD_TITLE_DRAG_ARIA'),
				title: t('LIST_CARD_TITLE_DRAG_TITLE')
			}
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
		const previewEl = card.querySelector(
			'.csn-list-card-body.csn-list-card-body--rendered'
		) as HTMLElement | null;
		if (!previewEl) return;
		await this.renderCardPreview(previewEl, f);
		card.dataset.csnEmbedMtime = next;
	}

	private async renderListCardsFull(
		container: HTMLElement,
		pageFiles: TFile[],
		sortMode: NoteListSort,
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		for (const f of pageFiles) {
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			const card = await this.createListCardElement(f, color, pinnedSet, archived);
			container.appendChild(card);
		}
	}

	private async syncListPageIncremental(
		container: HTMLElement,
		pageFiles: TFile[],
		sortMode: NoteListSort,
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		const wantedPaths = new Set(pageFiles.map(x => x.path));
		const pool = new Map<string, HTMLElement>();
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (!p) continue;
			if (!wantedPaths.has(p)) {
				this.disposeMarkdownHostForPath(p);
				el.remove();
			} else {
				pool.set(p, el);
				el.remove();
			}
		}
		for (const f of pageFiles) {
			let card = pool.get(f.path);
			pool.delete(f.path);
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			if (!card) {
				card = await this.createListCardElement(f, color, pinnedSet, archived);
			} else {
				this.updateListCardChrome(card, f, color, pinnedSet, archived);
				await this.maybeRefreshCardPreview(card, f);
			}
			container.appendChild(card);
		}
		for (const [p, el] of pool) {
			this.disposeMarkdownHostForPath(p);
			el.remove();
		}
	}

	private async syncListPageContentOnly(
		container: HTMLElement,
		pageFiles: TFile[],
		sortMode: NoteListSort,
		pinnedSet: ReadonlySet<string>
	): Promise<void> {
		const byPath = new Map<string, HTMLElement>();
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement) || !el.hasClass('csn-list-card')) continue;
			const p = el.dataset.csnNotePath;
			if (p) byPath.set(p, el);
		}
		if (byPath.size !== pageFiles.length) {
			this.disposeAllListCardMarkdownHosts();
			container.empty();
			await this.renderListCardsFull(container, pageFiles, sortMode, pinnedSet);
			return;
		}
		for (const f of pageFiles) {
			const card = byPath.get(f.path);
			if (!card) {
				this.disposeAllListCardMarkdownHosts();
				container.empty();
				await this.renderListCardsFull(container, pageFiles, sortMode, pinnedSet);
				return;
			}
			const color = await resolveStickyBgColorForFile(this.app, f);
			const archived = await resolveStickyArchivedForFile(this.app, f);
			this.updateListCardChrome(card, f, color, pinnedSet, archived);
			await this.maybeRefreshCardPreview(card, f);
		}
	}

	async renderList(): Promise<void> {
		const run = this.listRenderChain
			.catch(() => undefined)
			.then(() => this.renderListImpl());
		this.listRenderChain = run;
		await run;
	}

	private async renderListImpl(): Promise<void> {
		const container = this.listItemsEl;
		if (!container || !this.paginationEl || !this.paginationMetaEl) return;

		const query = (this.searchInput?.value ?? '').trim();

		try {
			const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
			const folderAbs = this.app.vault.getAbstractFileByPath(folder);
			if (!folderAbs) {
				this.disposeAllListCardMarkdownHosts();
				this.lastListStructureKey = '';
				this.lastRenderedPageIndex = null;
				container.empty();
				container.createDiv({ text: `文件夹不存在：${folder}`, cls: 'csn-list-empty' });
				this.paginationPagesEl?.empty();
				this.paginationMetaEl?.setText('');
				this.paginationEl.hide();
				this.listToolRegionEl?.hide();
				return;
			}
			if (!(folderAbs instanceof TFolder)) {
				this.disposeAllListCardMarkdownHosts();
				this.lastListStructureKey = '';
				this.lastRenderedPageIndex = null;
				container.empty();
				container.createDiv({ text: `便笺目录不是文件夹：${folder}`, cls: 'csn-list-empty' });
				this.paginationPagesEl?.empty();
				this.paginationMetaEl?.setText('');
				this.paginationEl.hide();
				this.listToolRegionEl?.hide();
				return;
			}

			this.listToolRegionEl?.show();

			const keywords = query
				.split(/\s+/)
				.filter(Boolean)
				.map(k => k.toLowerCase());

			const files = collectMarkdownUnderFolder(folderAbs);
			let filtered =
				keywords.length === 0 ? files : await filterStickyFilesByKeywords(this.app, files, keywords);
			filtered = await filterStickyFilesByColors(this.app, filtered, this.plugin.settings.noteListColorFilters);

			const archiveMode = this.plugin.settings.noteListArchiveFilter;
			filtered = await filterStickyFilesByArchiveFilter(this.app, filtered, archiveMode);

			const floatMode = this.plugin.settings.noteListFloatOpenFilter;
			if (floatMode !== 'all') {
				const rawOpen = this.plugin.stickies.getOpenStickyNotePaths();
				const openNorm = new Set([...rawOpen].map(p => normalizePath(p)));
				if (floatMode === 'open') {
					filtered = filtered.filter(f => openNorm.has(normalizePath(f.path)));
				} else {
					filtered = filtered.filter(f => !openNorm.has(normalizePath(f.path)));
				}
			}

			const wsFilterId = this.plugin.settings.noteListWorkspaceFilterId;
			if (wsFilterId) {
				const allowed = this.plugin.stickies.collectStickyPathsInWorkspaceSnapshotUnion([wsFilterId]);
				filtered = filtered.filter(f => allowed.has(normalizePath(f.path)));
			}

			const pinnedNorm = this.plugin.settings.noteListPinnedPaths.map(p => normalizePath(p));
			const pinnedSet = new Set(pinnedNorm);

			const prio = this.plugin.listPrioritizeStickyPath;
			const sortMode = this.plugin.settings.noteListSort;
			filtered.sort((a, b) => {
				const ra = pinnedSortRank(a.path, pinnedNorm);
				const rb = pinnedSortRank(b.path, pinnedNorm);
				if (ra !== rb) return ra - rb;
				if (prio) {
					if (a.path === prio && b.path !== prio) return -1;
					if (b.path === prio && a.path !== prio) return 1;
				}
				return compareStickyListFiles(a, b, sortMode);
			});

			if (filtered.length === 0) {
				this.disposeAllListCardMarkdownHosts();
				this.lastListStructureKey = '';
				this.lastRenderedPageIndex = null;
				container.empty();
				container.createDiv({ text: t('LIST_EMPTY'), cls: 'csn-list-empty' });
				this.paginationPagesEl?.empty();
				this.paginationMetaEl?.setText('');
				this.paginationEl.hide();
				return;
			}

			const pageSize = Math.max(4, Math.min(48, Math.round(this.plugin.settings.noteListPageSize)));
			const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
			if (this.listPageIndex >= totalPages) this.listPageIndex = totalPages - 1;
			if (this.listPageIndex < 0) this.listPageIndex = 0;

			const start = this.listPageIndex * pageSize;
			const pageFiles = filtered.slice(start, start + pageSize);

			const structureKey = this.buildListStructureKey(
				sortMode,
				query,
				this.plugin.settings.noteListColorFilters,
				floatMode,
				archiveMode,
				pageSize,
				prio,
				filtered,
				pinnedNorm
			);

			const structureChanged = structureKey !== this.lastListStructureKey;
			const paginationOnly =
				!structureChanged &&
				this.lastRenderedPageIndex !== null &&
				this.lastRenderedPageIndex !== this.listPageIndex;
			const samePageContentTouch =
				!structureChanged &&
				this.lastRenderedPageIndex !== null &&
				this.lastRenderedPageIndex === this.listPageIndex;

			if (structureChanged) {
				this.lastListStructureKey = structureKey;
				this.disposeAllListCardMarkdownHosts();
				container.empty();
				await this.renderListCardsFull(container, pageFiles, sortMode, pinnedSet);
			} else if (paginationOnly) {
				await this.syncListPageIncremental(container, pageFiles, sortMode, pinnedSet);
			} else if (samePageContentTouch) {
				await this.syncListPageContentOnly(container, pageFiles, sortMode, pinnedSet);
			} else {
				this.disposeAllListCardMarkdownHosts();
				container.empty();
				await this.renderListCardsFull(container, pageFiles, sortMode, pinnedSet);
			}

			this.lastRenderedPageIndex = this.listPageIndex;

			this.paginationEl?.show();
			this.paginationMetaEl?.setText(
				t('LIST_PAGINATION_META', { pageCount: pageFiles.length, totalCount: filtered.length })
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

			container.scrollTop = 0;
		} finally {
			if (this.plugin.listPrioritizeStickyPath) {
				this.plugin.listPrioritizeStickyPath = null;
			}
		}
	}

	async onClose(): Promise<void> {
		this.closeColorFilterStrip();
		this.listToolRegionEl = null;
		this.workspaceFilterDropdownBtn = null;
		this.floatFilterDropdownBtn = null;
		this.archiveFilterDropdownBtn = null;
		this.sortDropdownBtn = null;
		this.colorFilterWrapEl = null;
		this.colorFilterPaletteBtn = null;
		this.listBulkEditBtn = null;
		this.listCardOverflowClipBtn = null;
		this.cancelListRefreshDebouncers();
		this.debouncedListStructureRefresh = null;
		this.debouncedListContentRefresh = null;
		this.disposeAllListCardMarkdownHosts();
		this.listItemsDelegatedEvents = false;
		this.lastListStructureKey = '';
		this.lastRenderedPageIndex = null;
		this.listItemsEl = null;
		this.searchInput = null;
		this.searchInnerEl = null;
		this.searchClearBtn = null;
		this.paginationEl = null;
		this.paginationRowEl = null;
		this.paginationPagesEl = null;
		this.paginationPrevBtn = null;
		this.paginationNextBtn = null;
		this.paginationMetaEl = null;
		this.colorFilterBtnById.clear();
		this.contentEl.empty();
	}
}
