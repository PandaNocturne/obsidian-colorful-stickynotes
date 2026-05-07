import { normalizePath, Notice, TFile, type App, type EventRef } from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { formatStickyNoteRelativePath } from '../filename-template';
import type { FloatingBounds, SerializedStickyWindow, StickyColorId, WorkspacesFile } from '../types';
import { getStickyBgColorFromMetadataCache, resolveStickyBgColorForFile } from '../utils/sticky-bg-from-file';
import { loadWorkspacesFile, saveWorkspacesFile } from '../workspace-store';
import { StickyNotePopover } from './StickyNotePopover';

const FM_COLOR_KEY = 'colorful-sticky-bg';

/** 内置命令面板命令；部分 obsidian 包版本未在 `App` 上声明 `commands`。 */
function executeCommandById(app: App, commandId: string): boolean {
	const withCommands = app as unknown as {
		commands?: { executeCommandById: (id: string) => boolean };
	};
	return withCommands.commands?.executeCommandById(commandId) ?? false;
}

export class StickyNoteManager {
	private readonly popovers = new Map<string, StickyNotePopover>();
	private readonly mount = document.body;
	/** 便笺间 z-index 微调，单调递增即可。 */
	private stickyZStackSeq = 0;
	private saveTimer: number | null = null;
	/** 等待内置删除命令完成时挂起的 vault 监听，避免重复注册。 */
	private pendingDeleteListener: EventRef | null = null;
	private pendingDeleteSafetyTimer: number | null = null;

	workspaces: WorkspacesFile = {
		version: 1,
		activeWorkspaceId: 'default',
		workspaces: [{ id: 'default', name: '默认工作区', windows: [] }]
	};

	constructor(
		private readonly plugin: ColorfulStickyNotesPlugin,
		private readonly app: App
	) {}

	async init(): Promise<void> {
		this.workspaces = await loadWorkspacesFile(this.plugin);
		this.plugin.registerEvent(
			this.app.workspace.on('active-leaf-change', leaf => {
				if (!leaf) return;
				for (const pop of this.popovers.values()) {
					if (pop.leaf === leaf) {
						this.bringStickyToFront(pop);
						return;
					}
				}
				for (const p of this.popovers.values()) {
					p.setActiveHighlight(false);
				}
			})
		);
	}

	private bringStickyToFront(pop: StickyNotePopover): void {
		for (const p of this.popovers.values()) {
			p.setActiveHighlight(p === pop);
		}
		pop.setZStackBoost(++this.stickyZStackSeq);
	}

	private bringStickyToFrontById(id: string): void {
		const pop = this.popovers.get(id);
		if (!pop) return;
		this.bringStickyToFront(pop);
	}

	private scheduleSaveWorkspaces(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void saveWorkspacesFile(this.plugin, this.workspaces);
		}, 400);
	}

	activeWorkspace(): import('../types').StickyWorkspace | undefined {
		return this.workspaces.workspaces.find(w => w.id === this.workspaces.activeWorkspaceId);
	}

	private persistOpenWindows(): void {
		const ws = this.activeWorkspace();
		if (!ws) return;
		const ser: SerializedStickyWindow[] = [];
		for (const [id, pop] of this.popovers) {
			const view = pop.leaf?.view;
			const file = view && 'file' in view ? (view as { file?: TFile }).file : undefined;
			if (!file) continue;
			const bounds = pop.getBounds();
			ser.push({
				id,
				path: file.path,
				bounds,
				collapsed: pop.getCollapsed(),
				color: pop.getColor(),
				yamlVisible: pop.getYamlVisible()
			});
		}
		ws.windows = ser;
		this.scheduleSaveWorkspaces();
	}

	private getDefaultBounds(): FloatingBounds {
		const w = 420;
		const h = 360;
		const s = this.plugin.settings;
		const margin = 12;
		if (s.defaultPositionMode === 'custom') {
			return {
				left: Math.max(0, s.defaultPositionX),
				top: Math.max(0, s.defaultPositionY),
				width: w,
				height: h
			};
		}
		return {
			left: Math.max(margin, Math.round((window.innerWidth - w) / 2)),
			top: Math.max(margin, Math.round((window.innerHeight - h) / 2)),
			width: w,
			height: h
		};
	}

	async openStickyForFile(file: TFile): Promise<void> {
		for (const pop of this.popovers.values()) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path === file.path) {
				pop.focus();
				return;
			}
		}
		/* 勿传 color: 'default'，否则会覆盖 YAML 中的 colorful-sticky-bg。 */
		await this.openExistingSticky({
			id: this.newId(),
			path: file.path,
			bounds: this.getDefaultBounds()
		});
	}

	async addStickyWindow(initial?: Partial<SerializedStickyWindow>): Promise<void> {
		const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
		const tmpl =
			(this.plugin.settings.filenameTemplate || '').trim() || 'YYYY/YYYY-MM-DD';
		const relativeFormatted = formatStickyNoteRelativePath(tmpl);
		if (relativeFormatted === 'invalid-format') {
			new Notice('便笺文件名格式无效，请在设置中检查 Moment 格式');
			return;
		}
		let relativeNoExt = relativeFormatted;
		let path = await this.pathForStickyRelative(folder, relativeNoExt);
		let n = 1;
		while (await this.app.vault.adapter.exists(path)) {
			relativeNoExt = this.suffixStickyRelativePath(relativeFormatted, n);
			path = await this.pathForStickyRelative(folder, relativeNoExt);
			n += 1;
		}
		let body = '';
		const tpl = (this.plugin.settings.defaultTemplatePath || '').trim();
		if (tpl) {
			const tf = this.app.vault.getAbstractFileByPath(normalizePath(tpl));
			if (tf instanceof TFile) {
				try {
					body = await this.app.vault.read(tf);
				} catch {
					/* noop */
				}
			}
		}
		await this.app.vault.create(path, body);

		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) {
			new Notice('无法创建便笺文件');
			return;
		}

		const id = initial?.id ?? this.newId();
		const color = initial?.color ?? 'yellow';
		const collapsed = initial?.collapsed ?? false;
		const yamlVisible = initial?.yamlVisible ?? false;

		const pop = this.createPopoverShell(id, {
			bounds: initial?.bounds ?? this.getDefaultBounds(),
			initialColor: color,
			initialCollapsed: collapsed,
			initialYamlVisible: yamlVisible
		});

		this.popovers.set(id, pop);
		await this.yieldForStickyChromePaint();
		await pop.openFile(f);
		const y = await resolveStickyBgColorForFile(this.app, f);
		if (y) pop.setColor(y);
		this.persistOpenWindows();
	}

	/**
	 * `relativeNoExt` 为相对便笺根目录的路径（无 .md），可含子文件夹，如 `2026/2026-05-07`。
	 */
	private async pathForStickyRelative(rootFolder: string, relativeNoExt: string): Promise<string> {
		const segments = relativeNoExt
			.split('/')
			.map(s => s.trim())
			.filter(s => s.length > 0);
		if (segments.length === 0) {
			return normalizePath(`${rootFolder}/note.md`);
		}
		const base = segments[segments.length - 1]!;
		const parents = segments.slice(0, -1);
		let current = rootFolder;
		for (const d of parents) {
			current = normalizePath(`${current}/${d}`);
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.createFolder(current).catch(() => undefined);
			}
		}
		return normalizePath(`${current}/${base}.md`);
	}

	private suffixStickyRelativePath(relativeNoExt: string, n: number): string {
		const parts = relativeNoExt.split('/').filter(s => s.trim().length > 0);
		if (parts.length === 0) return `note-${n}`;
		const last = parts[parts.length - 1]!;
		parts[parts.length - 1] = `${last}-${n}`;
		return parts.join('/');
	}

	private newId(): string {
		if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
		return `csn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
	}

	private createPopoverShell(
		id: string,
		extra: {
			bounds: FloatingBounds;
			initialColor: StickyColorId;
			initialCollapsed: boolean;
			initialYamlVisible: boolean;
		}
	): StickyNotePopover {
		return new StickyNotePopover({
			plugin: this.plugin,
			mountEl: this.mount,
			bounds: extra.bounds,
			defaultMarkdownMode: this.plugin.settings.defaultViewMode,
			initialColor: extra.initialColor,
			initialCollapsed: extra.initialCollapsed,
			initialYamlVisible: extra.initialYamlVisible,
			bottomBarAutoHide: this.plugin.settings.bottomBarAutoHide,
			viewContentZoom: this.plugin.settings.viewContentZoom,
			onClose: () => this.closeSticky(id),
			onBoundsChange: () => this.persistOpenWindows(),
			onRequestNewSticky: () => void this.addStickyWindow(),
			onColorChange: c => void this.applyColorToFile(id, c),
			onCollapseChange: () => this.persistOpenWindows(),
			onYamlVisibilityChange: () => this.persistOpenWindows(),
			onOpenNoteList: () => void this.plugin.openNoteListView(),
			onDeleteCurrentSticky: () => void this.deleteCurrentStickyNote(id),
			onActivate: () => this.bringStickyToFrontById(id)
		});
	}

	private async applyColorToFile(popoverId: string, color: StickyColorId): Promise<void> {
		const pop = this.popovers.get(popoverId);
		const file = pop?.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
		if (!(file instanceof TFile)) return;
		await this.app.fileManager.processFrontMatter(file, fm => {
			(fm as Record<string, unknown>)[FM_COLOR_KEY] = color;
		});
		this.persistOpenWindows();
	}

	private clearPendingDeleteListener(): void {
		if (this.pendingDeleteListener !== null) {
			this.app.vault.offref(this.pendingDeleteListener);
			this.pendingDeleteListener = null;
		}
		if (this.pendingDeleteSafetyTimer !== null) {
			window.clearTimeout(this.pendingDeleteSafetyTimer);
			this.pendingDeleteSafetyTimer = null;
		}
	}

	private deleteCurrentStickyNote(id: string): void {
		const pop = this.popovers.get(id);
		const leaf = pop?.leaf ?? null;
		const file =
			pop?.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
		if (!(file instanceof TFile) || !leaf) {
			this.closeSticky(id);
			return;
		}

		this.clearPendingDeleteListener();
		const targetPath = file.path;
		this.pendingDeleteListener = this.app.vault.on('delete', f => {
			if (f.path !== targetPath) return;
			this.clearPendingDeleteListener();
			this.closeSticky(id);
		});

		void Promise.resolve(this.app.workspace.setActiveLeaf(leaf, { focus: true })).then(
			() => {
				const ok = executeCommandById(this.app, 'app:delete-file');
				if (!ok) {
					this.clearPendingDeleteListener();
					new Notice('无法执行「删除当前笔记」命令');
					return;
				}
				this.pendingDeleteSafetyTimer = window.setTimeout(() => this.clearPendingDeleteListener(), 120_000);
			},
			() => {
				this.clearPendingDeleteListener();
			}
		);
	}

	closeSticky(id: string): void {
		const pop = this.popovers.get(id);
		if (!pop) return;
		pop.destroy();
		this.popovers.delete(id);
		this.persistOpenWindows();
	}

	/** 让便笺外壳先完成一帧绘制，再执行叶视图 setViewState / 读盘等重活。 */
	private yieldForStickyChromePaint(): Promise<void> {
		return new Promise(resolve => requestAnimationFrame(() => resolve()));
	}

	async openExistingSticky(serial: SerializedStickyWindow): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(serial.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到便笺：${serial.path}`);
			return;
		}
		const id = serial.id || this.newId();
		const b = serial.bounds ?? this.getDefaultBounds();
		const savedColor = serial.color;
		/* 不在创建窗口前 await 读 YAML：外壳先出现，颜色在 openFile 后再对齐（可能短暂为默认色）。 */
		const pop = this.createPopoverShell(id, {
			bounds: b,
			initialColor: savedColor ?? 'default',
			initialCollapsed: !!serial.collapsed,
			initialYamlVisible: !!serial.yamlVisible
		});
		this.popovers.set(id, pop);
		await this.yieldForStickyChromePaint();
		await pop.openFile(file);
		pop.setBounds(b);
		if (savedColor === undefined) {
			const after =
				getStickyBgColorFromMetadataCache(this.app, file) ?? (await resolveStickyBgColorForFile(this.app, file));
			if (after) pop.setColor(after);
		}
		this.persistOpenWindows();
	}

	async restoreWorkspaceWindows(): Promise<void> {
		const ws = this.activeWorkspace();
		const openPaths = new Set<string>();
		for (const pop of this.popovers.values()) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf) openPaths.add(vf.path);
		}
		if (!ws || ws.windows.length === 0) {
			await this.addStickyWindow();
			return;
		}
		let yieldBeforeNext = false;
		for (const w of ws.windows) {
			if (openPaths.has(w.path)) continue;
			if (yieldBeforeNext) {
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			}
			await this.openExistingSticky(w);
			yieldBeforeNext = true;
		}
	}

	updateBottomBarsFromSettings(): void {
		for (const p of this.popovers.values()) {
			p.setBottomBarSettings(this.plugin.settings.bottomBarAutoHide);
		}
	}

	updateViewContentZoomFromSettings(): void {
		const z = this.plugin.settings.viewContentZoom;
		for (const p of this.popovers.values()) {
			p.setViewContentZoom(z);
		}
	}

	onunload(): void {
		for (const p of this.popovers.values()) {
			p.destroy();
		}
		this.popovers.clear();
	}
}
