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
	moment,
	normalizePath,
	setIcon,
	type App,
	type Debouncer
} from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { clampViewContentZoom } from '../settings';
import { VIEW_STICKY_NOTE_LIST, type NoteListSort } from '../types';
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
	private readonly colorFilterBtnById = new Map<StickyColorId, HTMLButtonElement>();
	private colorFilterBarEl: HTMLElement | null = null;
	private searchInput: HTMLInputElement | null = null;
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

	/** 根据当前已打开的浮动便笺，更新卡片右下角卷角类名（不重渲嵌入）。 */
	syncOpenStickyCornerIndicators(): void {
		if (!this.listItemsEl) return;
		const open = this.plugin.stickies.getOpenStickyNotePaths();
		for (const el of Array.from(this.listItemsEl.querySelectorAll('.csn-list-card'))) {
			if (!(el instanceof HTMLElement)) continue;
			const p = el.dataset.csnNotePath;
			if (!p) continue;
			el.toggleClass('csn-list-card--sticky-open', open.has(p));
		}
	}

	private syncCardStickyOpenFlag(
		card: HTMLElement,
		path: string,
		openStickyPaths: ReadonlySet<string>
	): void {
		card.toggleClass('csn-list-card--sticky-open', openStickyPaths.has(path));
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
		pageSize: number,
		prioPath: string | null,
		filtered: TFile[]
	): string {
		return JSON.stringify({
			sort: sortMode,
			query,
			colors: [...colorFilters].sort(),
			pageSize,
			prio: prioPath ?? '',
			paths: filtered.map(f => f.path)
		});
	}

	private registerListItemsDelegatedEvents(): void {
		if (this.listItemsDelegatedEvents || !this.listItemsEl) return;
		this.listItemsDelegatedEvents = true;

		this.registerDomEvent(this.listItemsEl, 'click', (evt: MouseEvent) => {
			const t = evt.target;
			if (!(t instanceof Element)) return;
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
			menu.addItem(item => {
				item.setTitle('打开便笺窗口')
					.setIcon('square-pen')
					.onClick(() => {
						void this.plugin.openStickyForFile(f);
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
			if (t.closest('.csn-list-card-menu-btn')) return;
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

		const searchWrap = root.createDiv({ cls: 'csn-list-search' });
		this.searchInput = searchWrap.createEl('input', {
			type: 'search',
			cls: 'csn-list-search-input',
			attr: { placeholder: '搜索标题、路径与正文（空格分隔，需同时包含）' }
		});

		const toolbar = root.createDiv({ cls: 'csn-list-toolbar' });
		const sortLabel = toolbar.createSpan({ cls: 'csn-list-toolbar-label', text: '排序' });
		sortLabel.setAttr('aria-hidden', 'true');
		const sortWrap = toolbar.createDiv({ cls: 'csn-list-toolbar-btns' });
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

		const colorBar = toolbar.createDiv({ cls: 'csn-list-toolbar-color-filter' });
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

		this.registerDomEvent(this.searchInput, 'input', render);
		this.registerVaultListRefresh();
		this.syncSortToolbarActive();
		this.syncColorFilterToolbarActive();
		void this.renderList();
	}

	private syncSortToolbarActive(): void {
		const mode = this.plugin.settings.noteListSort;
		for (const [m, btn] of this.sortBtnByMode) {
			btn.toggleClass('is-active', m === mode);
		}
	}

	private async setListSort(sort: NoteListSort): Promise<void> {
		if (this.plugin.settings.noteListSort === sort) return;
		this.plugin.settings.noteListSort = sort;
		await this.plugin.saveSettings();
		this.syncSortToolbarActive();
		this.listPageIndex = 0;
		void this.renderList();
	}

	private syncColorFilterToolbarActive(): void {
		const sel = new Set(this.plugin.settings.noteListColorFilters);
		for (const [id, btn] of this.colorFilterBtnById) {
			btn.toggleClass('is-active', sel.has(id));
		}
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
		sortMode: NoteListSort,
		color: StickyColorId,
		openStickyPaths: ReadonlySet<string>
	): void {
		card.setAttr('data-csn-note-path', f.path);
		card.setAttr('data-csn-list-color', color);
		const zoom = clampViewContentZoom(this.plugin.settings.noteListViewContentZoom);
		card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
		const listDateTs = sortMode.startsWith('ctime') ? f.stat.ctime : f.stat.mtime;
		const titleEl = card.querySelector('.csn-list-card-title');
		if (titleEl) titleEl.setText(f.basename);
		const dateEl = card.querySelector('.csn-list-card-date');
		if (dateEl) dateEl.setText(moment(listDateTs).format('M月D日'));
		this.syncCardStickyOpenFlag(card, f.path, openStickyPaths);
	}

	private async createListCardElement(
		f: TFile,
		sortMode: NoteListSort,
		color: StickyColorId,
		openStickyPaths: ReadonlySet<string>
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
		const listDateTs = sortMode.startsWith('ctime') ? f.stat.ctime : f.stat.mtime;
		const head = card.createDiv({ cls: 'csn-list-card-head' });
		head.createDiv({ cls: 'csn-list-card-title', text: f.basename });
		const headRight = head.createDiv({ cls: 'csn-list-card-head-right' });
		headRight.createDiv({
			cls: 'csn-list-card-date',
			text: moment(listDateTs).format('M月D日')
		});
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
		this.syncCardStickyOpenFlag(card, f.path, openStickyPaths);
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
		openStickyPaths: ReadonlySet<string>
	): Promise<void> {
		for (const f of pageFiles) {
			const color: StickyColorId = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
			const card = await this.createListCardElement(f, sortMode, color, openStickyPaths);
			container.appendChild(card);
		}
	}

	private async syncListPageIncremental(
		container: HTMLElement,
		pageFiles: TFile[],
		sortMode: NoteListSort,
		openStickyPaths: ReadonlySet<string>
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
				card = await this.createListCardElement(f, sortMode, color, openStickyPaths);
			} else {
				this.updateListCardChrome(card, f, sortMode, color, openStickyPaths);
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
		openStickyPaths: ReadonlySet<string>
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
			await this.renderListCardsFull(container, pageFiles, sortMode, openStickyPaths);
			return;
		}
		for (const f of pageFiles) {
			const card = byPath.get(f.path);
			if (!card) {
				this.disposeAllListCardMarkdownHosts();
				container.empty();
				await this.renderListCardsFull(container, pageFiles, sortMode, openStickyPaths);
				return;
			}
			const color: StickyColorId = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
			this.updateListCardChrome(card, f, sortMode, color, openStickyPaths);
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
				return;
			}

			this.colorFilterBarEl?.show();

			const keywords = query
				.split(/\s+/)
				.filter(Boolean)
				.map(k => k.toLowerCase());

			const files = collectMarkdownUnderFolder(folderAbs);
			let filtered =
				keywords.length === 0 ? files : await filterStickyFilesByKeywords(this.app, files, keywords);
			filtered = await filterStickyFilesByColors(this.app, filtered, this.plugin.settings.noteListColorFilters);

			const prio = this.plugin.listPrioritizeStickyPath;
			const sortMode = this.plugin.settings.noteListSort;
			filtered.sort((a, b) => {
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
			const openStickyPaths = this.plugin.stickies.getOpenStickyNotePaths();

			const structureKey = this.buildListStructureKey(
				sortMode,
				query,
				this.plugin.settings.noteListColorFilters,
				pageSize,
				prio,
				filtered
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
				await this.renderListCardsFull(container, pageFiles, sortMode, openStickyPaths);
			} else if (paginationOnly) {
				await this.syncListPageIncremental(container, pageFiles, sortMode, openStickyPaths);
			} else if (samePageContentTouch) {
				await this.syncListPageContentOnly(container, pageFiles, sortMode, openStickyPaths);
			} else {
				this.disposeAllListCardMarkdownHosts();
				container.empty();
				await this.renderListCardsFull(container, pageFiles, sortMode, openStickyPaths);
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
		this.cancelListRefreshDebouncers();
		this.debouncedListStructureRefresh = null;
		this.debouncedListContentRefresh = null;
		this.disposeAllListCardMarkdownHosts();
		this.listItemsDelegatedEvents = false;
		this.lastListStructureKey = '';
		this.lastRenderedPageIndex = null;
		this.listItemsEl = null;
		this.searchInput = null;
		this.paginationEl = null;
		this.paginationRowEl = null;
		this.paginationPagesEl = null;
		this.paginationPrevBtn = null;
		this.paginationNextBtn = null;
		this.paginationMetaEl = null;
		this.colorFilterBarEl = null;
		this.colorFilterBtnById.clear();
		this.contentEl.empty();
	}
}
