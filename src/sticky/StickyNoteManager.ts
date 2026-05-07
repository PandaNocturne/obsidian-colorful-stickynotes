import { normalizePath, Notice, TFile, type App, type EventRef } from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { formatStickyNoteRelativePath } from '../filename-template';
import type { FloatingBounds, SerializedStickyWindow, StickyColorId, WorkspacesFile } from '../types';
import { loadWorkspacesFile, saveWorkspacesFile } from '../workspace-store';
import { matchWidthsIfVerticalPair, snapBounds, type SnapPartner } from './snap-groups';
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
	private saveTimer: number | null = null;
	/** 等待内置删除命令完成时挂起的 vault 监听，避免重复注册。 */
	private pendingDeleteListener: EventRef | null = null;
	private pendingDeleteSafetyTimer: number | null = null;
	private dragCluster = new Set<string>();
	private draggingId: string | null = null;

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
		await this.openExistingSticky({
			id: this.newId(),
			path: file.path,
			bounds: this.getDefaultBounds(),
			color: 'default'
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
		await pop.openFile(f);
		this.applyFrontmatterColorIfAny(f, pop);
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
			onBoundsDelta: d => this.onBoundsDelta(id, d),
			onDragStart: () => this.onDragStart(id),
			onInteractionEnd: () => this.runSnapForAll(),
			onRequestNewSticky: () => void this.addStickyWindow(),
			onColorChange: c => void this.applyColorToFile(id, c),
			onCollapseChange: () => this.persistOpenWindows(),
			onYamlVisibilityChange: () => this.persistOpenWindows(),
			onOpenNoteList: () => void this.plugin.openNoteListView(),
			onDeleteCurrentSticky: () => void this.deleteCurrentStickyNote(id)
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

	private applyFrontmatterColorIfAny(file: TFile, pop: StickyNotePopover): void {
		const c = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FM_COLOR_KEY];
		if (typeof c === 'string' && c) {
			const allowed: StickyColorId[] = ['default', 'yellow', 'pink', 'mint', 'blue', 'lavender', 'gray'];
			if (allowed.includes(c as StickyColorId)) {
				pop.setColor(c as StickyColorId);
			}
		}
	}

	private onDragStart(id: string): void {
		this.draggingId = id;
		this.dragCluster = this.computeMovementCluster(id);
	}

	private computeMovementCluster(leaderId: string): Set<string> {
		const visited = new Set<string>();
		const stack = [leaderId];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (visited.has(cur)) continue;
			visited.add(cur);
			const bc = this.popovers.get(cur)?.getBounds();
			if (!bc) continue;
			for (const [oid, op] of this.popovers) {
				if (oid === cur || visited.has(oid)) continue;
				const ob = op.getBounds();
				if (this.areSnapped(bc, ob)) stack.push(oid);
			}
		}
		return visited;
	}

	private onBoundsDelta(fromId: string, d: { dx: number; dy: number }): void {
		if (d.dx === 0 && d.dy === 0) return;
		if (!this.draggingId || fromId !== this.draggingId) return;
		for (const id of this.dragCluster) {
			if (id === fromId) continue;
			const pop = this.popovers.get(id);
			if (!pop) continue;
			const b = pop.getBounds();
			pop.setBounds({ ...b, left: b.left + d.dx, top: b.top + d.dy });
		}
	}

	private runSnapForAll(): void {
		this.draggingId = null;
		this.dragCluster.clear();

		const ids = [...this.popovers.keys()];
		const partners: SnapPartner[] = ids.map(id => ({
			id,
			bounds: this.popovers.get(id)!.getBounds()
		}));

		for (const id of ids) {
			const pop = this.popovers.get(id)!;
			let b = pop.getBounds();
			const others = partners.filter(p => p.id !== id);
			b = snapBounds(b, others, id);
			pop.setBounds(b);
			const pr = partners.find(p => p.id === id);
			if (pr) pr.bounds = b;
		}

		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = ids[i]!;
				const b = ids[j]!;
				const ba = this.popovers.get(a)!.getBounds();
				const bb = this.popovers.get(b)!.getBounds();
				if (this.areSnapped(ba, bb)) {
					const mw = matchWidthsIfVerticalPair(ba, bb);
					if (mw.a !== ba.width || mw.b !== bb.width) {
						this.popovers.get(a)!.setBounds({ ...ba, width: mw.a });
						this.popovers.get(b)!.setBounds({ ...bb, width: mw.b });
					}
				}
			}
		}

		this.persistOpenWindows();
	}

	private areSnapped(a: FloatingBounds, b: FloatingBounds): boolean {
		const ar = a.left + a.width;
		const br = b.left + b.width;
		return (
			Math.abs(a.left - br) <= 16 ||
			Math.abs(ar - b.left) <= 16 ||
			Math.abs(a.top + a.height - b.top) <= 16 ||
			Math.abs(b.top + b.height - a.top) <= 16
		);
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
		if (this.draggingId === id) {
			this.draggingId = null;
			this.dragCluster.clear();
		}
		this.persistOpenWindows();
	}

	async openExistingSticky(serial: SerializedStickyWindow): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(serial.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到便笺：${serial.path}`);
			return;
		}
		const id = serial.id || this.newId();
		const b = serial.bounds ?? this.getDefaultBounds();
		const pop = this.createPopoverShell(id, {
			bounds: b,
			initialColor: serial.color ?? 'default',
			initialCollapsed: !!serial.collapsed,
			initialYamlVisible: !!serial.yamlVisible
		});
		this.popovers.set(id, pop);
		await pop.openFile(file);
		this.applyFrontmatterColorIfAny(file, pop);
		pop.setBounds(b);
		if (serial.color) pop.setColor(serial.color);
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
		for (const w of ws.windows) {
			if (openPaths.has(w.path)) continue;
			await this.openExistingSticky(w);
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
