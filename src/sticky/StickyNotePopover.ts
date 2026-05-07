import { around } from 'monkey-around';
import {
	FileView,
	MarkdownView,
	Menu,
	Plugin,
	Workspace,
	WorkspaceItem,
	WorkspaceLeaf,
	WorkspaceSplit,
	WorkspaceTabs,
	setIcon
} from 'obsidian';
import { getAppCommands } from '../obsidian-commands';
import type { TFile } from 'obsidian';
import type { FloatingBounds, StickyColorId } from '../types';

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
	bottomCommands: Array<{ id: string; icon: string; tooltip: string }>;
	/** 正文区域 zoom（0.5–1），作用于 `.view-content`。 */
	viewContentZoom: number;
	onClose: () => void;
	onBoundsChange: (bounds: FloatingBounds) => void;
	/** 拖动移动增量（同簇窗口一起移动）。 */
	onBoundsDelta?: (delta: { dx: number; dy: number }) => void;
	onDragStart?: () => void;
	onInteractionEnd?: () => void;
	onRequestNewSticky: () => void;
	onColorChange: (c: StickyColorId) => void;
	onCollapseChange?: (c: boolean) => void;
	onYamlVisibilityChange?: (v: boolean) => void;
	onOpenWorkspacePanel: () => void;
	onOpenNoteList: () => void;
	/** 点击底部栏「添加命令」时由管理器打开命令选择。 */
	onRequestAddBottomCommand: () => void;
}

export class StickyNotePopover {
	readonly rootEl: HTMLElement;
	private readonly bodyWrapEl: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly mainColumnEl: HTMLElement;
	private readonly bottomBarEl: HTMLElement;
	private addCommandBtn: HTMLButtonElement;
	private readonly rootSplit: WorkspaceSplit;
	private readonly plugin: Plugin;
	private readonly onBoundsChange: (bounds: FloatingBounds) => void;
	private readonly onBoundsDelta?: (d: { dx: number; dy: number }) => void;
	leaf: WorkspaceLeaf | null = null;
	private isDragging = false;
	private isResizing = false;
	private dragPointerId: number | null = null;
	private resizePointerId: number | null = null;
	private resizeDirection: ResizeDirection | null = null;
	private dragOffsetX = 0;
	private dragOffsetY = 0;
	private lastDragClientX = 0;
	private lastDragClientY = 0;
	private resizeStartX = 0;
	private resizeStartY = 0;
	private resizeStartBounds: FloatingBounds | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeReflowRaf: number | null = null;
	private leafModeSyncUninstall: (() => void) | null = null;
	private modeToggleLayoutRaf: number | null = null;
	private disposed = false;
	private collapsed: boolean;
	private yamlVisible: boolean;
	private modeToggleWrap!: HTMLElement;
	private previewModeBtn!: HTMLButtonElement;
	private sourceModeBtn!: HTMLButtonElement;
	constructor(private readonly options: StickyNotePopoverOptions) {
		this.plugin = options.plugin;
		this.onBoundsChange = options.onBoundsChange;
		this.onBoundsDelta = options.onBoundsDelta;
		this.collapsed = options.initialCollapsed;
		this.yamlVisible = options.initialYamlVisible;

		const mount = options.mountEl;
		/* 勿使用 mod-root：会与主工作区根节点样式冲突，导致叶视图高度为 0、内容不可见 */
		this.rootEl = mount.createDiv({
			cls: 'csn-sticky',
			attr: { 'data-csn-sticky': 'true', 'data-csn-color': options.initialColor }
		});

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

		this.bottomBarEl = this.mainColumnEl.createDiv({ cls: 'csn-sticky-bottombar' });
		this.wireBottomBar();
		this.addCommandBtn = this.createAddCommandButton();

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

	setBottomBarSettings(autoHide: boolean, commands: Array<{ id: string; icon: string; tooltip: string }>): void {
		this.bottomBarEl.empty();
		this.wireBottomBarCommands(commands);
		this.addCommandBtn = this.createAddCommandButton();
		this.bottomBarAutoHide = autoHide;
		this.applyBottomBarAutoHideClass();
	}

	/** 与 HoverNoteLeafPopover#setPreviewScale 相同思路：根节点 CSS 变量 + `.view-content` 的 zoom。 */
	setViewContentZoom(scale: number): void {
		const s = Math.max(0.5, Math.min(1, scale));
		this.rootEl.style.setProperty('--csn-sticky-view-content-zoom', String(s));
	}

	private createAddCommandButton(): HTMLButtonElement {
		const btn = this.bottomBarEl.createEl('button', {
			cls: 'clickable-icon csn-sticky-add-cmd',
			attr: { type: 'button', 'aria-label': '添加命令' }
		});
		setIcon(btn, 'plus-circle');
		this.plugin.registerDomEvent(btn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.options.onRequestAddBottomCommand();
		});
		return btn;
	}

	private bottomBarAutoHide = false;

	private applyBottomBarAutoHideClass(): void {
		this.rootEl.toggleClass('csn-sticky--bar-autohide', this.bottomBarAutoHide);
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
		this.previewModeBtn = this.modeToggleWrap.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '阅读模式' }
		});
		setIcon(this.previewModeBtn, 'book-open');
		this.plugin.registerDomEvent(this.previewModeBtn, 'click', async evt => {
			evt.preventDefault();
			evt.stopPropagation();
			await this.setMarkdownMode('preview');
		});
		this.sourceModeBtn = this.modeToggleWrap.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '编辑模式' }
		});
		setIcon(this.sourceModeBtn, 'pencil');
		this.plugin.registerDomEvent(this.sourceModeBtn, 'click', async evt => {
			evt.preventDefault();
			evt.stopPropagation();
			await this.setMarkdownMode('source');
		});

		const right = this.headerEl.createDiv({ cls: 'csn-sticky-header-right' });
		const yamlBtn = right.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': 'YAML 属性' }
		});
		setIcon(yamlBtn, 'file-json');
		this.plugin.registerDomEvent(yamlBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.yamlVisible = !this.yamlVisible;
			this.applyYamlClass();
			this.options.onYamlVisibilityChange?.(this.yamlVisible);
		});

		const foldBtn = right.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '折叠窗口' }
		});
		setIcon(foldBtn, 'chevrons-down-up');
		this.plugin.registerDomEvent(foldBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.collapsed = !this.collapsed;
			this.applyCollapsedClass();
			this.options.onCollapseChange?.(this.collapsed);
		});

		const moreBtn = right.createEl('button', {
			cls: 'clickable-icon csn-sticky-header-btn',
			attr: { type: 'button', 'aria-label': '更多' }
		});
		setIcon(moreBtn, 'more-horizontal');
		this.plugin.registerDomEvent(moreBtn, 'click', evt => {
			evt.preventDefault();
			evt.stopPropagation();
			this.showMoreMenu(evt, yamlBtn, foldBtn);
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
	}

	private showMoreMenu(evt: MouseEvent, yamlBtn: HTMLButtonElement, foldBtn: HTMLButtonElement): void {
		const menu = new Menu();
		const colors: { id: StickyColorId; label: string }[] = [
			{ id: 'default', label: '默认' },
			{ id: 'yellow', label: '亮黄' },
			{ id: 'pink', label: '粉红' },
			{ id: 'mint', label: '薄荷' },
			{ id: 'blue', label: '天蓝' },
			{ id: 'lavender', label: '淡紫' },
			{ id: 'gray', label: '浅灰' }
		];
		menu.addItem(item =>
			item.setTitle('背景颜色').onClick(subEvt => {
				const colorMenu = new Menu();
				for (const c of colors) {
					colorMenu.addItem(i =>
						i.setTitle(c.label).onClick(() => {
							this.setColor(c.id);
							this.options.onColorChange(c.id);
						})
					);
				}
				if (subEvt instanceof MouseEvent) {
					colorMenu.showAtMouseEvent(subEvt);
				}
			})
		);
		menu.addItem(i =>
			i.setTitle('便笺列表').onClick(() => {
				this.options.onOpenNoteList();
			})
		);
		menu.addItem(i =>
			i.setTitle('工作区面板').onClick(() => {
				this.options.onOpenWorkspacePanel();
			})
		);
		menu.addSeparator();
		menu.addItem(i =>
			i.setTitle('YAML 显示').onClick(() => {
				yamlBtn.click();
			})
		);
		menu.addItem(i =>
			i.setTitle('折叠窗口').onClick(() => {
				foldBtn.click();
			})
		);
		menu.showAtMouseEvent(evt);
	}

	private wireBottomBar(): void {
		this.wireBottomBarCommands(this.options.bottomCommands);
	}

	private wireBottomBarCommands(commands: Array<{ id: string; icon: string; tooltip: string }>): void {
		for (const c of commands) {
			const btn = this.bottomBarEl.createEl('button', {
				cls: 'clickable-icon csn-sticky-bottom-btn',
				attr: { type: 'button', 'aria-label': c.tooltip || c.id }
			});
			setIcon(btn, c.icon);
			this.plugin.registerDomEvent(btn, 'click', async evt => {
				evt.preventDefault();
				evt.stopPropagation();
				await this.runCommandInLeaf(c.id);
			});
		}
	}

	private async runCommandInLeaf(commandId: string): Promise<void> {
		const leaf = this.leaf;
		if (!leaf) return;
		await this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		getAppCommands(this.plugin.app).executeCommandById(commandId);
	}

	private applyCollapsedClass(): void {
		this.rootEl.toggleClass('csn-sticky--collapsed', this.collapsed);
	}

	private applyYamlClass(): void {
		this.rootEl.toggleClass('csn-metadata-on', this.yamlVisible);
	}

	focus(): void {
		this.rootEl.addClass('csn-sticky--active');
		if (this.leaf) {
			void this.plugin.app.workspace.setActiveLeaf(this.leaf, { focus: true });
		}
	}

	getBounds(): FloatingBounds {
		return {
			left: this.rootEl.offsetLeft,
			top: this.rootEl.offsetTop,
			width: this.rootEl.offsetWidth,
			height: this.rootEl.offsetHeight
		};
	}

	setBounds(bounds: FloatingBounds): void {
		this.applyBounds(bounds, false);
	}

	async openFile(file: TFile): Promise<void> {
		const leaf = this.leaf;
		if (!leaf) return;

		if (file.extension === 'md') {
			await leaf.setViewState({
				type: 'markdown',
				state: { file: file.path, mode: this.options.defaultMarkdownMode === 'source' ? 'source' : 'preview' },
				active: true
			});
		} else {
			await leaf.openFile(file, { active: true });
		}

		await leaf.loadIfDeferred?.();
		this.syncModeToggleUi();
		this.requestLeafMeasure();
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
		if (!show || !md) {
			this.previewModeBtn.removeClass('is-active');
			this.sourceModeBtn.removeClass('is-active');
			return;
		}
		const mode = md.getMode();
		this.previewModeBtn.toggleClass('is-active', mode === 'preview');
		this.sourceModeBtn.toggleClass('is-active', mode === 'source');
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
	}

	private scheduleSyncModeToggleUiAfterLayout(): void {
		if (this.modeToggleLayoutRaf !== null) return;
		this.modeToggleLayoutRaf = window.requestAnimationFrame(() => {
			this.modeToggleLayoutRaf = null;
			if (this.disposed) return;
			const v = this.leaf?.view;
			if (v instanceof MarkdownView && v.file?.extension === 'md') {
				this.syncModeToggleUi();
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

	private applyBounds(bounds: FloatingBounds, emit: boolean): void {
		const width = Math.max(MIN_WIDTH, Math.min(bounds.width, window.innerWidth - VIEWPORT_MARGIN));
		const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, window.innerHeight - VIEWPORT_MARGIN));
		const maxLeft = Math.max(0, window.innerWidth - width);
		const maxTop = Math.max(0, window.innerHeight - height);
		const left = Math.min(maxLeft, Math.max(0, bounds.left));
		const top = Math.min(maxTop, Math.max(0, bounds.top));

		this.rootEl.style.width = `${width}px`;
		this.rootEl.style.height = `${height}px`;
		this.rootEl.style.left = `${left}px`;
		this.rootEl.style.top = `${top}px`;

		const layer = getComputedStyle(document.documentElement).getPropertyValue('--layer-popover').trim();
		this.rootEl.setCssProps({
			position: 'fixed',
			'z-index': layer || 'calc(var(--layer-slides) - 2)'
		});

		if (emit) {
			this.onBoundsChange(this.getBounds());
		}
		this.emitResize();
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
		this.lastDragClientX = e.clientX;
		this.lastDragClientY = e.clientY;
		this.options.onDragStart?.();
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
			const width = this.rootEl.offsetWidth;
			const height = this.rootEl.offsetHeight;
			const left = Math.min(Math.max(0, e.clientX - this.dragOffsetX), window.innerWidth - width);
			const top = Math.min(Math.max(0, e.clientY - this.dragOffsetY), window.innerHeight - height);
			const dx = e.clientX - this.lastDragClientX;
			const dy = e.clientY - this.lastDragClientY;
			this.lastDragClientX = e.clientX;
			this.lastDragClientY = e.clientY;
			this.applyBounds({ left, top, width, height }, false);
			this.onBoundsDelta?.({ dx, dy });
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
			try {
				this.headerEl.releasePointerCapture(e.pointerId);
			} catch {
				/* noop */
			}
			if (endedDrag) {
				this.flushResizeReflow();
				this.onBoundsChange(this.getBounds());
				this.options.onInteractionEnd?.();
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
				this.options.onInteractionEnd?.();
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
