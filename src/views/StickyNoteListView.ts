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
	type Debouncer
} from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { VIEW_STICKY_NOTE_LIST, type NoteListSort } from '../types';
import { previewMarkdownSlice } from '../utils/preview-markdown-slice';
import '../obsidian-augmentations';
import { resolveStickyBgColorForFile } from '../utils/sticky-bg-from-file';
import { SHEET_COLOR_ORDER } from '../sticky/sticky-color-order';
import type { StickyColorId } from '../types';

const LIST_PAGE_SIZE = 12;
/** 单卡传入渲染器的 Markdown 最大字符数（含换行），避免超大笔记阻塞 UI。 */
const PREVIEW_MARKDOWN_MAX = 8000;

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

export class StickyNoteListView extends ItemView {
	private listItemsEl: HTMLElement | null = null;
	private readonly sortBtnByMode = new Map<NoteListSort, HTMLButtonElement>();
	private searchInput: HTMLInputElement | null = null;
	private paginationEl: HTMLElement | null = null;
	private paginationPrevBtn: HTMLButtonElement | null = null;
	private paginationNextBtn: HTMLButtonElement | null = null;
	private paginationMetaEl: HTMLElement | null = null;
	/** 当前页 Markdown 渲染子组件挂载点，整页替换前 unload。 */
	private listMarkdownHost: Component | null = null;
	private listPageIndex = 0;
	private debouncedListStructureRefresh: Debouncer<[], void> | null = null;
	private debouncedListContentRefresh: Debouncer<[], void> | null = null;
	/** 手动刷新时用 `vault.read` 拉预览，避免缓存未失效时仍显示旧内容。 */
	private previewForceDiskRead = false;

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

	/** 供插件在新建便笺等时机主动刷新，避免仅依赖 vault 事件防抖导致延迟或重复整表渲染 */
	requestRedraw(): void {
		void this.renderList();
	}

	/** 与浮动便笺共用设置里的 `viewContentZoom`，仅更新已渲染卡片上的 CSS 变量，不重渲 Markdown。 */
	syncViewContentZoomFromSettings(): void {
		if (!this.listItemsEl) return;
		const zoom = Math.max(0.5, Math.min(1, this.plugin.settings.viewContentZoom));
		this.listItemsEl.querySelectorAll('.csn-list-card').forEach(card => {
			if (card instanceof HTMLElement) {
				card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));
			}
		});
	}

	/** 从设置写入根节点 CSS 变量（网格列宽、卡片高度）。 */
	syncListGridMetricsFromSettings(): void {
		if (!this.contentEl.hasClass('csn-list-view')) return;
		const h = this.plugin.settings.noteListCardHeight;
		const w = this.plugin.settings.noteListGridMinWidth;
		this.contentEl.style.setProperty('--csn-list-card-height', `${h}px`);
		this.contentEl.style.setProperty('--csn-list-grid-min-width', `${w}px`);
	}

	private disposeListMarkdownHost(): void {
		if (this.listMarkdownHost) {
			this.removeChild(this.listMarkdownHost);
			this.listMarkdownHost = null;
		}
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
				this.listPageIndex = 0;
				void this.renderList();
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
			attr: { placeholder: '搜索（空格分隔多个关键词）' }
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
			attr: { 'aria-label': '刷新', title: '立即刷新列表与预览（从磁盘读取正文）' }
		});
		setIcon(refreshBtn, 'refresh-ccw');
		this.registerDomEvent(refreshBtn, 'click', () => {
			this.cancelListRefreshDebouncers();
			this.previewForceDiskRead = true;
			void this.renderList();
		});

		this.listItemsEl = root.createDiv({ cls: 'csn-list-items' });
		this.syncListGridMetricsFromSettings();

		this.paginationEl = root.createDiv({ cls: 'csn-list-pagination' });
		this.paginationPrevBtn = this.paginationEl.createEl('button', {
			type: 'button',
			text: '上一页',
			cls: 'csn-list-pagination-btn'
		});
		this.paginationMetaEl = this.paginationEl.createSpan({ cls: 'csn-list-pagination-meta' });
		this.paginationNextBtn = this.paginationEl.createEl('button', {
			type: 'button',
			text: '下一页',
			cls: 'csn-list-pagination-btn'
		});
		this.registerDomEvent(this.paginationPrevBtn, 'click', () => {
			if (this.listPageIndex <= 0) return;
			this.listPageIndex -= 1;
			void this.renderList();
		});
		this.registerDomEvent(this.paginationNextBtn, 'click', () => {
			this.listPageIndex += 1;
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

	private async renderList(): Promise<void> {
		const container = this.listItemsEl;
		if (!container || !this.paginationEl || !this.paginationMetaEl) return;

		const query = (this.searchInput?.value ?? '').trim();
		const forceDisk = this.previewForceDiskRead;

		try {
			this.disposeListMarkdownHost();
			container.empty();

			const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
			const folderAbs = this.app.vault.getAbstractFileByPath(folder);
			if (!folderAbs) {
				container.createDiv({ text: `文件夹不存在：${folder}`, cls: 'csn-list-empty' });
				this.paginationEl.hide();
				return;
			}
			if (!(folderAbs instanceof TFolder)) {
				container.createDiv({ text: `便笺目录不是文件夹：${folder}`, cls: 'csn-list-empty' });
				this.paginationEl.hide();
				return;
			}

			const keywords = query
				.split(/\s+/)
				.filter(Boolean)
				.map(k => k.toLowerCase());

			const files = collectMarkdownUnderFolder(folderAbs);
			const filtered =
				keywords.length === 0
					? files
					: files.filter(f => {
						const hay = (f.basename + '\n' + f.path).toLowerCase();
						return keywords.every(k => hay.includes(k));
					});

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
				container.createDiv({ text: '没有匹配的便笺', cls: 'csn-list-empty' });
				this.paginationEl.hide();
				return;
			}

			this.paginationEl.show();

			const totalPages = Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE));
			if (this.listPageIndex >= totalPages) this.listPageIndex = totalPages - 1;
			if (this.listPageIndex < 0) this.listPageIndex = 0;

			const start = this.listPageIndex * LIST_PAGE_SIZE;
			const pageFiles = filtered.slice(start, start + LIST_PAGE_SIZE);

			const mdHost = new Component();
			this.listMarkdownHost = mdHost;
			this.addChild(mdHost);

			await Promise.all(
				pageFiles.map(async f => {
					const color: StickyColorId = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
					const card = container.createDiv({
						cls: 'csn-list-card',
						attr: { 'data-csn-list-color': color, title: '双击打开便笺' }
					});
					const zoom = Math.max(0.5, Math.min(1, this.plugin.settings.viewContentZoom));
					card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));

					const listDateTs =
						sortMode.startsWith('ctime') ? f.stat.ctime : f.stat.mtime;

					const head = card.createDiv({ cls: 'csn-list-card-head' });
					head.createDiv({ cls: 'csn-list-card-title', text: f.basename });
					const headRight = head.createDiv({ cls: 'csn-list-card-head-right' });
					headRight.createDiv({
						cls: 'csn-list-card-date',
						text: moment(listDateTs).format('M月D日')
					});
					const menuBtn = headRight.createEl('button', {
						type: 'button',
						cls: 'clickable-icon csn-list-card-menu-btn',
						attr: { 'aria-label': '更多操作', 'aria-haspopup': 'true' }
					});
					setIcon(menuBtn, 'more-horizontal');
					this.registerDomEvent(menuBtn, 'click', (evt: MouseEvent) => {
						evt.preventDefault();
						evt.stopPropagation();
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
									/* 标题里已含色块与勾选，左侧不再用 Lucide 占位 */
									si.setIcon(null);
									si.onClick(() => {
										void this.plugin.stickies
											.setStickyBackgroundColorForFile(f, c.id)
											.then(() => {
												card.setAttr('data-csn-list-color', c.id);
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

					const main = card.createDiv({ cls: 'csn-list-card-main' });
					const previewEl = main.createDiv({
						cls: 'csn-list-card-body csn-list-card-body--rendered markdown-rendered'
					});

					this.registerDomEvent(card, 'dblclick', evt => {
						evt.preventDefault();
						evt.stopPropagation();
						void this.plugin.openStickyForFile(f);
					});

					let md = '';
					try {
						const raw = forceDisk ? await this.app.vault.read(f) : await this.app.vault.cachedRead(f);
						md = previewMarkdownSlice(raw, PREVIEW_MARKDOWN_MAX);
					} catch {
						md = '*（无法读取预览）*';
					}
					if (!md.trim()) md = '*（空白）*';

					await MarkdownRenderer.render(this.app, md, previewEl, f.path, mdHost);
				})
			);

			this.paginationMetaEl.setText(
				`第 ${this.listPageIndex + 1} / ${totalPages} 页 · 本页 ${pageFiles.length} 条 · 共 ${filtered.length} 条`
			);
			this.paginationPrevBtn!.disabled = this.listPageIndex <= 0;
			this.paginationNextBtn!.disabled = this.listPageIndex >= totalPages - 1;

			container.scrollTop = 0;
		} finally {
			this.previewForceDiskRead = false;
			if (this.plugin.listPrioritizeStickyPath) {
				this.plugin.listPrioritizeStickyPath = null;
			}
		}
	}

	async onClose(): Promise<void> {
		this.cancelListRefreshDebouncers();
		this.debouncedListStructureRefresh = null;
		this.debouncedListContentRefresh = null;
		this.disposeListMarkdownHost();
		this.listItemsEl = null;
		this.searchInput = null;
		this.paginationEl = null;
		this.paginationPrevBtn = null;
		this.paginationNextBtn = null;
		this.paginationMetaEl = null;
		this.contentEl.empty();
	}
}
