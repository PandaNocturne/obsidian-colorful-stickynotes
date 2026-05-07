import { around } from 'monkey-around';
import {
	FileView,
	MarkdownView,
	Plugin,
	Workspace,
	WorkspaceItem,
	WorkspaceLeaf,
	WorkspaceSplit,
	WorkspaceTabs,
	setIcon
} from 'obsidian';
import type { TFile } from 'obsidian';
import type { FloatingBounds, StickyColorId } from '../types';
import { clampViewContentZoom } from '../settings';
import { SHEET_COLOR_ORDER } from './sticky-color-order';

type WorkspaceSplitCtor = new (ws: Workspace, dir: 'horizontal' | 'vertical') => WorkspaceSplit;
type SplitWithReplace = WorkspaceSplit & {
	children: WorkspaceItem[];
	replaceChild(index: number, child: WorkspaceItem): void;
};
type WorkspaceSplitWithDom = WorkspaceSplit & { containerEl: HTMLElement };

const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;
const VIEWPORT_MARGIN = 12;
const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeDirection = (typeof RESIZE_DIRECTIONS)[number];

export interface StickyNotePopoverOptions {
	plugin: Plugin;
	mountEl: HTMLElement;
	bounds?: FloatingBounds | null;
	defaultMarkdownMode: 'preview' | 'source';
	initialColor: StickyColorId;
	initialCollapsed: boolean;
	initialYamlVisible: boolean;
	bottomBarAutoHide: boolean;
	/** 正文区域 zoom（0.3–1），作用于 `.view-content`。 */
	viewContentZoom: number;
	onClose: () => void;
	onBoundsChange: (bounds: FloatingBounds) => void;
	onRequestNewSticky: () => void;
	onColorChange: (c: StickyColorId) => void;
	onCollapseChange?: (c: boolean) => void;
	onYamlVisibilityChange?: (v: boolean) => void;
	/** 阅读/编辑模式切换并落盘后由管理器写入工作区。 */
	onMarkdownModeChange?: () => void;
	onOpenNoteList: () => void;
	/** 删除便笺：由管理器激活当前叶视图并执行 Obsidian 默认「删除当前笔记」命令。 */
	onDeleteCurrentSticky: () => void;
	/** 用户与本窗口交互或成为活动便笺时：提升到其他便笺之上。 */
	onActivate: () => void;
}

export class StickyNotePopover {
	readonly rootEl: HTMLElement;
	private readonly bodyWrapEl: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly mainColumnEl: HTMLElement;
	private readonly bottomBarEl: HTMLElement;
	private readonly bottomTitleEl: HTMLElement;
	private readonly settingsBtn: HTMLButtonElement;
	private readonly sheetLayerEl: HTMLElement;
	private readonly sheetBackdropEl: HTMLElement;
	private readonly sheetPanelEl: HTMLElement;
	private sheetOpen = false;
	private readonly colorSwatchEls = new Map<StickyColorId, HTMLButtonElement>();
	private readonly rootSplit: WorkspaceSplit;
	private readonly plugin: Plugin;
	private readonly onBoundsChange: (bounds: FloatingBounds) => void;
	leaf: WorkspaceLeaf | null = null;
	private isDragging = false;
	private isResizing = false;
	private dragPointerId: number | null = null;
	private resizePointerId: number | null = null;
	private resizeDirection: ResizeDirection | null = null;
	private dragOffsetX = 0;
	private dragOffsetY = 0;
	/** 拖动开始时记录的完整宽高（折叠态下仍读 inline，供 applyBounds 不写矮高度）。 */
	private dragPersistBounds: FloatingBounds | null = null;
	/**
	 * 展开状态下的逻辑宽高。折叠时 CSS 为 height:auto，offsetHeight 仅为标题条，
	 * 不能再用于 getBounds/持久化，否则会把 inline 高度写成矮值并丢失原始高度。
	 */
	private expandedW = MIN_WIDTH;
	private expandedH = MIN_HEIGHT;
	private resizeStartX = 0;
	private resizeStartY = 0;
	private resizeStartBounds: FloatingBounds | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private bottomBarResizeObserver: ResizeObserver | null = null;
	private resizeReflowRaf: number | null = null;
	private leafModeSyncUninstall: (() => void) | null = null;
	/** `getComputedStyle` 昂贵；`--layer-popover` 在会话内基本不变，按实例缓存。 */
	private cachedLayerPopover: string | null = null;
	private modeToggleLayoutRaf: number | null = null;
	private disposed = false;
	private collapsed: boolean;
	private yamlVisible: boolean;
	private modeToggleWrap!: HTMLElement;
	private markdownModeToggleBtn!: HTMLButtonElement;
	private foldBtn!: HTMLButtonElement;
	constructor(private readonly options: StickyNotePopoverOptions) {
		this.plugin = options.plugin;
		this.onBoundsChange = options.onBoundsChange;
		this.collapsed = options.initialCollapsed;
		this.yamlVisible = options.initialYamlVisible;

		const mount = options.mountEl;
		/* 勿使用 mod-root：会与主工作区根节点样式冲突，导致叶视图高度为 0、内容不可见 */
		this.rootEl = mount.createDiv({
			cls: 'csn-sticky',
			attr: { 'data-csn-sticky': 'true', 'data-csn-color': options.initialColor }
		});
		this.rootEl.style.setProperty('--csn-sticky-stack', '0');
		this.rootEl.style.setProperty('--csn-sticky-active-fine-lift', '0');

		this.plugin.registerDomEvent(
			this.rootEl,
			'pointerdown',
			(e: PointerEvent) => {
				if (this.disposed) return;
				if (e.pointerType === 'mouse' && e.button !== 0) return;
				this.options.onActivate();
			},
			{ capture: true }
		);

		this.headerEl = this.rootEl.createDiv({ cls: 'csn-sticky-header' });
		this.wireHeader();

		const SplitCtor = WorkspaceSplit as unknown as WorkspaceSplitCtor;
		this.rootSplit = new SplitCtor(this.plugin.app.workspace, 'vertical');
		this.wireRootSplitRouting();

		this.mainColumnEl = this.rootEl.createDiv({ cls: 'csn-sticky-main' });
		this.bodyWrapEl = this.mainColumnEl.createDiv({ cls: 'csn-sticky-body' });
		this.bodyWrapEl.appendChild((this.rootSplit as WorkspaceSplitWithDom).containerEl);
		this.plugin.registerDomEvent(this.bodyWrapEl, 'mousedown', () => {
			const leaf = this.leaf;
			if (!leaf || this.disposed) return;
			void this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		});

		this.sheetLayerEl = this.mainColumnEl.createDiv({ cls: 'csn-sticky-sheet-layer' });
		this.sheetBackdropEl = this.sheetLayerEl.createDiv({ cls: 'csn-sticky-sheet-backdrop' });
		this.sheetPanelEl = this.sheetLayerEl.createDiv({ cls: 'csn-sticky-sheet' });
		this.wireSettingsSheet();

		this.bottomBarEl = this.mainColumnEl.createDiv({ cls: 'csn-sticky-bottombar' });
		this.bottomTitleEl = this.bottomBarEl.createSpan({ cls: 'csn-sticky-bottombar-title' });
		this.settingsBtn = this.bottomBarEl.createEl('button', {
			cls: 'clickable-icon csn-sticky-bottombar-settings',
			attr: { type: 'button', 'aria-label': '便笺设置', 'aria-expanded': 'false' }
		});
		setIcon(this.settingsBtn, 'settings');
		this.plugin.registerDomEvent(this.settingsBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.toggleSettingsSheet();
		});

		this.bottomBarResizeObserver = new ResizeObserver(() => this.syncBottomBarHeightCss());
		this.bottomBarResizeObserver.observe(this.bottomBarEl);
		this.syncBottomBarHeightCss();

		this.attachLeaf();
		this.wireLeafModeSync();

		this.setViewContentZoom(options.viewContentZoom);

		const defaultWidth = Math.min(420, window.innerWidth - VIEWPORT_MARGIN);
		const defaultHeight = Math.min(360, window.innerHeight - VIEWPORT_MARGIN);
		const b = options.bounds;
		const w = b ? Math.min(b.width, window.innerWidth - VIEWPORT_MARGIN) : defaultWidth;
		const h = b ? Math.min(b.height, window.innerHeight - VIEWPORT_MARGIN) : defaultHeight;
		const left = b ? b.left : Math.max(VIEWPORT_MARGIN, Math.round((window.innerWidth - w) / 2));
		const top = b ? b.top : Math.max(VIEWPORT_MARGIN, Math.round((window.innerHeight - h) / 2));
		this.applyBounds({ left, top, width: w, height: h }, false);

		this.plugin.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => {
				const rs = this.rootSplit as unknown as SplitWithReplace;
				if (rs.children && typeof rs.replaceChild === 'function') {
					rs.children.forEach((item, index) => {
						if (!(item instanceof WorkspaceTabs)) return;
						const tabs = item as WorkspaceTabs & { children?: WorkspaceItem[] };
						const first = tabs.children?.[0];
						if (first) {
							rs.replaceChild(index, first);
						}
					});
				}
				this.scheduleSyncModeToggleUiAfterLayout();
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', file => {
				const view = this.leaf?.view;
				if (!view || !file) return;
				if (view instanceof FileView && view.file === file) {
					this.syncModeToggleUi();
				}
			})
		);

		this.syncModeToggleUi();

		this.plugin.registerDomEvent(window, 'keydown', (e: KeyboardEvent) => {
			if (!this.sheetOpen || e.key !== 'Escape') return;
			e.preventDefault();
			e.stopPropagation();
			this.closeSettingsSheet();
		});

		this.headerEl.addEventListener('pointerdown', this.onTitlePointerDown);
		for (const dir of RESIZE_DIRECTIONS) {
			this.rootEl
				.createDiv({
					cls: `csn-sticky-resize is-${dir}`,
					attr: { 'data-direction': dir }
				})
				.addEventListener('pointerdown', this.onResizePointerDown);
		}

		window.addEventListener('pointermove', this.onPointerMove);
		window.addEventListener('pointerup', this.onPointerUp);
		window.addEventListener('pointercancel', this.onPointerUp);

		this.resizeObserver = new ResizeObserver(() => {
			if (this.disposed || this.isDragging || this.isResizing) return;
			this.emitResize();
		});
		this.resizeObserver.observe(this.rootEl);

		this.applyCollapsedClass();
		this.applyYamlClass();
		this.applyBottomBarAutoHideClass();
	}

	setColor(c: StickyColorId): void {
		this.rootEl.setAttribute('data-csn-color', c);
		if (this.sheetOpen) this.refreshSheetColorSelection();
	}

	getColor(): StickyColorId {
		return (this.rootEl.getAttribute('data-csn-color') as StickyColorId) ?? 'default';
	}

	getCollapsed(): boolean {
		return this.collapsed;
	}

	getYamlVisible(): boolean {
		return this.yamlVisible;
	}

	/** 当前 Markdown 视图模式；非 md 或未打开文件时回退为创建时默认。 */
	getMarkdownMode(): 'preview' | 'source' {
		const v = this.leaf?.view;
		if (v instanceof MarkdownView && v.file?.extension === 'md') {
			const m = v.getMode();
			if (m === 'source' || m === 'preview') return m;
		}
		return this.options.defaultMarkdownMode;
	}

	setBottomBarSettings(autoHide: boolean): void {
		this.bottomBarAutoHide = autoHide;
		this.applyBottomBarAutoHideClass();
		window.requestAnimationFrame(() => this.syncBottomBarHeightCss());
	}

	/** 与 HoverNoteLeafPopover#setPreviewScale 相同思路：根节点 CSS 变量 + `.view-content` 的 zoom。 */
	setViewContentZoom(scale: number): void {
		const s = clampViewContentZoom(scale);
		this.rootEl.style.setProperty('--csn-sticky-view-content-zoom', String(s));
	}

	private bottomBarAutoHide = false;

	private applyBottomBarAutoHideClass(): void {
		this.rootEl.toggleClass('csn-sticky--bar-autohide', this.bottomBarAutoHide);
	}

	private syncBottomBarHeightCss(): void {
		if (this.disposed) return;
		let h = this.bottomBarEl.offsetHeight;
		/* 底栏自动隐藏收起时 offsetHeight 可能为 0，仍预留一条带高度以便抽屉贴在「工具栏区域」之上 */
		if (h < 4) h = 38;
		this.mainColumnEl.style.setProperty('--csn-sticky-bottombar-height', `${h}px`);
	}

	private wireHeader(): void {
		const left = this.headerEl.createDiv({ cls: 'csn-sticky-header-left' });
		const addBtn = left.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '新建便笺' }
		});
		setIcon(addBtn, 'plus');
		this.plugin.registerDomEvent(addBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.options.onRequestNewSticky();
		});

		this.headerEl.createDiv({ cls: 'csn-sticky-header-spacer' });

		this.modeToggleWrap = this.headerEl.createDiv({ cls: 'csn-sticky-mode-toggle' });
		this.markdownModeToggleBtn = this.modeToggleWrap.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '阅读模式，点击进入编辑' }
		});
		setIcon(this.markdownModeToggleBtn, 'book-open');
		this.plugin.registerDomEvent(this.markdownModeToggleBtn, 'click', async evt => {
			evt.preventDefault();
			evt.stopPropagation();
			const leaf = this.leaf;
			if (!leaf || this.disposed) return;
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file || view.file.extension !== 'md') return;
			const next = view.getMode() === 'preview' ? 'source' : 'preview';
			await this.setMarkdownMode(next);
		});

		const right = this.headerEl.createDiv({ cls: 'csn-sticky-header-right' });
		const yamlBtn = right.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': 'YAML 属性' }
		});
		setIcon(yamlBtn, 'alert-circle');
		this.plugin.registerDomEvent(yamlBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.yamlVisible = !this.yamlVisible;
			this.applyYamlClass();
			this.options.onYamlVisibilityChange?.(this.yamlVisible);
		});

		this.foldBtn = right.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: {
				type: 'button',
				'aria-label': '折叠/展开',
				title: '折叠/展开',
				'aria-expanded': 'true'
			}
		});
		this.plugin.registerDomEvent(this.foldBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.collapsed = !this.collapsed;
			this.applyCollapsedClass();
			this.options.onCollapseChange?.(this.collapsed);
		});

		const closeBtn = right.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '关闭' }
		});
		setIcon(closeBtn, 'x');
		this.plugin.registerDomEvent(closeBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.options.onClose();
		});

		this.syncFoldButtonUi();
	}

	private wireSettingsSheet(): void {
		this.plugin.registerDomEvent(this.sheetBackdropEl, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.closeSettingsSheet();
		});
		this.plugin.registerDomEvent(this.sheetPanelEl, 'click', evt => {
			evt.stopPropagation();
		});

		/* 自上而下：删除便笺 → 便笺列表；底部无缝颜色条 */
		const actions = this.sheetPanelEl.createDiv({ cls: 'csn-sticky-sheet-actions' });

		const deleteBtn = actions.createEl('button', {
			cls: 'csn-sticky-sheet-action csn-sticky-sheet-action--danger',
			type: 'button'
		});
		const delIc = deleteBtn.createSpan({ cls: 'csn-sticky-sheet-action-icon' });
		setIcon(delIc, 'trash-2');
		deleteBtn.createSpan({ text: '删除便笺' });
		this.plugin.registerDomEvent(deleteBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.closeSettingsSheet();
			this.options.onDeleteCurrentSticky();
		});

		const listBtn = actions.createEl('button', {
			cls: 'csn-sticky-sheet-action',
			type: 'button'
		});
		const listIc = listBtn.createSpan({ cls: 'csn-sticky-sheet-action-icon' });
		setIcon(listIc, 'layout-list');
		listBtn.createSpan({ text: '便笺列表' });
		this.plugin.registerDomEvent(listBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.closeSettingsSheet();
			this.options.onOpenNoteList();
		});

		const colorsRow = this.sheetPanelEl.createDiv({ cls: 'csn-sticky-sheet-colors' });
		for (const c of SHEET_COLOR_ORDER) {
			const sw = colorsRow.createEl('button', {
				cls: 'csn-sticky-sheet-swatch',
				type: 'button',
				attr: { 'data-csn-sheet-color': c.id, 'aria-label': c.label }
			});
			const checkWrap = sw.createSpan({ cls: 'csn-sticky-sheet-swatch-check' });
			this.colorSwatchEls.set(c.id, sw);
			this.plugin.registerDomEvent(sw, 'click', evt => {
				evt.preventDefault();
				evt.stopPropagation();
				this.setColor(c.id);
				this.options.onColorChange(c.id);
				this.refreshSheetColorSelection();
			});
			checkWrap.style.display = 'none';
		}
		this.refreshSheetColorSelection();
	}

	private refreshSheetColorSelection(): void {
		const cur = this.getColor();
		for (const [id, el] of this.colorSwatchEls) {
			el.toggleClass('is-selected', id === cur);
			const check = el.querySelector('.csn-sticky-sheet-swatch-check');
			if (check instanceof HTMLElement) {
				check.replaceChildren();
				if (id === cur) {
					check.style.display = '';
					setIcon(check, 'check');
				} else {
					check.style.display = 'none';
				}
			}
		}
	}

	private toggleSettingsSheet(): void {
		if (this.sheetOpen) this.closeSettingsSheet();
		else this.openSettingsSheet();
	}

	private openSettingsSheet(): void {
		if (this.collapsed || this.disposed) return;
		this.syncBottomBarHeightCss();
		this.sheetOpen = true;
		this.rootEl.addClass('csn-sticky--sheet-open');
		this.settingsBtn.setAttr('aria-expanded', 'true');
		this.refreshSheetColorSelection();
	}

	private closeSettingsSheet(): void {
		if (!this.sheetOpen) return;
		this.sheetOpen = false;
		this.rootEl.removeClass('csn-sticky--sheet-open');
		this.settingsBtn.setAttr('aria-expanded', 'false');
	}

	private syncBottomBarTitle(): void {
		const view = this.leaf?.view;
		const file = view && 'file' in view ? (view as { file?: TFile }).file : undefined;
		if (file) {
			this.bottomTitleEl.setText(file.name);
			this.bottomTitleEl.setAttr('title', file.path);
		} else {
			this.bottomTitleEl.setText('');
			this.bottomTitleEl.removeAttribute('title');
		}
	}

	private applyCollapsedClass(): void {
		const expanding = this.rootEl.hasClass('csn-sticky--collapsed') && !this.collapsed;
		this.rootEl.toggleClass('csn-sticky--collapsed', this.collapsed);
		if (this.collapsed) this.closeSettingsSheet();
		this.syncFoldButtonUi();
		if (expanding) {
			window.requestAnimationFrame(() => {
				if (this.disposed) return;
				this.fitExpandedStickyToViewport();
			});
		}
	}

	/** 图标固定为「展开」态 chevrons-up-down；提示统一为「折叠/展开」。 */
	private syncFoldButtonUi(): void {
		setIcon(this.foldBtn, 'chevrons-up-down');
		this.foldBtn.setAttr('aria-label', '折叠/展开');
		this.foldBtn.setAttr('title', '折叠/展开');
		this.foldBtn.setAttr('aria-expanded', this.collapsed ? 'false' : 'true');
	}

	/**
	 * 展开后若底部超出视口，则上移 top，保证完整窗口落在可视区域内。
	 *（折叠态 CSS 为 height:auto，展开后恢复存储高度，可能瞬间超出下边沿。）
	 */
	private fitExpandedStickyToViewport(): void {
		/* 展开后首帧 layout 可能尚未更新 offsetHeight，双 rAF + 读 inline 保证用到完整高度 */
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				if (this.disposed || this.collapsed) return;
				const margin = VIEWPORT_MARGIN;
				const sw = this.rootEl.style.width;
				const sh = this.rootEl.style.height;
				const pw = sw ? parseFloat(sw) : NaN;
				const ph = sh ? parseFloat(sh) : NaN;
				let width = Math.max(MIN_WIDTH, Number.isFinite(pw) ? pw : this.rootEl.offsetWidth);
				let height = Math.max(MIN_HEIGHT, Number.isFinite(ph) ? ph : this.rootEl.offsetHeight);
				height = Math.min(height, window.innerHeight - margin);
				width = Math.min(width, window.innerWidth - margin);
				let left = this.rootEl.offsetLeft;
				let top = this.rootEl.offsetTop;
				if (top + height > window.innerHeight - margin) {
					top = window.innerHeight - margin - height;
				}
				if (top < margin) top = margin;
				const maxLeft = Math.max(margin, window.innerWidth - width - margin);
				left = Math.min(Math.max(margin, left), maxLeft);
				this.applyBounds({ left, top, width, height }, true);
			});
		});
	}

	/** 折叠态 root 为 height:auto，夹紧位移时用实际渲染框（可视占位）尺寸。 */
	private getViewportClampRect(): DOMRect {
		return this.rootEl.getBoundingClientRect();
	}

	private applyYamlClass(): void {
		this.rootEl.toggleClass('csn-metadata-on', this.yamlVisible);
	}

	focus(): void {
		this.options.onActivate();
		if (this.leaf) {
			void this.plugin.app.workspace.setActiveLeaf(this.leaf, { focus: true });
		}
	}

	/** 由管理器设置：仅一个便笺显示「活动」标题样式。 */
	setActiveHighlight(on: boolean): void {
		this.rootEl.toggleClass('csn-sticky--active', on);
		this.rootEl.style.setProperty('--csn-sticky-active-fine-lift', on ? '1' : '0');
		this.applyBounds(this.getBounds(), false);
		/* 切换激活时与打开设置类似：同步底栏高度变量并触发叶视图测量，缓解嵌套 workspace 首帧高度链断裂 */
		if (on) {
			window.requestAnimationFrame(() => {
				if (this.disposed) return;
				this.syncBottomBarHeightCss();
				this.requestLeafMeasure();
			});
		}
	}

	/** 叠在其他便笺之上：与 Obsidian 的 `--layer-popover` 相加。 */
	setZStackBoost(n: number): void {
		this.rootEl.style.setProperty('--csn-sticky-stack', String(n));
	}

	getBounds(): FloatingBounds {
		const left = this.rootEl.offsetLeft;
		const top = this.rootEl.offsetTop;
		if (this.collapsed) {
			return { left, top, width: this.expandedW, height: this.expandedH };
		}
		return {
			left,
			top,
			width: this.rootEl.offsetWidth,
			height: this.rootEl.offsetHeight
		};
	}

	setBounds(bounds: FloatingBounds): void {
		this.applyBounds(bounds, false);
	}

	/**
	 * @param openOpts.workspaceActive 为 false 时不把工作区活动叶切到本便笺（批量恢复时用，避免抢焦点/光标）。
	 */
	async openFile(file: TFile, openOpts?: { workspaceActive?: boolean }): Promise<void> {
		const leaf = this.leaf;
		if (!leaf) return;
		const workspaceActive = openOpts?.workspaceActive !== false;

		if (file.extension === 'md') {
			await leaf.setViewState({
				type: 'markdown',
				state: { file: file.path, mode: this.options.defaultMarkdownMode === 'source' ? 'source' : 'preview' },
				active: workspaceActive
			});
		} else {
			await leaf.openFile(file, { active: workspaceActive });
		}

		/* setViewState 后先交出一帧，让便笺窗口与叶视图占位先上屏，再跑 loadIfDeferred 的重排版。 */
		await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		await leaf.loadIfDeferred?.();
		if (this.disposed) return;
		this.syncModeToggleUi();
		this.syncBottomBarHeightCss();
		this.requestLeafMeasure();
		/* 再延后两帧测量：偶发仅首帧高度未传导至嵌套 leaf，表现为正文整体上移、抬头似缺失；点底栏设置会触发同类同步从而恢复 */
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				if (this.disposed) return;
				this.syncBottomBarHeightCss();
				this.requestLeafMeasure();
			});
		});
	}

	destroy(): void {
		this.disposed = true;
		if (this.resizeReflowRaf !== null) {
			cancelAnimationFrame(this.resizeReflowRaf);
			this.resizeReflowRaf = null;
		}
		if (this.modeToggleLayoutRaf !== null) {
			cancelAnimationFrame(this.modeToggleLayoutRaf);
			this.modeToggleLayoutRaf = null;
		}
		window.removeEventListener('pointermove', this.onPointerMove);
		window.removeEventListener('pointerup', this.onPointerUp);
		window.removeEventListener('pointercancel', this.onPointerUp);
		this.headerEl.removeEventListener('pointerdown', this.onTitlePointerDown);

		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		this.bottomBarResizeObserver?.disconnect();
		this.bottomBarResizeObserver = null;

		this.leafModeSyncUninstall?.();
		this.leafModeSyncUninstall = null;

		if (this.leaf) {
			this.leaf.detach();
			this.leaf = null;
		}

		this.rootEl.remove();
	}

	private syncModeToggleUi(): void {
		const view = this.leaf?.view;
		const md = view instanceof MarkdownView ? view : null;
		const show = !!md?.file && md.file.extension === 'md';
		this.modeToggleWrap.style.display = show ? '' : 'none';
		if (show && md) {
			const mode = md.getMode();
			setIcon(this.markdownModeToggleBtn, mode === 'preview' ? 'book-open' : 'pencil');
			this.markdownModeToggleBtn.setAttr(
				'aria-label',
				mode === 'preview' ? '阅读模式，点击进入编辑' : '编辑模式，点击进入阅读'
			);
		}
		this.syncBottomBarTitle();
	}

	private async setMarkdownMode(mode: 'source' | 'preview'): Promise<void> {
		const leaf = this.leaf;
		if (!leaf || this.disposed) return;
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file || view.file.extension !== 'md') return;
		const cur = leaf.getViewState();
		if (cur.type !== 'markdown') return;
		await leaf.setViewState({
			type: 'markdown',
			state: { ...cur.state, file: view.file.path, mode },
			active: true
		});
		await leaf.loadIfDeferred?.();
		this.syncModeToggleUi();
		this.requestLeafMeasure();
		this.options.onMarkdownModeChange?.();
	}

	private scheduleSyncModeToggleUiAfterLayout(): void {
		if (this.modeToggleLayoutRaf !== null) return;
		this.modeToggleLayoutRaf = window.requestAnimationFrame(() => {
			this.modeToggleLayoutRaf = null;
			if (this.disposed) return;
			const v = this.leaf?.view;
			if (v instanceof MarkdownView && v.file?.extension === 'md') {
				this.syncModeToggleUi();
			} else {
				this.syncBottomBarTitle();
			}
		});
	}

	private wireRootSplitRouting(): void {
		const ws = this.plugin.app.workspace;
		this.rootSplit.getRoot = () => ws.rootSplit;
		this.rootSplit.getContainer = () => ws.rootSplit;
	}

	private attachLeaf(): void {
		const remove = around(Workspace.prototype, {
			setActiveLeaf: () => {
				return function (this: Workspace) {
					return;
				};
			}
		});
		try {
			this.leaf = this.plugin.app.workspace.createLeafInParent(this.rootSplit, 0);
		} finally {
			remove();
		}
	}

	private wireLeafModeSync(): void {
		const leafRef = this.leaf;
		if (!leafRef) return;
		const syncIfOurLeaf = (patchedLeaf: WorkspaceLeaf) => {
			if (patchedLeaf !== leafRef || this.disposed) return;
			this.syncModeToggleUi();
		};
		this.leafModeSyncUninstall = around(WorkspaceLeaf.prototype, {
			setViewState: (old: WorkspaceLeaf['setViewState']) => {
				return function (this: WorkspaceLeaf, ...args: Parameters<WorkspaceLeaf['setViewState']>) {
					const ret = old.apply(this, args);
					const sync = () => syncIfOurLeaf(this);
					const maybeThenable = ret as PromiseLike<void> | void;
					if (maybeThenable != null && typeof maybeThenable.then === 'function') {
						void maybeThenable.then(sync);
					} else {
						queueMicrotask(sync);
					}
					return ret;
				};
			}
		});
	}

	private readLayerPopoverToken(): string {
		if (this.cachedLayerPopover === null) {
			this.cachedLayerPopover = getComputedStyle(document.documentElement)
				.getPropertyValue('--layer-popover')
				.trim();
		}
		return this.cachedLayerPopover;
	}

	private applyBounds(bounds: FloatingBounds, emit: boolean): void {
		const width = Math.max(MIN_WIDTH, Math.min(bounds.width, window.innerWidth - VIEWPORT_MARGIN));
		const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, window.innerHeight - VIEWPORT_MARGIN));
		/*
		 * 折叠态 CSS 为 height:auto，实际占位远低于存储 height；若用完整 height 算 maxTop，
		 * 会把 top 夹死在「大屏顶部」，表现为无法拖到视口最下方。
		 */
		let viewportClampHeight = height;
		if (this.collapsed) {
			const rh = this.rootEl.getBoundingClientRect().height;
			if (rh > 1) viewportClampHeight = Math.min(height, Math.ceil(rh));
		}
		const maxLeft = Math.max(0, window.innerWidth - width);
		const maxTop = Math.max(0, window.innerHeight - viewportClampHeight);
		const left = Math.min(maxLeft, Math.max(0, bounds.left));
		const top = Math.min(maxTop, Math.max(0, bounds.top));

		this.rootEl.style.width = `${width}px`;
		this.rootEl.style.height = `${height}px`;
		this.rootEl.style.left = `${left}px`;
		this.rootEl.style.top = `${top}px`;

		const layer = this.readLayerPopoverToken();
		/* 便笺叠放：在 popover 基准上加 --csn-sticky-stack，但不得 ≥ calc(var(--layer-slides) - 1) */
		const baseZ = layer
			? `calc(${layer} + var(--csn-sticky-stack, 0))`
			: `calc(var(--layer-slides) - 2 + var(--csn-sticky-stack, 0))`;
		const cap = 'calc(var(--layer-slides) - 2)';
		const capped = `min(${baseZ}, ${cap})`;
		/* 多个便笺同时顶到 cap 时，用 --csn-sticky-active-fine-lift 保证当前激活仍在上层 */
		const zIndex = `calc(${capped} + var(--csn-sticky-active-fine-lift, 0))`;
		this.rootEl.setCssProps({
			position: 'fixed',
			'z-index': zIndex
		});

		this.expandedW = width;
		this.expandedH = height;

		if (emit) {
			this.onBoundsChange(this.getBounds());
		}
		/* 拖动/缩放过程中跳过：每帧触发 leaf.onResize 会让 Markdown 阅读模式反复重排闪烁；
		 * 松手时 onPointerUp 会 flushResizeReflow 做一次最终测量。 */
		if (!this.isDragging && !this.isResizing) {
			this.emitResize();
		}
	}

	private runResizeReflow(): void {
		this.requestLeafMeasure();
	}

	private flushResizeReflow(): void {
		if (this.resizeReflowRaf !== null) {
			cancelAnimationFrame(this.resizeReflowRaf);
			this.resizeReflowRaf = null;
		}
		this.runResizeReflow();
	}

	private scheduleResizeReflow(): void {
		if (this.resizeReflowRaf !== null) return;
		this.resizeReflowRaf = window.requestAnimationFrame(() => {
			this.resizeReflowRaf = null;
			if (!this.disposed) this.runResizeReflow();
		});
	}

	private emitResize(): void {
		this.scheduleResizeReflow();
	}

	private onTitlePointerDown = (e: PointerEvent): void => {
		if (e.button !== 0) return;
		const target = e.target as HTMLElement;
		if (target.closest('.csn-sticky-header-btn')) return;

		this.isDragging = true;
		this.dragPointerId = e.pointerId;
		const r = this.rootEl.getBoundingClientRect();
		this.dragOffsetX = e.clientX - r.left;
		this.dragOffsetY = e.clientY - r.top;
		const sw = this.rootEl.style.width;
		const sh = this.rootEl.style.height;
		const pw = sw ? parseFloat(sw) : NaN;
		const ph = sh ? parseFloat(sh) : NaN;
		this.dragPersistBounds = {
			left: this.rootEl.offsetLeft,
			top: this.rootEl.offsetTop,
			width: Math.max(MIN_WIDTH, Number.isFinite(pw) ? pw : this.expandedW),
			height: Math.max(MIN_HEIGHT, Number.isFinite(ph) ? ph : this.expandedH)
		};
		this.headerEl.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	};

	private onResizePointerDown = (e: PointerEvent): void => {
		if (e.button !== 0) return;
		const handle = e.currentTarget as HTMLElement;
		const dir = handle.dataset.direction as ResizeDirection | undefined;
		if (!dir) return;

		this.isResizing = true;
		this.resizePointerId = e.pointerId;
		this.resizeDirection = dir;
		this.resizeStartX = e.clientX;
		this.resizeStartY = e.clientY;
		this.resizeStartBounds = this.getBounds();
		handle.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	};

	private onPointerMove = (e: PointerEvent): void => {
		if (this.disposed) return;
		if (this.isDragging && e.pointerId === this.dragPointerId) {
			const vis = this.getViewportClampRect();
			const persist =
				this.collapsed && this.dragPersistBounds
					? this.dragPersistBounds
					: { width: vis.width, height: vis.height };
			const left = Math.min(
				Math.max(0, e.clientX - this.dragOffsetX),
				window.innerWidth - vis.width
			);
			const top = Math.min(
				Math.max(0, e.clientY - this.dragOffsetY),
				window.innerHeight - vis.height
			);
			this.applyBounds({ left, top, width: persist.width, height: persist.height }, false);
		} else if (this.isResizing && e.pointerId === this.resizePointerId && this.resizeDirection && this.resizeStartBounds) {
			const b = this.getResizedBounds(e);
			if (b) this.applyBounds(b, false);
		}
	};

	private onPointerUp = (e: PointerEvent): void => {
		if (this.disposed) return;
		if (e.pointerId === this.dragPointerId) {
			const endedDrag = this.isDragging;
			this.isDragging = false;
			this.dragPointerId = null;
			this.dragPersistBounds = null;
			try {
				this.headerEl.releasePointerCapture(e.pointerId);
			} catch {
				/* noop */
			}
			if (endedDrag) {
				this.flushResizeReflow();
				this.onBoundsChange(this.getBounds());
			}
		}
		if (e.pointerId === this.resizePointerId) {
			const endedResize = this.isResizing;
			this.isResizing = false;
			this.resizePointerId = null;
			this.resizeDirection = null;
			this.resizeStartBounds = null;
			try {
				(e.target as HTMLElement)?.releasePointerCapture?.(e.pointerId);
			} catch {
				/* noop */
			}
			if (endedResize) {
				this.flushResizeReflow();
				this.onBoundsChange(this.getBounds());
			}
		}
	};

	private getResizedBounds(event: PointerEvent): FloatingBounds | null {
		if (!this.resizeDirection || !this.resizeStartBounds) return null;

		const deltaX = event.clientX - this.resizeStartX;
		const deltaY = event.clientY - this.resizeStartY;
		const d = this.resizeDirection;

		let left = this.resizeStartBounds.left;
		let top = this.resizeStartBounds.top;
		let width = this.resizeStartBounds.width;
		let height = this.resizeStartBounds.height;

		if (d.includes('e')) width = this.resizeStartBounds.width + deltaX;
		if (d.includes('s')) height = this.resizeStartBounds.height + deltaY;
		if (d.includes('w')) {
			left = this.resizeStartBounds.left + deltaX;
			width = this.resizeStartBounds.width - deltaX;
			if (width < MIN_WIDTH) {
				left -= MIN_WIDTH - width;
				width = MIN_WIDTH;
			}
			if (left < 0) {
				width += left;
				left = 0;
			}
		}
		if (d.includes('n')) {
			top = this.resizeStartBounds.top + deltaY;
			height = this.resizeStartBounds.height - deltaY;
			if (height < MIN_HEIGHT) {
				top -= MIN_HEIGHT - height;
				height = MIN_HEIGHT;
			}
			if (top < 0) {
				height += top;
				top = 0;
			}
		}

		width = Math.max(MIN_WIDTH, width);
		height = Math.max(MIN_HEIGHT, height);
		return { left, top, width, height };
	}

	requestLeafMeasure(): void {
		const leaf = this.leaf;
		if (!leaf) return;
		window.requestAnimationFrame(() => {
			leaf.onResize?.();
			leaf.view?.onResize?.();
		});
	}
}
