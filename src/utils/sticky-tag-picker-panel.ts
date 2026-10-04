import { setIcon, type App, type TFile } from 'obsidian';
import { t } from '../lang/helpers';
import type { MessageKey } from '../lang/locale/en';
import {
	buildStickyTagTree,
	collectStickyTagCatalog,
	collectVaultTagCatalog,
	displayStickyTag,
	normalizeStickyTag,
	type StickyTagCount,
	type StickyTagTreeNode
} from './sticky-tags-from-file';

export type StickyTagPickerGroup = 'added' | 'current' | 'sticky' | 'vault';

export type StickyTagPickerPanelOptions = {
	app: App;
	host: HTMLElement;
	/** 定位锚点；默认 host。打开时面板挂到 body + fixed，避免 overflow 裁切。 */
	anchorEl?: HTMLElement;
	/** 面板根 class，默认与仪表盘输入区一致。 */
	panelClass?: string;
	ariaLabel: string;
	getSelectedTags: () => readonly string[];
	onToggleTag: (tag: string) => void | Promise<void>;
	/** 点击遮罩 / 请求关闭时回调（用于同步工具栏 UI）。 */
	onRequestClose?: () => void;
	/** 便笺目录下全部文件（「全部便笺标签」）。 */
	listStickyFiles: () => TFile[];
	/** 「当前」范围文件；默认同 listStickyFiles。 */
	listCurrentFiles?: () => TFile[];
	/** 打开方向：输入区向下，底栏向上。 */
	placement?: 'below' | 'above';
};

/**
 * 与仪表盘输入区同构的标签选择面板（搜索 / 分组 / 层级树 / Enter 新建）。
 */
export class StickyTagPickerPanel {
	readonly el: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly groupsEl: HTMLElement;
	private readonly listEl: HTMLElement;
	private group: StickyTagPickerGroup = 'current';
	private search = '';
	private catalogCurrent: StickyTagCount[] = [];
	private catalogSticky: StickyTagCount[] = [];
	private catalogVault: StickyTagCount[] = [];
	private readonly treeCollapsed = new Set<string>();
	private readonly opts: StickyTagPickerPanelOptions;
	private readonly cleanups: Array<() => void> = [];
	private portaled = false;
	private backdropEl: HTMLElement | null = null;
	private readonly onReposition = (): void => {
		if (this.isOpen()) this.positionPanel();
	};

	constructor(opts: StickyTagPickerPanelOptions) {
		this.opts = opts;
		const panelClass = opts.panelClass ?? 'csn-dash-composer-tag-panel';
		const placement = opts.placement ?? 'below';
		this.el = opts.host.createDiv({
			cls: `${panelClass} csn-dash-composer-tag-panel--hidden csn-sticky-tag-picker-panel${
				placement === 'above' ? ' csn-sticky-tag-picker--above' : ''
			}`,
			attr: {
				role: 'dialog',
				'aria-label': opts.ariaLabel,
				hidden: 'true'
			}
		});

		const tools = this.el.createDiv({ cls: 'csn-dash-tag-panel-tools' });
		const searchInner = tools.createDiv({ cls: 'csn-dash-tag-search-inner' });
		const searchIcon = searchInner.createSpan({
			cls: 'csn-dash-tag-search-icon',
			attr: { 'aria-hidden': 'true' }
		});
		setIcon(searchIcon, 'search');
		this.searchInput = searchInner.createEl('input', {
			type: 'text',
			cls: 'csn-dash-tag-search-input',
			attr: {
				placeholder: t('DASH_COMPOSER_TAG_SEARCH_PLACEHOLDER'),
				spellcheck: 'false',
				autocomplete: 'off'
			}
		});
		this.on(this.searchInput, 'input', () => {
			this.search = this.searchInput.value;
			this.renderBody();
		});
		this.on(this.searchInput, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key !== 'Enter') return;
			evt.preventDefault();
			evt.stopPropagation();
			if (this.tryCreateFromSearch()) {
				this.searchInput.value = '';
				this.search = '';
				this.renderBody();
			}
		});
		this.on(this.searchInput, 'click', (evt: MouseEvent) => evt.stopPropagation());

		const body = this.el.createDiv({ cls: 'csn-dash-tag-panel-body' });
		this.groupsEl = body.createDiv({ cls: 'csn-dash-tag-groups' });
		const groups: Array<{ id: StickyTagPickerGroup; labelKey: MessageKey }> = [
			{ id: 'added', labelKey: 'DASH_COMPOSER_TAG_GROUP_ADDED' },
			{ id: 'current', labelKey: 'DASH_COMPOSER_TAG_GROUP_CURRENT' },
			{ id: 'sticky', labelKey: 'DASH_COMPOSER_TAG_GROUP_STICKY' },
			{ id: 'vault', labelKey: 'DASH_COMPOSER_TAG_GROUP_VAULT' }
		];
		for (const g of groups) {
			const btn = this.groupsEl.createEl('button', {
				type: 'button',
				cls: 'csn-dash-tag-group-btn',
				attr: { 'data-csn-composer-tag-group': g.id }
			});
			btn.createSpan({ cls: 'csn-dash-tag-group-label', text: t(g.labelKey) });
			btn.createSpan({ cls: 'csn-dash-tag-group-count', text: '0' });
			this.on(btn, 'click', () => {
				this.group = g.id;
				this.renderBody();
			});
		}
		this.listEl = body.createDiv({ cls: 'csn-dash-tag-list' });
	}

	private on<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (ev: HTMLElementEventMap[K]) => void
	): void {
		el.addEventListener(type, handler as EventListener);
		this.cleanups.push(() => el.removeEventListener(type, handler as EventListener));
	}

	isOpen(): boolean {
		return !this.el.hasClass('csn-dash-composer-tag-panel--hidden');
	}

	open(opts?: { group?: StickyTagPickerGroup }): void {
		if (opts?.group) this.group = opts.group;
		this.refreshCatalogs();
		this.attachPortal();
		this.el.removeClass('csn-dash-composer-tag-panel--hidden');
		this.el.removeAttribute('hidden');
		this.renderBody();
		this.positionPanel();
		window.setTimeout(() => {
			this.positionPanel();
			this.searchInput.focus();
		}, 0);
	}

	close(): void {
		this.el.addClass('csn-dash-composer-tag-panel--hidden');
		this.el.setAttr('hidden', 'true');
		this.detachPortal();
	}

	toggle(opts?: { group?: StickyTagPickerGroup }): void {
		if (this.isOpen()) this.close();
		else this.open(opts ?? { group: 'current' });
	}

	/** 选中标签变更后刷新列表勾选态（面板打开时）。 */
	refreshIfOpen(): void {
		if (this.isOpen()) {
			this.renderBody();
			this.positionPanel();
		}
	}

	contains(node: Node): boolean {
		return this.el.contains(node);
	}

	/** 点击落在面板或关闭遮罩上。 */
	containsEventTarget(node: Node): boolean {
		return this.el.contains(node) || !!this.backdropEl?.contains(node);
	}

	destroy(): void {
		window.removeEventListener('resize', this.onReposition);
		document.removeEventListener('scroll', this.onReposition, true);
		for (const off of this.cleanups) off();
		this.cleanups.length = 0;
		this.detachPortal();
		this.el.remove();
	}

	private getAnchor(): HTMLElement {
		return this.opts.anchorEl ?? this.opts.host;
	}

	private requestClose(): void {
		if (this.opts.onRequestClose) this.opts.onRequestClose();
		else this.close();
	}

	/** 挂到 body，避免卡片 / 悬浮窗 overflow:hidden 裁切。 */
	private attachPortal(): void {
		if (this.portaled) return;
		const doc = this.opts.host.ownerDocument;
		this.backdropEl = doc.body.createDiv({
			cls: 'csn-sticky-tag-picker-backdrop',
			attr: { 'aria-hidden': 'true' }
		});
		this.backdropEl.addEventListener('pointerdown', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.requestClose();
		});
		/* 吞掉 click，避免穿透到下方便笺触发其它操作 */
		this.backdropEl.addEventListener('click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
		});
		doc.body.appendChild(this.backdropEl);
		doc.body.appendChild(this.el);
		this.el.addClass('csn-sticky-tag-picker--portaled');
		this.portaled = true;
		window.addEventListener('resize', this.onReposition);
		doc.addEventListener('scroll', this.onReposition, true);
	}

	private detachPortal(): void {
		if (!this.portaled) return;
		const doc = this.opts.host.ownerDocument;
		window.removeEventListener('resize', this.onReposition);
		doc.removeEventListener('scroll', this.onReposition, true);
		this.el.removeClass('csn-sticky-tag-picker--portaled');
		this.clearPortalStyles();
		this.backdropEl?.remove();
		this.backdropEl = null;
		if (this.el.parentElement !== this.opts.host) {
			this.opts.host.appendChild(this.el);
		}
		this.portaled = false;
	}

	private clearPortalStyles(): void {
		const s = this.el.style;
		s.removeProperty('left');
		s.removeProperty('top');
		s.removeProperty('bottom');
		s.removeProperty('width');
		s.removeProperty('max-height');
	}

	private positionPanel(): void {
		if (!this.portaled || !this.isOpen()) return;
		const anchor = this.getAnchor();
		const r = anchor.getBoundingClientRect();
		const pad = 8;
		const gap = 6;
		const preferredW = Math.min(480, Math.max(260, window.innerWidth - pad * 2));
		const left = Math.min(
			Math.max(pad, Math.round(r.right - preferredW)),
			Math.max(pad, window.innerWidth - preferredW - pad)
		);
		const placement = this.opts.placement ?? 'below';
		/* position/z-index/right/bottom(/top when above) 由 --portaled CSS 提供 */
		this.el.style.width = `${preferredW}px`;
		this.el.style.left = `${left}px`;

		if (placement === 'above') {
			const spaceAbove = Math.max(120, Math.round(r.top - gap - pad));
			const maxH = Math.min(380, spaceAbove);
			this.el.style.bottom = `${Math.max(pad, Math.round(window.innerHeight - r.top + gap))}px`;
			this.el.style.maxHeight = `${maxH}px`;
		} else {
			const spaceBelow = Math.max(120, Math.round(window.innerHeight - r.bottom - gap - pad));
			const maxH = Math.min(380, spaceBelow);
			this.el.style.top = `${Math.round(r.bottom + gap)}px`;
			this.el.style.maxHeight = `${maxH}px`;
		}
	}

	private refreshCatalogs(): void {
		const stickyFiles = this.opts.listStickyFiles();
		this.catalogSticky = collectStickyTagCatalog(this.opts.app, stickyFiles);
		const currentFiles = this.opts.listCurrentFiles?.() ?? stickyFiles;
		this.catalogCurrent = collectStickyTagCatalog(this.opts.app, currentFiles);
		this.catalogVault = collectVaultTagCatalog(this.opts.app);
	}

	private tryCreateFromSearch(): boolean {
		const q = this.search.trim();
		if (!q) return false;
		void Promise.resolve(this.opts.onToggleTag(normalizeStickyTag(q)));
		return true;
	}

	private renderBody(): void {
		const selected = this.opts.getSelectedTags().map(normalizeStickyTag).filter(Boolean);
		const selectedSet = new Set(selected);
		const counts: Record<StickyTagPickerGroup, number> = {
			added: selected.length,
			current: this.catalogCurrent.length,
			sticky: this.catalogSticky.length,
			vault: this.catalogVault.length
		};
		for (const btn of Array.from(this.groupsEl.querySelectorAll('.csn-dash-tag-group-btn'))) {
			if (!btn?.instanceOf(HTMLElement)) continue;
			const id = btn.dataset.csnComposerTagGroup as StickyTagPickerGroup | undefined;
			if (!id) continue;
			const countEl = btn.querySelector('.csn-dash-tag-group-count');
			if (countEl) countEl.setText(String(counts[id]));
			btn.toggleClass('is-active', this.group === id);
		}

		const q = this.search.trim().toLowerCase().replace(/^#/, '');
		let rows: StickyTagCount[] = [];
		if (this.group === 'added') {
			rows = selected.map(tag => ({ tag, count: 1 }));
		} else if (this.group === 'current') {
			rows = this.catalogCurrent;
		} else if (this.group === 'sticky') {
			rows = this.catalogSticky;
		} else {
			rows = this.catalogVault;
		}
		if (q) {
			rows = rows.filter(
				r => displayStickyTag(r.tag).toLowerCase().includes(q) || r.tag.includes(q)
			);
		}

		this.listEl.empty();
		if (rows.length === 0) {
			this.listEl.createDiv({ cls: 'csn-dash-tag-empty', text: t('DASH_COMPOSER_TAG_EMPTY') });
			return;
		}

		if (q) {
			for (const row of rows) {
				this.appendItem({
					fullTag: row.tag,
					label: displayStickyTag(row.tag),
					count: row.count,
					depth: 0,
					hasChildren: false,
					collapsed: false,
					selectedSet
				});
			}
			return;
		}

		const tree = buildStickyTagTree(rows);
		const walk = (nodes: StickyTagTreeNode[], depth: number) => {
			for (const node of nodes) {
				const hasChildren = node.children.length > 0;
				const collapsed = hasChildren && this.treeCollapsed.has(node.fullTag);
				this.appendItem({
					fullTag: node.fullTag,
					label: node.name,
					count: node.count,
					depth,
					hasChildren,
					collapsed,
					selectedSet
				});
				if (hasChildren && !collapsed) walk(node.children, depth + 1);
			}
		};
		walk(tree, 0);
	}

	private appendItem(opts: {
		fullTag: string;
		label: string;
		count: number;
		depth: number;
		hasChildren: boolean;
		collapsed: boolean;
		selectedSet: Set<string>;
	}): void {
		const item = this.listEl.createEl('button', {
			type: 'button',
			cls: 'csn-dash-tag-item csn-dash-tag-item--tree',
			attr: {
				'data-csn-tag': opts.fullTag,
				style: `--csn-tag-depth: ${opts.depth}`
			}
		});
		const toggle = item.createSpan({
			cls: 'csn-dash-tag-tree-toggle',
			attr: { 'aria-hidden': 'true' }
		});
		if (opts.hasChildren) {
			toggle.addClass('is-toggle');
			setIcon(toggle, opts.collapsed ? 'chevron-right' : 'chevron-down');
			this.on(toggle, 'click', (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				if (this.treeCollapsed.has(opts.fullTag)) this.treeCollapsed.delete(opts.fullTag);
				else this.treeCollapsed.add(opts.fullTag);
				this.renderBody();
			});
		}
		const check = item.createSpan({ cls: 'csn-dash-tag-check', attr: { 'aria-hidden': 'true' } });
		const selected = opts.selectedSet.has(opts.fullTag);
		if (selected) {
			item.addClass('is-included');
			setIcon(check, 'check-square');
		} else {
			setIcon(check, 'square');
		}
		item.createSpan({ cls: 'csn-dash-tag-item-text', text: opts.label });
		if (this.group !== 'added' && opts.count > 0) {
			item.createSpan({ cls: 'csn-dash-tag-item-count', text: String(opts.count) });
		}
		this.on(item, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			void Promise.resolve(this.opts.onToggleTag(opts.fullTag)).then(() => this.renderBody());
		});
	}
}
