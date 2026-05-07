import {
	Component,
	ItemView,
	MarkdownRenderer,
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
import { VIEW_STICKY_NOTE_LIST } from '../types';
import { previewMarkdownSlice } from '../utils/preview-markdown-slice';
import { resolveStickyBgColorForFile } from '../utils/sticky-bg-from-file';

const LIST_PAGE_SIZE = 12;
/** 单卡传入渲染器的 Markdown 最大字符数（含换行），避免超大笔记阻塞 UI。 */
const PREVIEW_MARKDOWN_MAX = 8000;

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
	private layoutColumnBtn: HTMLButtonElement | null = null;
	private layoutGridBtn: HTMLButtonElement | null = null;
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
		return 'layout-list';
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
				if (this.pathUnderStickyFolder(f.path)) this.debouncedListStructureRefresh?.();
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
					this.debouncedListContentRefresh?.();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', file => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.pathUnderStickyFolder(file.path)) return;
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
		const layoutLabel = toolbar.createSpan({ cls: 'csn-list-toolbar-label', text: '布局' });
		layoutLabel.setAttr('aria-hidden', 'true');

		const btnWrap = toolbar.createDiv({ cls: 'csn-list-toolbar-btns' });
		this.layoutColumnBtn = btnWrap.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-layout-btn',
			attr: { 'aria-label': '纵向列表', title: '纵向列表' }
		});
		setIcon(this.layoutColumnBtn, 'layout-list');
		this.registerDomEvent(this.layoutColumnBtn, 'click', () => {
			void this.setListLayout('column');
		});

		this.layoutGridBtn = btnWrap.createEl('button', {
			type: 'button',
			cls: 'clickable-icon csn-list-layout-btn',
			attr: { 'aria-label': '自适应网格', title: '自适应网格' }
		});
		setIcon(this.layoutGridBtn, 'layout-grid');
		this.registerDomEvent(this.layoutGridBtn, 'click', () => {
			void this.setListLayout('grid');
		});

		toolbar.createDiv({ cls: 'csn-list-toolbar-spacer' });
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
		this.applyListLayoutClass();

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
		this.syncLayoutToolbarActive();
		void this.renderList();
	}

	private applyListLayoutClass(): void {
		if (!this.listItemsEl) return;
		this.listItemsEl.removeClass('csn-list-items--column', 'csn-list-items--grid');
		const mode = this.plugin.settings.noteListLayout === 'grid' ? 'grid' : 'column';
		this.listItemsEl.addClass(mode === 'grid' ? 'csn-list-items--grid' : 'csn-list-items--column');
	}

	private syncLayoutToolbarActive(): void {
		const mode = this.plugin.settings.noteListLayout === 'grid' ? 'grid' : 'column';
		this.layoutColumnBtn?.toggleClass('is-active', mode === 'column');
		this.layoutGridBtn?.toggleClass('is-active', mode === 'grid');
	}

	private async setListLayout(layout: 'column' | 'grid'): Promise<void> {
		if (this.plugin.settings.noteListLayout === layout) return;
		this.plugin.settings.noteListLayout = layout;
		await this.plugin.saveSettings();
		this.applyListLayoutClass();
		this.syncLayoutToolbarActive();
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

			filtered.sort((a, b) => b.stat.mtime - a.stat.mtime);

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
					const color = (await resolveStickyBgColorForFile(this.app, f)) ?? 'default';
					const card = container.createDiv({
						cls: 'csn-list-card',
						attr: { 'data-csn-list-color': color, title: '双击打开便笺' }
					});
					const zoom = Math.max(0.5, Math.min(1, this.plugin.settings.viewContentZoom));
					card.style.setProperty('--csn-sticky-view-content-zoom', String(zoom));

					const head = card.createDiv({ cls: 'csn-list-card-head' });
					head.createDiv({ cls: 'csn-list-card-title', text: f.basename });
					head.createDiv({
						cls: 'csn-list-card-date',
						text: moment(f.stat.mtime).format('M月D日')
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
		}
	}

	async onClose(): Promise<void> {
		this.cancelListRefreshDebouncers();
		this.debouncedListStructureRefresh = null;
		this.debouncedListContentRefresh = null;
		this.disposeListMarkdownHost();
		this.listItemsEl = null;
		this.layoutColumnBtn = null;
		this.layoutGridBtn = null;
		this.searchInput = null;
		this.paginationEl = null;
		this.paginationPrevBtn = null;
		this.paginationNextBtn = null;
		this.paginationMetaEl = null;
		this.contentEl.empty();
	}
}
