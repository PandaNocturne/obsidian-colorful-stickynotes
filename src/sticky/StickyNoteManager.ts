import { normalizePath, Notice, TFile, type App, type EventRef } from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { formatStickyNoteRelativePath } from '../filename-template';
import type { FloatingBounds, SerializedStickyWindow, StickyColorId, WorkspacesFile } from '../types';
import {
	getStickyBgColorFromMetadataCache,
	parseStickyBgColorFromMarkdownSource,
	resolveStickyBgColorForFile
} from '../utils/sticky-bg-from-file';
import { isBlankStickyMarkdown } from '../utils/is-blank-sticky-markdown';
import { BlankStickyDeleteConfirmModal } from '../modals/BlankStickyDeleteConfirmModal';
import { loadWorkspacesFile, saveWorkspacesFile } from '../workspace-store';
import { StickyNotePopover } from './StickyNotePopover';

/** 批量恢复：外壳已挂载，待 setViewState；无会话色时已在创建前解析 YAML 色。 */
type PreparedExistingStickyOpen = {
	pop: StickyNotePopover;
	file: TFile;
	bounds: FloatingBounds;
	savedColor: StickyColorId | undefined;
};

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
	/** “隐藏当前便笺”产生的手动隐藏集合（独立于模式）。 */
	private readonly manualHiddenIds = new Set<string>();
	/** “隐藏其他便笺”模式：仅显示当前，其它隐藏。 */
	private hideOthersMode = false;
	/** “全部隐藏便笺”模式：全部隐藏。 */
	private hideAllMode = false;
	private activePopoverId: string | null = null;
	/** 上一次 bringStickyToFront 命中的 id，用于区分“重新激活隐藏便笺” vs “同一便笺重复激活”。 */
	private lastActivatedPopoverId: string | null = null;
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

	/** 当前已打开浮动便笺对应的笔记路径（用于便笺列表「已打开 / 未打开」筛选）。 */
	getOpenStickyNotePaths(): ReadonlySet<string> {
		const s = new Set<string>();
		for (const pop of this.popovers.values()) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path) s.add(vf.path);
		}
		return s;
	}

	private notifyStickyListOpenIndicators(): void {
		this.plugin.refreshStickyListOpenIndicatorsIfOpen();
	}

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
		let activeId: string | null = null;
		for (const [id, p] of this.popovers) {
			if (p === pop) activeId = id;
		}
		if (activeId) this.activePopoverId = activeId;

		/* 若用户从面板切换激活到一个隐藏便笺：自动取消其隐藏。 */
		const switchedToDifferent = activeId !== null && activeId !== this.lastActivatedPopoverId;
		if (activeId && switchedToDifferent && pop.isHidden()) {
			/* 取消手动隐藏该便笺 */
			this.manualHiddenIds.delete(activeId);
			/* 若处于“全部隐藏”，必须退出，否则永远不可见 */
			if (this.hideAllMode) this.hideAllMode = false;
			/* “隐藏其他”模式下无需退出：切换 active 后它会自然变成“唯一显示”。 */
			this.applyHiddenStateToAll();
		}

		for (const p of this.popovers.values()) {
			p.setActiveHighlight(p === pop);
		}
		pop.setZStackBoost(++this.stickyZStackSeq);
		if (this.hideOthersMode) this.applyHiddenStateToAll();
		this.lastActivatedPopoverId = activeId;
	}

	private bringStickyToFrontById(id: string): void {
		const pop = this.popovers.get(id);
		if (!pop) return;
		this.activePopoverId = id;
		this.bringStickyToFront(pop);
	}

	private ensureActivePopoverId(): string | null {
		if (this.activePopoverId && this.popovers.has(this.activePopoverId)) return this.activePopoverId;
		const next = this.popovers.keys().next().value ?? null;
		this.activePopoverId = next;
		return next;
	}

	/** “隐藏当前”：切换仅隐藏当前便笺（其它显示）。 */
	toggleHideCurrentSticky(): void {
		const id = this.ensureActivePopoverId();
		if (!id) return;
		this.hideCurrentStickyById(id);
	}

	private hideCurrentStickyById(id: string): void {
		if (!this.popovers.has(id)) return;
		/* 规则：隐藏当前为“单独隐藏”，进入前先清空其它隐藏模式，避免叠加导致难以理解。 */
		this.hideAllMode = false;
		this.hideOthersMode = false;
		this.manualHiddenIds.add(id);
		this.applyHiddenStateToAll();
		this.popovers.get(id)?.setActiveHighlight(false);
	}

	/** 仅隐藏其他便笺（固定动作，不做切换）。 */
	hideOthersSticky(): void {
		const id = this.ensureActivePopoverId();
		if (!id) return;
		this.hideOthersRelativeToId(id);
	}

	private hideOthersRelativeToId(id: string): void {
		if (!this.popovers.has(id)) return;
		/* 以指定便笺作为“当前显示”的参照对象，避免与全局 active 竞态。 */
		this.activePopoverId = id;
		/* 规则：隐藏其他为独占模式，进入前清空其它隐藏来源。 */
		this.hideAllMode = false;
		this.manualHiddenIds.clear();
		this.hideOthersMode = true;
		this.applyHiddenStateToAll();
		this.popovers.get(id)?.setActiveHighlight(true);
	}

	/** 显示其他便笺（仅退出“隐藏其他”模式）。 */
	showOthersSticky(): void {
		this.hideOthersMode = false;
		this.hideAllMode = false;
		this.manualHiddenIds.clear();
		this.applyHiddenStateToAll();
	}

	isHideOthersMode(): boolean {
		return this.hideOthersMode;
	}

	hideAllStickies(): void {
		/* 规则：全部隐藏为独占模式，进入前清空其它隐藏来源。 */
		this.hideOthersMode = false;
		this.manualHiddenIds.clear();
		this.hideAllMode = true;
		this.applyHiddenStateToAll();
	}

	showAllStickies(): void {
		this.hideAllMode = false;
		this.hideOthersMode = false;
		this.manualHiddenIds.clear();
		this.applyHiddenStateToAll();
	}

	isHideAllMode(): boolean {
		return this.hideAllMode;
	}

	/** 统一合并“隐藏来源”并写回 DOM。 */
	private applyHiddenStateToAll(): void {
		const activeId = this.activePopoverId;
		for (const [id, pop] of this.popovers) {
			const hidden =
				this.hideAllMode ||
				this.manualHiddenIds.has(id) ||
				(this.hideOthersMode && activeId !== null && id !== activeId);
			pop.setHidden(hidden);
			/* 隐藏便笺后移除激活状态（高亮/细微提升等）。 */
			if (hidden) pop.setActiveHighlight(false);
		}
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
			const row: SerializedStickyWindow = {
				id,
				path: file.path,
				bounds,
				collapsed: pop.getCollapsed(),
				color: pop.getColor(),
				yamlVisible: pop.getYamlVisible()
			};
			if (file.extension === 'md') {
				row.markdownMode = pop.getMarkdownMode();
			}
			ser.push(row);
		}
		ws.windows = ser;
		this.scheduleSaveWorkspaces();
	}

	/** 新建便笺落在当前便笺左侧，间隔 10px；左侧溢出则尝试贴到右侧 */
	private static readonly NEW_STICKY_GAP_PX = 10;
	private static readonly VIEW_MARGIN = 12;

	private offsetBoundsFromSource(source: FloatingBounds): FloatingBounds {
		const gap = StickyNoteManager.NEW_STICKY_GAP_PX;
		const m = StickyNoteManager.VIEW_MARGIN;
		const w = source.width;
		const h = source.height;
		const maxLeft = Math.max(0, window.innerWidth - w);
		const maxTop = Math.max(0, window.innerHeight - h);

		let left = source.left - w - gap;
		let top = source.top;

		if (left < m) {
			const rightOf = source.left + source.width + gap;
			if (rightOf <= maxLeft) left = rightOf;
			else left = Math.min(maxLeft, Math.max(m, left));
		}
		left = Math.min(maxLeft, Math.max(m, left));
		top = Math.min(maxTop, Math.max(m, top));
		return { left, top, width: w, height: h };
	}

	private getDefaultBounds(): FloatingBounds {
		const s = this.plugin.settings;
		const w = Math.max(200, Math.min(1600, s.defaultNewStickyWidth ?? 420));
		const h = Math.max(200, Math.min(1200, s.defaultNewStickyHeight ?? 360));
		const margin = 12;
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

	async addStickyWindow(initial?: Partial<SerializedStickyWindow>, sourcePopover?: StickyNotePopover): Promise<void> {
		const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const defaultTplPath = (this.plugin.settings.defaultTemplatePath || '').trim();

		const pEnsureStickyRoot = (async (): Promise<void> => {
			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder).catch(() => undefined);
			}
		})();

		const pDefaultTemplateBody = defaultTplPath
			? (async (): Promise<string> => {
					const tf = this.app.vault.getAbstractFileByPath(normalizePath(defaultTplPath));
					if (!(tf instanceof TFile)) return '';
					try {
						return await this.app.vault.read(tf);
					} catch {
						return '';
					}
				})()
			: Promise.resolve('');

		const [, body] = await Promise.all([pEnsureStickyRoot, pDefaultTemplateBody]);

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

		const fallbackBg = this.plugin.settings.defaultNewStickyBackground ?? 'yellow';
		const resolvedNewColor =
			initial?.color ?? (sourcePopover ? sourcePopover.getColor() : undefined) ?? fallbackBg;

		/**
		 * 空白新建且需写入背景时，直接把 YAML 放进首次 create。
		 * 含「从便笺旁新建」：若仍依赖随后 processFrontMatter，易与刚打开的编辑区竞态，出现空白闪屏或覆盖已输入内容。
		 */
		let bodyForCreate = body;
		if (resolvedNewColor !== 'default') {
			const raw = bodyForCreate.replace(/^\uFEFF/, '');
			if (parseStickyBgColorFromMarkdownSource(raw) === null && raw.trim() === '') {
				bodyForCreate = `---\n${FM_COLOR_KEY}: ${resolvedNewColor}\n---\n\n`;
			}
		}

		const normalizedPath = normalizePath(path);
		this.plugin.listPrioritizeStickyPath = normalizedPath;

		try {
			await this.app.vault.create(path, bodyForCreate);
		} catch {
			if (this.plugin.listPrioritizeStickyPath === normalizedPath) {
				this.plugin.listPrioritizeStickyPath = null;
			}
			new Notice('无法创建便笺文件');
			return;
		}

		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) {
			if (this.plugin.listPrioritizeStickyPath === normalizedPath) {
				this.plugin.listPrioritizeStickyPath = null;
			}
			new Notice('无法创建便笺文件');
			return;
		}

		/* `create` 已同步触发列表的结构防抖；取消后由下方延迟刷新统一重绘，避免与 openFile 争抢主线程（列表嵌入预览极重） */
		this.plugin.cancelStickyListDebouncedRefresh();

		const id = initial?.id ?? this.newId();
		const color = resolvedNewColor;
		const collapsed = initial?.collapsed ?? false;
		const yamlVisible = initial?.yamlVisible ?? false;

		let bounds: FloatingBounds;
		if (initial?.bounds) {
			bounds = initial.bounds;
		} else if (sourcePopover) {
			bounds = this.offsetBoundsFromSource(sourcePopover.getBounds());
		} else {
			bounds = this.getDefaultBounds();
		}

		const pop = this.createPopoverShell(id, {
			bounds,
			initialColor: color,
			initialCollapsed: collapsed,
			initialYamlVisible: yamlVisible,
			expectMarkdownOpen: true,
			defaultMarkdownMode:
				initial?.markdownMode === 'preview' || initial?.markdownMode === 'source'
					? initial.markdownMode
					: undefined
		});

		this.popovers.set(id, pop);
		this.bringStickyToFront(pop);

		try {
			await this.app.vault.cachedRead(f);
		} catch {
			/* 预热缓存失败时仍尝试打开 */
		}
		await pop.openFile(f);

		/** 与新建 Markdown 叶 `loadIfDeferred` 错开，降低「列表已打开时新建便笺」的卡顿 */
		const LIST_REFRESH_AFTER_NEW_STICKY_MS = 800;
		const scheduleListRefreshSoon = (): void => {
			window.setTimeout(() => {
				requestAnimationFrame(() => this.plugin.refreshStickyListIfOpen());
			}, LIST_REFRESH_AFTER_NEW_STICKY_MS);
		};
		const endMuteAfterList = (p: string): void => {
			window.setTimeout(() => this.plugin.muteStickyListModifyPaths.delete(p), 120);
		};

		const parsedOnDisk = parseStickyBgColorFromMarkdownSource(bodyForCreate.replace(/^\uFEFF/, ''));
		const needsBgWrite = color !== 'default' && parsedOnDisk !== color;

		if (needsBgWrite) {
			this.plugin.muteStickyListModifyPaths.add(f.path);
			await new Promise<void>(resolve =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			void this.setStickyBackgroundColorForFile(f, color)
				.catch(() => undefined)
				.finally(() => {
					scheduleListRefreshSoon();
					endMuteAfterList(f.path);
				});
		} else {
			const fromCache = getStickyBgColorFromMetadataCache(this.app, f);
			const yamlUi = fromCache ?? parsedOnDisk;
			if (yamlUi) pop.setColor(yamlUi);
			scheduleListRefreshSoon();
		}
		this.bringStickyToFront(pop);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
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
			defaultMarkdownMode?: 'preview' | 'source';
			expectMarkdownOpen?: boolean;
		}
	): StickyNotePopover {
		return new StickyNotePopover({
			plugin: this.plugin,
			mountEl: this.mount,
			bounds: extra.bounds,
			defaultMarkdownMode: extra.defaultMarkdownMode ?? this.plugin.settings.defaultViewMode,
			initialColor: extra.initialColor,
			initialCollapsed: extra.initialCollapsed,
			initialYamlVisible: extra.initialYamlVisible,
			expectMarkdownOpen: extra.expectMarkdownOpen,
			bottomBarAutoHide: this.plugin.settings.bottomBarAutoHide,
			viewContentZoom: this.plugin.settings.stickyViewContentZoom,
			onClose: () => void this.handleStickyCloseRequest(id),
			onBoundsChange: () => this.persistOpenWindows(),
			onRequestNewSticky: () => void this.addStickyWindow(undefined, this.popovers.get(id)),
			onColorChange: c => void this.applyColorToFile(id, c),
			onCollapseChange: () => this.persistOpenWindows(),
			onYamlVisibilityChange: () => this.persistOpenWindows(),
			onMarkdownModeChange: () => this.persistOpenWindows(),
			onOpenNoteList: () => void this.plugin.openNoteListView(),
			onDeleteCurrentSticky: () => void this.deleteCurrentStickyNote(id),
			onHideCurrentSticky: () => void this.hideCurrentStickyById(id),
			onHideOthersSticky: () => void this.hideOthersRelativeToId(id),
			onShowOthersSticky: () => void this.showOthersSticky(),
			onHideAllStickies: () => void this.hideAllStickies(),
			onShowAllStickies: () => void this.showAllStickies(),
			onActivate: () => this.bringStickyToFrontById(id)
		});
	}

	private async applyColorToFile(popoverId: string, color: StickyColorId): Promise<void> {
		const pop = this.popovers.get(popoverId);
		const file = pop?.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
		if (!(file instanceof TFile)) return;
		await this.setStickyBackgroundColorForFile(file, color);
	}

	/** 写入 frontmatter 并同步已打开的便笺窗口颜色（便笺列表等也可调用）。 */
	async setStickyBackgroundColorForFile(file: TFile, color: StickyColorId): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, fm => {
			(fm as Record<string, unknown>)[FM_COLOR_KEY] = color;
		});
		for (const pop of this.popovers.values()) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path === file.path) pop.setColor(color);
		}
		this.persistOpenWindows();
	}

	/** 移入库回收站并关闭对应便笺窗口（若有）。 */
	async trashStickyNoteFile(file: TFile): Promise<void> {
		const ids: string[] = [];
		for (const [id, pop] of this.popovers) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path === file.path) ids.push(id);
		}
		for (const id of ids) this.closeSticky(id);
		try {
			await this.app.vault.trash(file, false);
		} catch {
			new Notice('无法删除该便笺');
		}
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
		this.notifyStickyListOpenIndicators();
	}

	/** 路径是否在「便笺文件夹」下（含根目录下同名 .md）。 */
	private isPathUnderStickyFolder(filePath: string): boolean {
		const root = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const p = normalizePath(filePath);
		return p === root || p.startsWith(`${root}/`);
	}

	/** 关闭便笺 DOM，并在需要时将已判定为空白的文件移入回收站。 */
	private finalizeUserCloseSticky(id: string, file: TFile | undefined, trashIfBlank: boolean): void {
		const pop = this.popovers.get(id);
		if (!pop) return;
		pop.destroy();
		this.popovers.delete(id);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
		if (!trashIfBlank || !(file instanceof TFile)) return;
		if (!this.app.vault.getAbstractFileByPath(file.path)) return;
		void this.app.vault.trash(file, false).catch(() => {
			new Notice('无法自动删除空白便笺');
		});
	}

	/** 用户点击关闭：非空白直接关；空白则视设置弹出确认或立即删除。 */
	private async handleStickyCloseRequest(id: string): Promise<void> {
		const pop = this.popovers.get(id);
		if (!pop) return;
		const file =
			pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;

		if (!(file instanceof TFile)) {
			this.finalizeUserCloseSticky(id, file, false);
			return;
		}

		let trashIfBlank = false;
		if (file.extension === 'md' && this.isPathUnderStickyFolder(file.path)) {
			try {
				const raw = await this.app.vault.cachedRead(file);
				trashIfBlank = isBlankStickyMarkdown(raw);
			} catch {
				/* 读取失败则不自动删除 */
			}
		}

		if (!trashIfBlank) {
			this.finalizeUserCloseSticky(id, file, false);
			return;
		}

		if (this.plugin.settings.confirmBlankStickyTrashOnClose) {
			new BlankStickyDeleteConfirmModal(this.app, {
				onConfirm: () => {
					if (!this.popovers.has(id)) return;
					this.finalizeUserCloseSticky(id, file, true);
				}
			}).open();
			return;
		}

		this.finalizeUserCloseSticky(id, file, true);
	}

	/** 让便笺外壳先完成一帧绘制，再执行叶视图 setViewState / 读盘等重活。 */
	private yieldForStickyChromePaint(): Promise<void> {
		return new Promise(resolve => requestAnimationFrame(() => resolve()));
	}

	/** 创建 DOM/叶视图占位，不打开文件。无会话 `color` 时先解析笔记色再挂载，避免首帧默认色闪烁。 */
	private async prepareExistingStickyShell(
		serial: SerializedStickyWindow
	): Promise<PreparedExistingStickyOpen | null> {
		const file = this.app.vault.getAbstractFileByPath(serial.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到便笺：${serial.path}`);
			return null;
		}
		const id = serial.id || this.newId();
		const b = serial.bounds ?? this.getDefaultBounds();
		const savedColor = serial.color;
		const initialColor: StickyColorId =
			savedColor ?? (await resolveStickyBgColorForFile(this.app, file)) ?? 'default';
		const restoredMdMode: 'preview' | 'source' | undefined =
			file.extension === 'md' &&
			(serial.markdownMode === 'preview' || serial.markdownMode === 'source')
				? serial.markdownMode
				: undefined;
		const pop = this.createPopoverShell(id, {
			bounds: b,
			initialColor,
			initialCollapsed: !!serial.collapsed,
			initialYamlVisible: !!serial.yamlVisible,
			expectMarkdownOpen: file.extension === 'md',
			defaultMarkdownMode: restoredMdMode
		});
		this.popovers.set(id, pop);
		return { pop, file, bounds: b, savedColor };
	}

	private async finalizeExistingStickyOpen(
		prepared: PreparedExistingStickyOpen,
		opts: { workspaceActive: boolean }
	): Promise<void> {
		const { pop, file, bounds: b, savedColor } = prepared;
		await pop.openFile(file, { workspaceActive: opts.workspaceActive });
		pop.setBounds(b);
		if (savedColor !== undefined) {
			/* 工作区里记录了便笺颜色，但笔记 frontmatter 无 `colorful-sticky-bg` 时写回，避免仅会话态有颜色。 */
			const yamlColor =
				getStickyBgColorFromMetadataCache(this.app, file) ??
				(await resolveStickyBgColorForFile(this.app, file));
			if (yamlColor === null && savedColor !== 'default') {
				await this.setStickyBackgroundColorForFile(file, savedColor);
			}
		}
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
	}

	async openExistingSticky(serial: SerializedStickyWindow): Promise<void> {
		const prepared = await this.prepareExistingStickyShell(serial);
		if (!prepared) return;
		await this.yieldForStickyChromePaint();
		await this.finalizeExistingStickyOpen(prepared, { workspaceActive: true });
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
		const pending = ws.windows.filter(w => !openPaths.has(w.path));
		if (pending.length === 0) return;
		const preparedList = (
			await Promise.all(pending.map(w => this.prepareExistingStickyShell(w)))
		).filter((p): p is PreparedExistingStickyOpen => p !== null);
		if (preparedList.length === 0) return;
		/* 所有外壳同一帧后再并行加载内容，且不以 active 叶抢主编辑器焦点。 */
		await this.yieldForStickyChromePaint();
		await Promise.all(
			preparedList.map(p => this.finalizeExistingStickyOpen(p, { workspaceActive: false }))
		);
	}

	updateBottomBarsFromSettings(): void {
		for (const p of this.popovers.values()) {
			p.setBottomBarSettings(this.plugin.settings.bottomBarAutoHide);
		}
	}

	updateViewContentZoomFromSettings(): void {
		const z = this.plugin.settings.stickyViewContentZoom;
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
