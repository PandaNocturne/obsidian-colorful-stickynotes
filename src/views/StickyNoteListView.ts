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
import { clampViewContentZoom } from '../settings';
import { VIEW_STICKY_NOTE_LIST, type NoteListFloatOpenFilter, type NoteListSort } from '../types';
import '../obsidian-augmentations';
import { resolveStickyBgColorForFile } from '../utils/sticky-bg-from-file';
import { SHEET_COLOR_ORDER } from '../sticky/sticky-color-order';
import type { StickyColorId } from '../types';

/** 列表卡片预览：维基嵌入语法，由 Obsidian 按阅读视图嵌入管线渲染整篇便笺。 */
function listPreviewEmbedMarkdown(file: TFile): string {
	const pathNoExt = file.path.replace(/\.md$/i, '');
	return `![[${pathNoExt}]]\n`;
}

/** 工具栏排序按钮：与 `settings.noteListSort` 一一对应。 */
const NOTE_LIST_SORT_SPECS: readonly { mode: NoteListSort; icon: string; title: string }[] = [
	{ mode: 'ctime-desc', icon: 'calendar-arrow-down', title: '创建时间 · 新的在前' },
	{ mode: 'ctime-asc', icon: 'calendar-arrow-up', title: '创建时间 · 旧的在先' },
	{ mode: 'mtime-desc', icon: 'clock-arrow-down', title: '修改时间 · 新的在前' },
	{ mode: 'mtime-asc', icon: 'clock-arrow-up', title: '修改时间 · 旧的在先' }
];

/** 工具栏「浮动窗口」筛选：与 `settings.noteListFloatOpenFilter` 一一对应。 */
const NOTE_LIST_FLOAT_OPEN_SPECS: readonly { mode: NoteListFloatOpenFilter; icon: string; title: string }[] = [
	{ mode: 'all', icon: 'layout-grid', title: '全部便笺' },
	{ mode: 'open', icon: 'square-pen', title: '仅已打开浮动便笺' },
	{ mode: 'closed', icon: 'file', title: '仅未打开浮动便笺' }
];

/** 侧栏较窄时，小于此宽度则切换为「窗口 / 排序 / 颜色」图标按钮 + 菜单 / 浮层。 */
const TOOLBAR_COMPACT_MAX_WIDTH_PX = 600;

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

export class StickyNoteListView extends ItemView {
	private listItemsEl: HTMLElement | null = null;
	private readonly sortBtnByMode = new Map<NoteListSort, HTMLButtonElement>();
	private readonly floatOpenBtnByMode = new Map<NoteListFloatOpenFilter, HTMLButtonElement>();
	private floatOpenBarEl: HTMLElement | null = null;
	private readonly colorFilterBtnById = new Map<StickyColorId, HTMLButtonElement>();
	private colorFilterBarEl: HTMLElement | null = null;
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
	private toolbarLayoutObserver: ResizeObserver | null = null;
	private compactSortBtn: HTMLButtonElement | null = null;
	private compactFloatBtn: HTMLButtonElement | null = null;
	private compactColorBtn: HTMLButtonElement | null = null;
	/** 紧凑工具栏「颜色」：水平色块浮层（非 Menu，可多选、点选不关）。 */
	private colorPopoverEl: HTMLElement | null = null;
	private colorPopoverOutsidePointerDown: ((e: PointerEvent) => void) | null = null;
	private colorPopoverResizeBound: (() => void) | null = null;

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
		return '便笺列表';
	}

	getIcon(): string {
		return 'layout-grid';
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
		pinBtn.setAttr('aria-label', on ? '取消置顶' : '置顶');
		pinBtn.setAttr('title', on ? '取消置顶' : '置顶到列表最前');
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
		pageSize: number,
		prioPath: string | null,
		filtered: TFile[],
		pinnedPaths: readonly string[]
	): string {
		return JSON.stringify({
			sort: sortMode,
			query,
			colors: [...colorFilters].sort(),
			floatOpen,
			pageSize,
			prio: prioPath ?? '',
			paths: filtered.map(f => f.path),
			pinned: [...pinnedPaths]
		});
	}

	private registerListItemsDelegatedEvents(): void {
		if (this.listItemsDelegatedEvents || !this.listItemsEl) return;
		this.listItemsDelegatedEvents = true;

		this.registerDomEvent(this.listItemsEl, 'click', (evt: MouseEvent) => {
			const t = evt.target;
			if (!(t instanceof Element)) return;
			const pinBtn = t.closest('.csn-list-card-pin-btn');
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
			const btn = t.closest('.csn-list-card-menu-btn');
			if (!btn || !this.listItemsEl?.contains(btn)) return;
			const card = btn.closest('.csn-list-card');
			if (!card) return;
			const path = (card as HTMLElement).dataset.csnNotePath;
			if (!path) return;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			const color =
				((card as HTMLElement).dataset.csnListColor as StickyColorId | undefined) ?? 'default';
			const menu = new Menu();
			menu.addItem(item => {
				item.setTitle('打开笔记')
					.setIcon('file-text')
					.onClick(() => {
						void this.app.workspace.getLeaf('tab').openFile(f);
					});
			});
			menu.addSeparator();
			menu.addItem(item => {
				item.setTitle('修改背景').setIcon('palette');
				const sub = item.setSubmenu();
				for (const c of SHEET_COLOR_ORDER) {
					const selected = c.id === color;
					sub.addItem(si => {
						si.setTitle(buildStickyBgSubmenuTitle(document, c.id, c.label, selected));
						si.setIcon(null);
						si.onClick(() => {
							void this.plugin.stickies.setStickyBackgroundColorForFile(f, c.id).then(() => {
								(card as HTMLElement).setAttr('data-csn-list-color', c.id);
							});
						});
					});
				}
			});
			menu.addSeparator();
			menu.addItem(item => {
				item.setTitle('删除笔记')
					.setIcon('trash-2')
					.onClick(() => {
						void this.plugin.stickies.trashStickyNoteFile(f);
					});
			});
			menu.showAtMouseEvent(evt);
		});

		this.registerDomEvent(this.listItemsEl, 'dblclick', (evt: MouseEvent) => {
			const t = evt.target;
			if (!(t instanceof Element)) return;
			if (t.closest('.csn-list-card-pin-btn') || t.closest('.csn-list-card-menu-btn')) return;
			const card = t.closest('.csn-list-card');
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

		const chrome = root.createDiv({ cls: 'csn-list-chrome' });
		const searchWrap = chrome.createDiv({ cls: 'csn-list-search' });
		const searchInner = searchWrap.createDiv({ cls: 'csn-list-search-inner' });
		this.searchInnerEl = searchInner;
		this.searchInput = searchInner.createEl('input', {
			type: 'text',
			cls: 'csn-list-search-input',
			attr: {
				placeholder: '搜索标题、路径与正文（空格分隔，需同时包含）',
				spellcheck: 'false',
				'aria-label': '搜索便笺',
				role: 'searchbox',
				autocomplete: 'off'
			}
		});
		this.searchClearBtn = searchInner.createEl('button', {
			type: 'button',
			cls: 'csn-list-search-clear csn-list-search-clear--hidden',
			attr: { 'aria-label': '清除搜索', title: '清除' }
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

		const toolbar = chrome.createDiv({ cls: 'csn-list-toolbar' });
		const toolbarMain = toolbar.createDiv({ cls: 'csn-list-toolbar-main' });

		const expanded = toolbarMain.createDiv({ cls: 'csn-list-toolbar-expanded' });
		const floatBar = expanded.createDiv({ cls: 'csn-list-toolbar-float-open' });
		this.floatOpenBarEl = floatBar;
		const floatLabel = floatBar.createSpan({ cls: 'csn-list-toolbar-label', text: '窗口' });
		floatLabel.setAttr('aria-hidden', 'true');
		const floatWrap = floatBar.createDiv({ cls: 'csn-list-toolbar-btns' });
		this.floatOpenBtnByMode.clear();
		for (const spec of NOTE_LIST_FLOAT_OPEN_SPECS) {
			const btn = floatWrap.createEl('button', {
				type: 'button',
				cls: 'clickable-icon csn-list-sort-btn',
				attr: { 'aria-label': spec.title, title: spec.title, 'data-csn-list-float': spec.mode }
			});
			setIcon(btn, spec.icon);
			this.floatOpenBtnByMode.set(spec.mode, btn);
			this.registerDomEvent(btn, 'click', () => {
				void this.setListFloatOpenFilter(spec.mode);
			});
		}

		expanded.createDiv({
			cls: 'csn-list-toolbar-divider',
			attr: { 'aria-hidden': 'true' }
		});

		const sortModule = expanded.createDiv({ cls: 'csn-list-toolbar-module' });
		const sortLabel = sortModule.createSpan({ cls: 'csn-list-toolbar-label', text: '排序' });
		sortLabel.setAttr('aria-hidden', 'true');
		const sortWrap = sortModule.createDiv({ cls: 'csn-list-toolbar-btns' });
		this.sortBtnByMode.clear();
		for (const spec of NOTE_LIST_SORT_SPECS) {
			const btn = sortWrap.createEl('button', {
				type: 'button',
				cls: 'clickable-icon csn-list-sort-btn',
				attr: { 'aria-label': spec.title, title: spec.title }
			});
			setIcon(btn, spec.icon);
			this.sortBtnByMode.set(spec.mode, btn);
			this.registerDomEvent(btn, 'click', () => {
				void this.setListSort(spec.mode);
			});
		}

		expanded.createDiv({
			cls: 'csn-list-toolbar-divider',
			attr: { 'aria-hidden': 'true' }
		});

		const colorBar = expanded.createDiv({ cls: 'csn-list-toolbar-color-filter' });
		this.colorFilterBarEl = colorBar;
		const colorLabel = colorBar.createSpan({ cls: 'csn-list-toolbar-label', text: '颜色' });
		colorLabel.setAttr('aria-hidden', 'true');
		const colorBtns = colorBar.createDiv({ cls: 'csn-list-color-filter-btns' });
		this.colorFilterBtnById.clear();

		for (const c of SHEET_COLOR_ORDER) {
			const sw = colorBtns.createEl('button', {
				type: 'button',
				cls: 'clickable-icon csn-list-color-filter-btn csn-list-color-filter-swatch',
				attr: {
					'aria-label': `${c.label}，点击加入或移出筛选；未选任何色时显示全部`,
					title: `${c.label}（多选）`,
					'data-csn-list-color': c.id
				}
			});
			this.colorFilterBtnById.set(c.id, sw);
			this.registerDomEvent(sw, 'click', () => {
				void this.toggleListColorFilter(c.id);
			});
		}

		const compact = toolbarMain.createDiv({ cls: 'csn-list-toolbar-compact' });
		this.compactFloatBtn = compact.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-chip',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.compactSortBtn = compact.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-chip',
			attr: { 'aria-haspopup': 'menu' }
		});
		this.compactColorBtn = compact.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-toolbar-chip',
			attr: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }
		});
		this.registerDomEvent(this.compactFloatBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openCompactFloatMenu(evt);
		});
		this.registerDomEvent(this.compactSortBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.openCompactSortMenu(evt);
		});
		this.registerDomEvent(this.compactColorBtn, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleCompactColorPopover();
		});

		this.installToolbarLayoutObserver();
		this.register(() => {
			this.closeCompactColorPopover();
		});

		toolbar.createDiv({ cls: 'csn-list-toolbar-spacer' });
		const newStickyBtn = toolbar.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-new-btn',
			attr: { 'aria-label': '新建便笺', title: '新建便笺' }
		});
		setIcon(newStickyBtn, 'plus');
		this.registerDomEvent(newStickyBtn, 'click', () => {
			void this.plugin.stickies.addStickyWindow();
		});

		const refreshBtn = toolbar.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-refresh-btn',
			attr: { 'aria-label': '刷新', title: '立即刷新列表与嵌入预览' }
		});
		setIcon(refreshBtn, 'refresh-ccw');
		this.registerDomEvent(refreshBtn, 'click', () => {
			this.cancelListRefreshDebouncers();
			this.lastListStructureKey = '';
			this.lastRenderedPageIndex = null;
			void this.renderList();
		});

		this.listItemsEl = root.createDiv({ cls: 'csn-list-items' });
		this.registerListItemsDelegatedEvents();
		this.syncListGridMetricsFromSettings();

		this.paginationEl = root.createDiv({ cls: 'csn-list-pagination' });
		this.paginationRowEl = this.paginationEl.createDiv({ cls: 'csn-list-pagination-row' });
		this.paginationPrevBtn = this.paginationRowEl.createEl('button', {
			type: 'button',
			text: '上一页',
			cls: 'csn-list-pagination-btn csn-list-pagination-btn--nav'
		});
		this.paginationPagesEl = this.paginationRowEl.createDiv({ cls: 'csn-list-pagination-pages' });
		this.paginationNextBtn = this.paginationRowEl.createEl('button', {
			type: 'button',
			text: '下一页',
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
			const t = evt.target;
			if (!(t instanceof Element)) return;
			const btn = t.closest('button[data-csn-list-page]');
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
		this.syncSortToolbarActive();
		this.syncFloatOpenToolbarActive();
		this.syncColorFilterToolbarActive();
		this.syncToolbarCompactHints();
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

	private installToolbarLayoutObserver(): void {
		this.toolbarLayoutObserver?.disconnect();
		const ro = new ResizeObserver(entries => {
			const w = entries[0]?.contentRect.width ?? this.contentEl.clientWidth;
			this.applyToolbarCompactForWidth(w);
		});
		this.toolbarLayoutObserver = ro;
		ro.observe(this.contentEl);
		this.register(() => {
			ro.disconnect();
			this.toolbarLayoutObserver = null;
		});
		this.applyToolbarCompactForWidth(this.contentEl.clientWidth);
	}

	private applyToolbarCompactForWidth(width: number): void {
		const compact = width > 0 && width < TOOLBAR_COMPACT_MAX_WIDTH_PX;
		this.contentEl.toggleClass('csn-list-view--toolbar-compact', compact);
	}

	/** 窄工具栏：图标与 title / aria-label 随当前设置更新。 */
	private syncToolbarCompactHints(): void {
		const sortSpec =
			NOTE_LIST_SORT_SPECS.find(s => s.mode === this.plugin.settings.noteListSort) ??
			NOTE_LIST_SORT_SPECS[0]!;
		if (this.compactSortBtn) {
			setIcon(this.compactSortBtn, sortSpec.icon);
			this.compactSortBtn.setAttr('title', sortSpec.title);
			this.compactSortBtn.setAttr('aria-label', `排序：${sortSpec.title}`);
		}

		const floatSpec =
			NOTE_LIST_FLOAT_OPEN_SPECS.find(
				s => s.mode === this.plugin.settings.noteListFloatOpenFilter
			) ?? NOTE_LIST_FLOAT_OPEN_SPECS[0]!;
		if (this.compactFloatBtn) {
			setIcon(this.compactFloatBtn, floatSpec.icon);
			this.compactFloatBtn.setAttr('title', floatSpec.title);
			this.compactFloatBtn.setAttr('aria-label', `窗口：${floatSpec.title}`);
		}

		const n = this.plugin.settings.noteListColorFilters.length;
		if (this.compactColorBtn) {
			setIcon(this.compactColorBtn, 'palette');
			const title =
				n === 0 ? '颜色筛选（未选则显示全部）' : `颜色筛选：已选 ${n} 种（多选）`;
			this.compactColorBtn.setAttr('title', title);
			this.compactColorBtn.setAttr('aria-label', title);
		}
	}

	private openCompactSortMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const cur = this.plugin.settings.noteListSort;
		for (const spec of NOTE_LIST_SORT_SPECS) {
			menu.addItem(item => {
				item
					.setTitle(spec.title)
					.setIcon(spec.icon)
					.setChecked(spec.mode === cur)
					.onClick(() => {
						void this.setListSort(spec.mode);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private openCompactFloatMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const cur = this.plugin.settings.noteListFloatOpenFilter;
		for (const spec of NOTE_LIST_FLOAT_OPEN_SPECS) {
			menu.addItem(item => {
				item
					.setTitle(spec.title)
					.setIcon(spec.icon)
					.setChecked(spec.mode === cur)
					.onClick(() => {
						void this.setListFloatOpenFilter(spec.mode);
					});
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private toggleCompactColorPopover(): void {
		if (this.colorPopoverEl) {
			this.closeCompactColorPopover();
			return;
		}
		this.openCompactColorPopover();
	}

	private openCompactColorPopover(): void {
		if (!this.compactColorBtn) return;
		this.closeCompactColorPopover();

		const root = document.body.createDiv({ cls: 'csn-list-color-popover' });
		this.colorPopoverEl = root;
		const row = root.createDiv({ cls: 'csn-list-color-popover-row' });
		row.setAttr('role', 'group');
		row.setAttr('aria-label', '颜色筛选，可多选');

		const sel = new Set(this.plugin.settings.noteListColorFilters);
		for (const c of SHEET_COLOR_ORDER) {
			const sw = row.createEl('button', {
				type: 'button',
				cls: 'csn-list-color-popover-swatch',
				attr: {
					'data-csn-list-color': c.id,
					'aria-label': c.label,
					'aria-pressed': sel.has(c.id) ? 'true' : 'false'
				}
			});
			if (sel.has(c.id)) sw.addClass('is-active');
			this.registerDomEvent(sw, 'click', (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				void this.toggleListColorFilter(c.id);
			});
		}

		this.compactColorBtn.setAttr('aria-expanded', 'true');
		this.positionCompactColorPopover();

		const onResize = (): void => {
			this.positionCompactColorPopover();
		};
		this.colorPopoverResizeBound = onResize;
		window.addEventListener('resize', onResize);

		const onOutside = (e: PointerEvent) => {
			const t = e.target;
			if (!(t instanceof Node)) return;
			if (this.colorPopoverEl?.contains(t)) return;
			if (this.compactColorBtn?.contains(t)) return;
			this.closeCompactColorPopover();
		};
		this.colorPopoverOutsidePointerDown = onOutside;
		/* capture：先于子控件，避免与浮层内点击竞态 */
		window.addEventListener('pointerdown', onOutside, true);
	}

	private positionCompactColorPopover(): void {
		const pop = this.colorPopoverEl;
		const anchor = this.compactColorBtn;
		if (!pop || !anchor) return;
		const r = anchor.getBoundingClientRect();
		const margin = 6;
		pop.style.setProperty('position', 'fixed');
		pop.style.setProperty('z-index', 'var(--layer-popover, 65)');
		let top = r.bottom + margin;
		let left = r.left;
		pop.style.setProperty('visibility', 'hidden');
		pop.style.setProperty('top', `${top}px`);
		pop.style.setProperty('left', `${left}px`);
		const pr = pop.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (left + pr.width > vw - 8) left = Math.max(8, vw - pr.width - 8);
		if (top + pr.height > vh - 8) top = Math.max(8, r.top - pr.height - margin);
		pop.style.setProperty('top', `${top}px`);
		pop.style.setProperty('left', `${left}px`);
		pop.style.removeProperty('visibility');
	}

	private closeCompactColorPopover(): void {
		if (this.colorPopoverResizeBound) {
			window.removeEventListener('resize', this.colorPopoverResizeBound);
			this.colorPopoverResizeBound = null;
		}
		if (this.colorPopoverOutsidePointerDown) {
			window.removeEventListener('pointerdown', this.colorPopoverOutsidePointerDown, true);
			this.colorPopoverOutsidePointerDown = null;
		}
		this.compactColorBtn?.setAttr('aria-expanded', 'false');
		this.colorPopoverEl?.remove();
		this.colorPopoverEl = null;
	}

	private syncColorPopoverSelection(): void {
		const pop = this.colorPopoverEl;
		if (!pop) return;
		const sel = new Set(this.plugin.settings.noteListColorFilters);
		const nodes = pop.querySelectorAll<HTMLButtonElement>('.csn-list-color-popover-swatch');
		for (let i = 0; i < nodes.length; i++) {
			const btn = nodes.item(i);
			const id = btn.dataset.csnListColor as StickyColorId | undefined;
			if (!id) continue;
			const on = sel.has(id);
			btn.toggleClass('is-active', on);
			btn.setAttr('aria-pressed', on ? 'true' : 'false');
		}
	}

	private syncSortToolbarActive(): void {
		const mode = this.plugin.settings.noteListSort;
		for (const [m, btn] of this.sortBtnByMode) {
			btn.toggleClass('is-active', m === mode);
		}
		this.syncToolbarCompactHints();
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
		const mode = this.plugin.settings.noteListFloatOpenFilter;
		for (const [m, btn] of this.floatOpenBtnByMode) {
			btn.toggleClass('is-active', m === mode);
		}
		this.syncToolbarCompactHints();
	}

	private async setListFloatOpenFilter(mode: NoteListFloatOpenFilter): Promise<void> {
		if (this.plugin.settings.noteListFloatOpenFilter === mode) return;
		this.plugin.settings.noteListFloatOpenFilter = mode;
		await this.plugin.saveSettings();
		this.syncFloatOpenToolbarActive();
		this.listPageIndex = 0;
		void this.renderList();
	}

	private syncColorFilterToolbarActive(): void {
		const sel = new Set(this.plugin.settings.noteListColorFilters);
		for (const [id, btn] of this.colorFilterBtnById) {
			btn.toggleClass('is-active', sel.has(id));
		}
		this.syncColorPopoverSelection();
		this.syncToolbarCompactHints();
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
		color: StickyColorId,
		pinnedSet: ReadonlySet<string>
	): void {
		card.setAttr('data-csn-note-path', f.path);
		card.setAttr('data-csn-list-color', color);
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
		const titleEl = card.querySelector('.csn-list-card-title');
		if (titleEl) titleEl.setText(f.basename);
		this.syncPinButton(card, f.path, pinnedSet);
	}

	private async createListCardElement(
		f: TFile,
		color: StickyColorId,
		pinnedSet: ReadonlySet<string>
	): Promise<HTMLElement> {
		const card = this.contentEl.createDiv({
			cls: 'csn-list-card',
			attr: {
				'data-csn-note-path': f.path,
				'data-csn-list-color': color,
				title: '双击打开便笺'
			}
		});
		card.remove();
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
		const head = card.createDiv({ cls: 'csn-list-card-head' });
		head.createDiv({ cls: 'csn-list-card-title', text: f.basename });
		const headRight = head.createDiv({ cls: 'csn-list-card-head-right' });
		const isPinned = pinnedSet.has(normalizePath(f.path));
		headRight.createEl(
			'button',
			{
				type: 'button',
				cls: `clickable-icon csn-list-card-pin-btn${isPinned ? ' is-active' : ''}`,
				attr: {
					'aria-label': isPinned ? '取消置顶' : '置顶',
					'aria-pressed': isPinned ? 'true' : 'false',
					title: isPinned ? '取消置顶' : '置顶到列表最前'
				}
			},
			(btn: HTMLButtonElement) => setIcon(btn, 'pin')
		);
		headRight.createEl(
			'button',
			{
				type: 'button',
				cls: 'clickable-icon csn-list-card-menu-btn',
				attr: { 'aria-label': '更多操作', 'aria-haspopup': 'true' }
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
			const color: StickyColorId = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
			const card = await this.createListCardElement(f, color, pinnedSet);
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
			const color: StickyColorId = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
			if (!card) {
				card = await this.createListCardElement(f, color, pinnedSet);
			} else {
				this.updateListCardChrome(card, f, color, pinnedSet);
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
			const color: StickyColorId = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
			this.updateListCardChrome(card, f, color, pinnedSet);
			await this.maybeRefreshCardPreview(card, f);
		}
	}

	private async renderList(): Promise<void> {
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
				this.colorFilterBarEl?.hide();
				this.floatOpenBarEl?.hide();
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
				this.colorFilterBarEl?.hide();
				this.floatOpenBarEl?.hide();
				return;
			}

			this.colorFilterBarEl?.show();
			this.floatOpenBarEl?.show();

			const keywords = query
				.split(/\s+/)
				.filter(Boolean)
				.map(k => k.toLowerCase());

			const files = collectMarkdownUnderFolder(folderAbs);
			let filtered =
				keywords.length === 0 ? files : await filterStickyFilesByKeywords(this.app, files, keywords);
			filtered = await filterStickyFilesByColors(this.app, filtered, this.plugin.settings.noteListColorFilters);

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
				container.createDiv({ text: '没有匹配的便笺', cls: 'csn-list-empty' });
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
				`本页 ${pageFiles.length} 条 · 共 ${filtered.length} 条`
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
								'aria-label': `第 ${ent} 页`,
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
		this.closeCompactColorPopover();
		this.toolbarLayoutObserver?.disconnect();
		this.toolbarLayoutObserver = null;
		this.compactSortBtn = null;
		this.compactFloatBtn = null;
		this.compactColorBtn = null;
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
		this.colorFilterBarEl = null;
		this.colorFilterBtnById.clear();
		this.floatOpenBarEl = null;
		this.floatOpenBtnByMode.clear();
		this.contentEl.empty();
	}
}
