import { normalizePath, Notice, TFile, type App, type EventRef } from 'obsidian';
import { t } from '../lang/helpers';
import type ColorfulStickyNotesPlugin from '../main';
import { formatStickyNoteRelativePath } from '../filename-template';
import type {
	FloatingBounds,
	SerializedStickyWindow,
	StickyColorId,
	StickyWorkspace,
	WorkspacesFile
} from '../types';
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
	hidden: boolean;
	stretched: boolean;
};

const FM_COLOR_KEY = 'colorful-sticky-bg';
const FM_ID_KEY = 'colorful-sticky-id';
const FM_ARCHIVED_KEY = 'colorful-sticky-archived';
const STICKY_EDGE_GAP_PX = 5;
const STICKY_TOP_ALIGN_SNAP_PX = 10;

/** 内置命令面板命令；部分 obsidian 包版本未在 `App` 上声明 `commands`。 */
function executeCommandById(app: App, commandId: string): boolean {
	const withCommands = app as unknown as {
		commands?: { executeCommandById: (id: string) => boolean };
	};
	return withCommands.commands?.executeCommandById(commandId) ?? false;
}

export class StickyNoteManager {
	private readonly popovers = new Map<string, StickyNotePopover>();
	/** 绑定图：无向边（吸附后建立），用于连带移动。 */
	private readonly bindings = new Map<string, Set<string>>();
	/** 恢复工作区时暂存的序列化绑定（等目标窗口创建后再连线）。 */
	private readonly pendingBindings = new Map<string, string[]>();
	private dragSession:
		| {
			id: string;
			groupIds: string[];
			lastPrimary: FloatingBounds;
			ctrlDetach: boolean;
			/** 同行吸附时的高度参照（被吸附侧），非发起拖动便笺的高度。 */
			snapHeightSourceId: string | null;
		}
		| null = null;
	private resizeSession:
		| {
			id: string;
			groupIds: string[];
		}
		| null = null;
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
		workspaces: [{ id: 'default', name: t('DEFAULT_WORKSPACE_NAME'), windows: [], updatedAt: Date.now() }]
	};

	constructor(
		private readonly plugin: ColorfulStickyNotesPlugin,
		private readonly app: App
	) { }

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

	hasOpenStickyWindows(): boolean {
		return this.popovers.size > 0;
	}

	hasSavedStickyWindowsInActiveWorkspace(): boolean {
		const ws = this.activeWorkspace();
		return !!ws && ws.windows.length > 0;
	}

	/**
	 * 关闭当前已打开的所有便笺窗口。
	 * @param keepWorkspaceSession true 时仅关闭窗口，不覆盖便笺工作区已保存的 windows（用于下次恢复该便笺工作区布局）。
	 */
	closeAllOpenStickyWindows(keepWorkspaceSession = false): void {
		if (!keepWorkspaceSession) {
			const ids = [...this.popovers.keys()];
			for (const id of ids) {
				this.closeSticky(id);
			}
			return;
		}

		for (const pop of this.popovers.values()) {
			pop.destroy();
		}
		this.popovers.clear();
		this.activePopoverId = null;
		this.lastActivatedPopoverId = null;
		this.notifyStickyListOpenIndicators();
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

	hasAnyHiddenStickies(): boolean {
		if (this.hideAllMode) return this.popovers.size > 0;
		if (this.hideOthersMode && this.popovers.size > 1) return true;
		if (this.manualHiddenIds.size > 0) return true;
		for (const pop of this.popovers.values()) {
			if (pop.isHidden()) return true;
		}
		return false;
	}

	toggleHideAllByCurrentState(): void {
		if (this.hasAnyHiddenStickies()) this.showAllStickies();
		else this.hideAllStickies();
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

	private readStickyIdFromCache(file: TFile): string | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const v = fm?.[FM_ID_KEY];
		return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
	}

	/** 自动补齐便笺 frontmatter：id/archived/bg。 */
	private async ensureStickyFrontmatterDefaults(
		file: TFile,
		opts?: { preferredId?: string; preferredColor?: StickyColorId }
	): Promise<void> {
		const preferredId = opts?.preferredId?.trim();
		const preferredColor = opts?.preferredColor;
		await this.app.fileManager.processFrontMatter(file, fm => {
			const obj = fm as Record<string, unknown>;
			const curId = obj[FM_ID_KEY];
			if (typeof curId !== 'string' || curId.trim().length === 0) {
				obj[FM_ID_KEY] = preferredId && preferredId.length > 0 ? preferredId : this.newId();
			}
			if (typeof obj[FM_ARCHIVED_KEY] !== 'boolean') {
				obj[FM_ARCHIVED_KEY] = false;
			}
			if (
				preferredColor &&
				preferredColor !== 'default' &&
				(typeof obj[FM_COLOR_KEY] !== 'string' || (obj[FM_COLOR_KEY] as string).trim().length === 0)
			) {
				obj[FM_COLOR_KEY] = preferredColor;
			}
		});
	}

	private resolveStickyFileByStickyId(stickyId: string): TFile | null {
		const want = stickyId.trim();
		if (!want) return null;
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const got = this.readStickyIdFromCache(f);
			if (got === want) return f;
		}
		return null;
	}

	private resolveStickyFileForSerialized(serial: SerializedStickyWindow): TFile | null {
		const byPath = this.app.vault.getAbstractFileByPath(serial.path);
		if (byPath instanceof TFile) return byPath;
		if (typeof serial.stickyId === 'string' && serial.stickyId.trim().length > 0) {
			const byId = this.resolveStickyFileByStickyId(serial.stickyId);
			if (byId) return byId;
		}
		return null;
	}

	/** 将当前已打开便笺序列化为工作区快照（不按引用修改内存中的工作区）。 */
	serializeOpenWindowsSnapshot(): SerializedStickyWindow[] {
		const ser: SerializedStickyWindow[] = [];
		for (const [id, pop] of this.popovers) {
			const view = pop.leaf?.view;
			const file = view && 'file' in view ? (view as { file?: TFile }).file : undefined;
			if (!file) continue;
			const bounds = pop.getBounds();
			const popColor = pop.getColor();
			const row: SerializedStickyWindow = {
				id,
				path: file.path,
				stickyId: this.readStickyIdFromCache(file) ?? id,
				bounds,
				collapsed: pop.getCollapsed(),
				hidden: pop.isHidden(),
				stretched: pop.isStretched(),
				bindings: this.getBindingsForId(id),
				yamlVisible: pop.getYamlVisible()
			};
			if (popColor != null) row.color = popColor;
			if (file.extension === 'md') {
				row.markdownMode = pop.getMarkdownMode();
			}
			ser.push(row);
		}
		return ser;
	}

	/**
	 * 以当前窗口布局新建一条命名便笺工作区，并切换为当前活动工作区。
	 * 快照与运行中窗口 id 一致，便于继续编辑时 `persistOpenWindows` 与界面状态一致。
	 */
	async createWorkspaceFromCurrentLayout(name: string): Promise<void> {
		this.persistOpenWindows();
		const trimmed = name.trim();
		const finalName = trimmed || `便笺工作区 ${this.workspaces.workspaces.length + 1}`;
		const snapshot = this.serializeOpenWindowsSnapshot();
		const id = `ws_${Date.now().toString(36)}`;
		const nw: StickyWorkspace = {
			id,
			name: finalName,
			windows: snapshot,
			updatedAt: Date.now()
		};
		this.workspaces.workspaces.push(nw);
		this.workspaces.activeWorkspaceId = id;
		await saveWorkspacesFile(this.plugin, this.workspaces);
	}

	/**
	 * 切换当前使用的工作区并立即按该工作区快照恢复便笺窗口（先落盘当前布局到原工作区）。
	 */
	async switchWorkspaceAndRestore(wsId: string): Promise<void> {
		if (!this.workspaces.workspaces.some(w => w.id === wsId)) return;
		this.persistOpenWindows();
		this.workspaces.activeWorkspaceId = wsId;
		await saveWorkspacesFile(this.plugin, this.workspaces);
		this.closeAllOpenStickyWindows(true);
		await this.restoreWorkspaceWindows();
	}

	async renameWorkspace(wsId: string, name: string): Promise<void> {
		const ws = this.workspaces.workspaces.find(w => w.id === wsId);
		if (!ws) return;
		const next = name.trim();
		if (!next) {
			new Notice(t('NOTICE_NAME_EMPTY'));
			return;
		}
		ws.name = next;
		ws.updatedAt = Date.now();
		await saveWorkspacesFile(this.plugin, this.workspaces);
		new Notice(t('NOTICE_WORKSPACE_RENAMED'));
	}

	private persistOpenWindows(): void {
		const ws = this.activeWorkspace();
		if (!ws) return;
		ws.windows = this.serializeOpenWindowsSnapshot();
		ws.updatedAt = Date.now();
		this.scheduleSaveWorkspaces();
	}

	/** 新建便笺落在当前便笺相邻侧（间隔 gap）；首选侧放不下则换另一侧。 */
	private static readonly NEW_STICKY_GAP_PX = 5;
	private static readonly VIEW_MARGIN = 12;

	private offsetBoundsFromSource(
		source: FloatingBounds,
		prefer: 'left' | 'right'
	): FloatingBounds {
		const gap = StickyNoteManager.NEW_STICKY_GAP_PX;
		const m = StickyNoteManager.VIEW_MARGIN;
		const w = source.width;
		const h = source.height;
		const maxLeft = Math.max(0, window.innerWidth - w);
		const maxTop = Math.max(0, window.innerHeight - h);

		let left: number;
		const top = source.top;

		if (prefer === 'left') {
			left = source.left - w - gap;
			if (left < m) {
				const rightOf = source.left + source.width + gap;
				if (rightOf <= maxLeft) left = rightOf;
				else left = Math.min(maxLeft, Math.max(m, left));
			}
		} else {
			left = source.left + source.width + gap;
			if (left > maxLeft) {
				const leftOf = source.left - w - gap;
				if (leftOf >= m) left = leftOf;
				else left = Math.min(maxLeft, Math.max(m, left));
			}
		}
		const clampedLeft = Math.min(maxLeft, Math.max(m, left));
		const clampedTop = Math.min(maxTop, Math.max(m, top));
		return { left: clampedLeft, top: clampedTop, width: w, height: h };
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
			stickyId: this.readStickyIdFromCache(file) ?? undefined,
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
			new Notice(t('NOTICE_INVALID_FILENAME_TEMPLATE'));
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
			new Notice(t('NOTICE_CANNOT_CREATE_STICKY_FILE'));
			return;
		}

		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) {
			if (this.plugin.listPrioritizeStickyPath === normalizedPath) {
				this.plugin.listPrioritizeStickyPath = null;
			}
			new Notice(t('NOTICE_CANNOT_CREATE_STICKY_FILE'));
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
			bounds = this.offsetBoundsFromSource(
				sourcePopover.getBounds(),
				this.plugin.settings.headerNewStickyAdjacentSide
			);
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
		/* 统一补齐 frontmatter 属性（id / archived / bg）。 */
		await this.ensureStickyFrontmatterDefaults(f, { preferredId: id, preferredColor: color }).catch(() => undefined);
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
			initialColor: StickyColorId | null;
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
			edgeAutoStretchHeight: this.plugin.settings.stickyEdgeAutoStretchHeight,
			headerDoubleClickStretch: this.plugin.settings.stickyHeaderDoubleClickStretch,
			viewContentZoom: this.plugin.settings.stickyViewContentZoom,
			onClose: () => void this.handleStickyCloseRequest(id),
			onBoundsChange: () => this.persistOpenWindows(),
			onRequestNewSticky: () => void this.addStickyWindow(undefined, this.popovers.get(id)),
			onColorChange: c => void this.applyColorToFile(id, c),
			onCollapseChange: () => this.syncBindingPeersChrome(id),
			onStretchChange: () => this.syncBindingPeersChrome(id),
			onYamlVisibilityChange: () => this.persistOpenWindows(),
			onMarkdownModeChange: () => this.persistOpenWindows(),
			onOpenNoteList: () => void this.plugin.openNoteListView(),
			onDeleteCurrentSticky: () => void this.deleteCurrentStickyNote(id),
			onHideCurrentSticky: () => void this.hideCurrentStickyById(id),
			onHideOthersSticky: () => void this.hideOthersRelativeToId(id),
			onShowOthersSticky: () => void this.showOthersSticky(),
			onShowAllStickies: () => void this.showAllStickies(),
			onActivate: () => this.bringStickyToFrontById(id),
			onDragStart: e => this.handleDragStart(id, e),
			onDragMove: (next, e) => this.handleDragMove(id, next, e),
			onDragEnd: e => this.handleDragEnd(id, e),
			onResizeStart: (e, dir) => this.handleResizeStart(id, e, dir),
			onResizeMove: (next, e, dir) => this.handleResizeMove(id, next, e, dir),
			onResizeEnd: e => this.handleResizeEnd(id, e)
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
			new Notice(t('NOTICE_CANNOT_DELETE_STICKY'));
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
					new Notice(t('NOTICE_CANNOT_DELETE_ACTIVE_NOTE_COMMAND'));
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
			new Notice(t('NOTICE_CANNOT_AUTO_DELETE_BLANK_STICKY'));
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
		const file = this.resolveStickyFileForSerialized(serial);
		if (!(file instanceof TFile)) {
			new Notice(`找不到便笺：${serial.path}`);
			return null;
		}
		const id = serial.id || this.newId();
		const b = serial.bounds ?? this.getDefaultBounds();
		const savedColor = serial.color;
		const fromYaml = await resolveStickyBgColorForFile(this.app, file);
		/* 工作区里未存 `color` 时以 YAML 为准；二者皆无时便笺无底色（不强制 `default` 色板）。 */
		const initialColor: StickyColorId | null =
			savedColor !== undefined ? savedColor : fromYaml;
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
		if (Array.isArray(serial.bindings) && serial.bindings.length > 0) {
			this.pendingBindings.set(
				id,
				serial.bindings.filter(x => typeof x === 'string' && x.trim().length > 0)
			);
		}
		this.applyPendingBindingsForId(id);
		await this.ensureStickyFrontmatterDefaults(file, { preferredId: serial.stickyId ?? id }).catch(() => undefined);
		return {
			pop,
			file,
			bounds: b,
			savedColor,
			hidden: !!serial.hidden,
			stretched: !!serial.stretched
		};
	}

	private async finalizeExistingStickyOpen(
		prepared: PreparedExistingStickyOpen,
		opts: { workspaceActive: boolean }
	): Promise<void> {
		const { pop, file, bounds: b, savedColor, hidden, stretched } = prepared;
		await pop.openFile(file, { workspaceActive: opts.workspaceActive });
		pop.setBounds(b);
		/* 恢复会话态全高时勿按视口左右贴边，否则破坏工作区里保存的横向位置与绑定关系 */
		pop.setStretched(stretched, { snapHorizontalToViewport: false });
		pop.setHidden(hidden);
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
		this.syncAllBindingGroupsChromeAfterRestore();
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

	updateEdgeAutoStretchFromSettings(): void {
		const enabled = this.plugin.settings.stickyEdgeAutoStretchHeight;
		for (const p of this.popovers.values()) {
			p.setEdgeAutoStretch(enabled);
		}
	}

	updateHeaderDoubleClickStretchFromSettings(): void {
		const enabled = this.plugin.settings.stickyHeaderDoubleClickStretch;
		for (const p of this.popovers.values()) {
			p.setHeaderDoubleClickStretch(enabled);
		}
	}

	/** 仅同行（横向）绑定参与联动；纵向历史边不入链。 */
	private getBindingsForId(id: string): string[] {
		const set = this.bindings.get(id);
		if (!set || set.size === 0) return [];
		return [...set].filter(other => this.inferBindingAxis(id, other) === 'x');
	}

	/** 仅同步折叠/拉伸状态，不排版、不落盘。返回是否有多窗绑定需要后续 repair。 */
	private applyBindingPeersChromeStateOnly(sourceId: string): boolean {
		const src = this.popovers.get(sourceId);
		if (!src) return false;
		const group = this.resolveBindingGroupIds(sourceId);
		if (group.length <= 1) return false;
		const collapsed = src.getCollapsed();
		const stretched = src.isStretched();
		for (const gid of group) {
			if (gid === sourceId) continue;
			const p = this.popovers.get(gid);
			if (!p) continue;
			if (p.getCollapsed() !== collapsed) {
				p.setCollapsed(collapsed, { silent: true });
			}
			if (p.isStretched() !== stretched) {
				p.setStretched(stretched, { snapHorizontalToViewport: false });
			}
		}
		return true;
	}

	/**
	 * 将 source 便笺的折叠/全高拉伸状态同步到同行绑定组内其它便笺，并可选写入工作区（含 bindings）。
	 * 拉伸同步后不贴视口左右缘（保持同行 left），并在末尾按绑定链重整位置。
	 */
	private syncBindingPeersChrome(sourceId: string, opts?: { persist?: boolean }): void {
		if (!this.applyBindingPeersChromeStateOnly(sourceId)) return;
		/* 与便笺内双 rAF 折叠布局对齐后再修绑定位置，否则物理占位仍是旧边界 */
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.repairBindingGroupRowAfterChromeSync(sourceId);
				if (opts?.persist !== false) {
					this.persistOpenWindows();
				}
			});
		});
	}

	/** 同行绑定在折叠/拉伸同步后：以最左便笺为锚做一次间距与顶/高对齐（含发起者贴边后链上错位的情况）。 */
	private repairBindingGroupRowAfterChromeSync(sourceId: string): void {
		const group = this.resolveBindingGroupIds(sourceId);
		if (group.length <= 1) return;
		let leftmostId = group[0]!;
		let bestL = Number.POSITIVE_INFINITY;
		for (const gid of group) {
			const pop = this.popovers.get(gid);
			if (!pop) continue;
			const l = pop.getBounds().left;
			if (l < bestL) {
				bestL = l;
				leftmostId = gid;
			}
		}
		this.repairBindingAlignmentNear(leftmostId, sourceId);
	}

	/** 恢复工作区后统一各绑定组的折叠/拉伸，并以靠左便笺为准，最后落盘。 */
	private syncAllBindingGroupsChromeAfterRestore(): void {
		const seen = new Set<string>();
		const repairAnchors: string[] = [];
		for (const id of this.popovers.keys()) {
			if (seen.has(id)) continue;
			const group = this.resolveBindingGroupIds(id);
			for (const g of group) seen.add(g);
			if (group.length <= 1) continue;
			let anchorId = group[0]!;
			let bestLeft = Number.POSITIVE_INFINITY;
			for (const gid of group) {
				const pop = this.popovers.get(gid);
				if (!pop) continue;
				const l = pop.getBounds().left;
				if (l < bestLeft) {
					bestLeft = l;
					anchorId = gid;
				}
			}
			if (this.applyBindingPeersChromeStateOnly(anchorId)) {
				repairAnchors.push(anchorId);
			}
		}
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				for (const a of repairAnchors) {
					this.repairBindingGroupRowAfterChromeSync(a);
				}
				this.persistOpenWindows();
			});
		});
	}

	private ensureBindingSet(id: string): Set<string> {
		let s = this.bindings.get(id);
		if (!s) {
			s = new Set<string>();
			this.bindings.set(id, s);
		}
		return s;
	}

	private bindPair(a: string, b: string): void {
		if (a === b) return;
		if (!this.popovers.has(a) || !this.popovers.has(b)) return;
		this.ensureBindingSet(a).add(b);
		this.ensureBindingSet(b).add(a);
	}

	private inferBindingAxis(a: string, b: string): 'x' | 'y' {
		const pa = this.popovers.get(a);
		const pb = this.popovers.get(b);
		if (!pa || !pb) return 'x';
		const ab = pa.getBounds();
		const bb = pb.getBounds();
		const dx = Math.abs((ab.left + ab.width / 2) - (bb.left + bb.width / 2));
		const dy = Math.abs((ab.top + ab.height / 2) - (bb.top + bb.height / 2));
		return dx >= dy ? 'x' : 'y';
	}

	private isAxisBinding(a: string, b: string, axis: 'x' | 'y'): boolean {
		return this.inferBindingAxis(a, b) === axis;
	}

	/**
	 * 单轴限额（发起侧）：仅限制发起吸附的一侧在同轴只保留一个绑定，
	 * 目标侧保留原有邻接，确保可形成相邻链式联动（A->B->C）。
	 */
	private bindPairWithAxis(a: string, b: string, axis: 'x' | 'y'): void {
		if (a === b) return;
		if (!this.popovers.has(a) || !this.popovers.has(b)) return;
		const set = this.bindings.get(a);
		if (set) {
			for (const other of [...set]) {
				if (!this.isAxisBinding(a, other, axis)) continue;
				set.delete(other);
				this.bindings.get(other)?.delete(a);
				if (this.bindings.get(other)?.size === 0) this.bindings.delete(other);
			}
			if (set.size === 0) this.bindings.delete(a);
		}
		this.bindPair(a, b);
	}

	private unbindAll(id: string): void {
		const s = this.bindings.get(id);
		if (!s) return;
		for (const other of s) {
			this.bindings.get(other)?.delete(id);
			if (this.bindings.get(other)?.size === 0) this.bindings.delete(other);
		}
		this.bindings.delete(id);
	}

	private applyPendingBindingsForId(id: string): void {
		const wants = this.pendingBindings.get(id);
		if (!wants || wants.length === 0) return;
		for (const other of wants) {
			if (!this.popovers.has(other)) continue;
			if (this.inferBindingAxis(id, other) !== 'x') continue;
			this.bindPairWithAxis(id, other, 'x');
		}
	}

	private resolveBindingGroupIds(rootId: string): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const q: string[] = [rootId];
		seen.add(rootId);
		while (q.length) {
			const cur = q.shift()!;
			out.push(cur);
			for (const x of this.getBindingsForId(cur)) {
				if (seen.has(x)) continue;
				if (!this.popovers.has(x)) continue;
				seen.add(x);
				q.push(x);
			}
		}
		return out;
	}

	private handleDragStart(id: string, e: PointerEvent): void {
		if (!this.popovers.has(id)) return;
		const ctrl = !!e.ctrlKey;
		if (ctrl) this.unbindAll(id);
		const groupIds = ctrl ? [id] : this.resolveBindingGroupIds(id);
		const primary = this.popovers.get(id)?.getBounds();
		if (!primary) return;
		this.dragSession = {
			id,
			groupIds,
			lastPrimary: primary,
			ctrlDetach: ctrl,
			snapHeightSourceId: null
		};
	}

	private handleDragMove(id: string, next: FloatingBounds, e: PointerEvent): FloatingBounds {
		const session = this.dragSession;
		if (!session || session.id !== id) return next;
		const ctrl = !!e.ctrlKey;
		if (ctrl) {
			if (!session.ctrlDetach) {
				session.ctrlDetach = true;
				this.unbindAll(id);
				session.groupIds = [id];
			}
			session.snapHeightSourceId = null;
			session.lastPrimary = next;
			return next;
		}

		const snapEnabled = this.plugin.settings.stickyAssistAlignSnap;
		const bindEnabled = this.plugin.settings.stickyAssistAlignBind;
		const threshold = Math.max(
			1,
			Math.min(50, Math.round(this.plugin.settings.stickyAssistAlignSnapThresholdPx))
		);

		let adjusted = next;
		let snappedToId: string | null = null;
		let snappedAxis: 'x' | 'y' | null = null;
		if (snapEnabled) {
			const res = this.computeSnapForBounds(id, next, threshold, session.groupIds);
			adjusted = res.bounds;
			snappedToId = res.snappedToId;
			snappedAxis = res.snappedAxis;
		}

		if (bindEnabled && snappedToId && snappedAxis === 'x') {
			this.bindPairWithAxis(id, snappedToId, 'x');
			/* 吸附过程中若产生新绑定，立刻扩展为整链，下一步位移按整组联动。 */
			session.groupIds = this.resolveBindingGroupIds(id);
			const anchor = this.popovers.get(snappedToId);
			if (anchor) {
				const anchorB = anchor.getBounds();
				/* 同行：左右贴靠，顶对齐。 */
				const leftCandidate = anchorB.left - STICKY_EDGE_GAP_PX - adjusted.width;
				const rightCandidate = anchorB.left + anchorB.width + STICKY_EDGE_GAP_PX;
				const useLeft =
					Math.abs(adjusted.left - leftCandidate) <= Math.abs(adjusted.left - rightCandidate);
				adjusted = {
					...adjusted,
					left: useLeft ? leftCandidate : rightCandidate,
					top: anchorB.top,
					/* 高度跟随被吸附侧（绑定参照端），而非发起吸附的便笺 */
					height: anchorB.height
				};
				session.snapHeightSourceId = snappedToId;
				/* 参照端（被吸附便笺）的折叠/拉伸状态同步到本组，落盘在拖动结束统一写。 */
				this.syncBindingPeersChrome(snappedToId, { persist: false });
			}
		}

		const desiredDx = adjusted.left - session.lastPrimary.left;
		const desiredDy = adjusted.top - session.lastPrimary.top;
		let dx = desiredDx;
		let dy = desiredDy;

		/* 吸附后作为整体移动：边界按“整组外接框”夹紧，避免单窗撞边挤压队形。 */
		if (session.groupIds.length > 1 && (dx !== 0 || dy !== 0)) {
			let minLeft = Number.POSITIVE_INFINITY;
			let minTop = Number.POSITIVE_INFINITY;
			let maxRight = Number.NEGATIVE_INFINITY;
			let maxBottom = Number.NEGATIVE_INFINITY;
			const primaryPop = this.popovers.get(id);
			const primaryPhy = primaryPop?.getPhysicalBounds();
			for (const gid of session.groupIds) {
				const pop = this.popovers.get(gid);
				if (!pop) continue;
				/* 折叠态 getBounds() 仍为逻辑展开高，夹紧外接框须用 DOM 实际占位，否则底部 maxDy 错误 */
				const b: FloatingBounds =
					gid === id
						? primaryPhy
							? {
								left: session.lastPrimary.left,
								top: session.lastPrimary.top,
								width: primaryPhy.width,
								height: primaryPhy.height
							}
							: session.lastPrimary
						: pop.getPhysicalBounds();
				minLeft = Math.min(minLeft, b.left);
				minTop = Math.min(minTop, b.top);
				maxRight = Math.max(maxRight, b.left + b.width);
				maxBottom = Math.max(maxBottom, b.top + b.height);
			}
			const minDx = -minLeft;
			const maxDx = window.innerWidth - maxRight;
			const minDy = -minTop;
			const maxDy = window.innerHeight - maxBottom;
			dx = Math.min(maxDx, Math.max(minDx, dx));
			dy = Math.min(maxDy, Math.max(minDy, dy));
		}

		const finalPrimary: FloatingBounds = {
			...adjusted,
			left: session.lastPrimary.left + dx,
			top: session.lastPrimary.top + dy
		};
		session.lastPrimary = finalPrimary;

		if (dx !== 0 || dy !== 0) {
			for (const gid of session.groupIds) {
				if (gid === id) continue;
				const pop = this.popovers.get(gid);
				if (!pop) continue;
				pop.translatePositionBy(dx, dy);
			}
		}

		return finalPrimary;
	}

	private handleDragEnd(id: string, _e: PointerEvent): void {
		if (this.dragSession?.id === id) {
			const heightSrc = this.dragSession.snapHeightSourceId;
			this.repairBindingAlignmentNear(id, heightSrc);
			this.dragSession = null;
			this.persistOpenWindows();
		}
	}

	private handleResizeStart(id: string, _e: PointerEvent, _dir: unknown): void {
		const groupIds = this.resolveBindingGroupIds(id);
		this.resizeSession = { id, groupIds };
	}

	private handleResizeMove(id: string, next: FloatingBounds, _e: PointerEvent, _dir: unknown): FloatingBounds {
		const session = this.resizeSession;
		if (!session || session.id !== id) return next;
		if (session.groupIds.length <= 1) return next;
		/**
		 * 仅同行绑定：沿绑定边 BFS；顶对齐 + 同高，改宽时推挤邻窗 left（不同步宽度）。
		 */
		const visited = new Set<string>([id]);
		const q: string[] = [id];
		while (q.length > 0) {
			const anchorId = q.shift()!;
			const anchorBounds = anchorId === id ? next : this.popovers.get(anchorId)?.getBounds();
			if (!anchorBounds) continue;
			for (const nbId of this.getBindingsForId(anchorId)) {
				if (visited.has(nbId)) continue;
				const pop = this.popovers.get(nbId);
				if (!pop) continue;
				const b = pop.getBounds();
				const anchorCx = anchorBounds.left + anchorBounds.width / 2;
				const nbCx = b.left + b.width / 2;
				const placeLeft = nbCx <= anchorCx;
				const left = placeLeft
					? anchorBounds.left - STICKY_EDGE_GAP_PX - b.width
					: anchorBounds.left + anchorBounds.width + STICKY_EDGE_GAP_PX;
				pop.setBounds({ ...b, left, top: anchorBounds.top, height: anchorBounds.height });
				visited.add(nbId);
				q.push(nbId);
			}
		}
		return next;
	}

	private handleResizeEnd(id: string, _e: PointerEvent): void {
		if (this.resizeSession?.id === id) {
			this.repairBindingSizeOnly(id);
			this.resizeSession = null;
			this.persistOpenWindows();
		}
	}

	private repairBindingSizeOnly(rootId: string): void {
		const root = this.popovers.get(rootId);
		if (!root) return;
		const group = this.resolveBindingGroupIds(rootId);
		if (group.length <= 1) return;
		/* 仅同行：统一高度；不改宽度与 left/top。 */
		const visited = new Set<string>();
		const q: string[] = [rootId];
		visited.add(rootId);
		while (q.length > 0) {
			const anchorId = q.shift()!;
			const anchor = this.popovers.get(anchorId);
			if (!anchor) continue;
			const ab = anchor.getBounds();
			for (const nbId of this.getBindingsForId(anchorId)) {
				if (visited.has(nbId)) continue;
				const nb = this.popovers.get(nbId);
				if (!nb) continue;
				const bb = nb.getBounds();
				nb.setBounds({ ...bb, height: ab.height });
				visited.add(nbId);
				q.push(nbId);
			}
		}
	}

	private computeSnapForBounds(
		movingId: string,
		b: FloatingBounds,
		threshold: number,
		ignoreIds: readonly string[]
	): { bounds: FloatingBounds; snappedToId: string | null; snappedAxis: 'x' | 'y' | null } {
		const ignore = new Set(ignoreIds);
		ignore.add(movingId);
		const left = b.left;
		const top = b.top;
		const right = b.left + b.width;
		const bottom = b.top + b.height;

		let bestDx = 0;
		let bestDy = 0;
		let bestDxAbs = threshold + 1;
		let bestDyAbs = threshold + 1;
		let snappedToId: string | null = null;
		let snappedAxis: 'x' | 'y' | null = null;

		const overlapLen = (a0: number, a1: number, b0: number, b1: number): number =>
			Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
		const hasEnoughOverlap = (overlapPx: number, aLen: number, bLen: number): boolean => {
			const minLen = Math.max(1, Math.min(aLen, bLen));
			/* “同一行/列”判定：要有明显重叠，避免仅擦边就吸附。 */
			const OVERLAP_MIN_PX = 24;
			const OVERLAP_MIN_RATIO = 0.3;
			return overlapPx >= Math.min(OVERLAP_MIN_PX, minLen) || overlapPx / minLen >= OVERLAP_MIN_RATIO;
		};

		for (const [id, pop] of this.popovers) {
			if (ignore.has(id)) continue;
			const ob = pop.getBounds();
			const oLeft = ob.left;
			const oTop = ob.top;
			const oRight = ob.left + ob.width;
			const oBottom = ob.top + ob.height;

			const yOverlap = overlapLen(top, bottom, oTop, oBottom);
			const sameRow = hasEnoughOverlap(yOverlap, b.height, ob.height);
			const topNear = Math.abs(top - oTop) <= STICKY_TOP_ALIGN_SNAP_PX;

			/* 规则：当两窗接近共左/共右且高度接近时，优先吸附“顶部对齐”。 */
			const heightClose = Math.abs(b.height - ob.height) <= Math.max(8, Math.round(threshold * 1.2));
			if (heightClose) {
				const leftEdgeClose = Math.abs(left - oLeft) <= threshold;
				const rightEdgeClose = Math.abs(right - oRight) <= threshold;
				if (leftEdgeClose || rightEdgeClose) {
					const topDelta = oTop - top;
					const topAbs = Math.abs(topDelta);
					if (topAbs <= STICKY_TOP_ALIGN_SNAP_PX && topAbs < bestDyAbs) {
						bestDyAbs = topAbs;
						bestDy = topDelta;
						snappedToId = id;
						snappedAxis = 'x';
					}
				}
			}

			const candidatesX = [
				{ dx: oLeft - left, target: id },
				{ dx: oRight - left, target: id },
				{ dx: oLeft - STICKY_EDGE_GAP_PX - right, target: id },
				{ dx: oRight + STICKY_EDGE_GAP_PX - left, target: id }
			];
			if (sameRow && topNear) {
				for (const c of candidatesX) {
					const a = Math.abs(c.dx);
					if (a <= threshold && a < bestDxAbs) {
						bestDxAbs = a;
						bestDx = c.dx;
						snappedToId = c.target;
						snappedAxis = 'x';
					}
				}
			}
		}

		return {
			bounds: { ...b, left: b.left + bestDx, top: b.top + bestDy },
			snappedToId,
			snappedAxis
		};
	}

	private repairBindingAlignmentNear(rootId: string, heightSourceId?: string | null): void {
		const root = this.popovers.get(rootId);
		if (!root) return;
		const group = this.resolveBindingGroupIds(rootId);
		if (group.length <= 1) return;
		const refPop =
			heightSourceId && this.popovers.has(heightSourceId) ? this.popovers.get(heightSourceId) : null;
		const refLogical = refPop?.getBounds();
		const rowHeight = refLogical?.height;
		/* 折叠态 getBounds() 为逻辑展开高；仅双方均为展开态时才同步高度，避免误写折叠占位 */
		if (
			refLogical &&
			refPop &&
			heightSourceId &&
			rootId !== heightSourceId &&
			!refPop.getCollapsed() &&
			!root.getCollapsed()
		) {
			const rb = root.getBounds();
			root.setBounds({ ...rb, height: refLogical.height });
		}
		const visited = new Set<string>();
		const q: string[] = [rootId];
		visited.add(rootId);
		while (q.length > 0) {
			const anchorId = q.shift()!;
			const anchor = this.popovers.get(anchorId);
			if (!anchor) continue;
			const abPhy = anchor.getPhysicalBounds();
			const abLogic = anchor.getBounds();
			const syncH = rowHeight ?? abLogic.height;
			for (const nbId of this.getBindingsForId(anchorId)) {
				if (visited.has(nbId)) continue;
				const nb = this.popovers.get(nbId);
				if (!nb) continue;
				const bbPhy = nb.getPhysicalBounds();
				const bbLogic = nb.getBounds();
				/* 左右判定与间距用 DOM 实际占位；落盘仍用逻辑宽高（折叠时保留 expanded） */
				const placeLeft = bbPhy.left + bbPhy.width / 2 <= abPhy.left + abPhy.width / 2;
				const left = placeLeft
					? abPhy.left - STICKY_EDGE_GAP_PX - bbPhy.width
					: abPhy.left + abPhy.width + STICKY_EDGE_GAP_PX;
				const next: FloatingBounds = { ...bbLogic, left, top: abPhy.top };
				if (!nb.getCollapsed() && !anchor.getCollapsed()) {
					next.height = syncH;
				}
				nb.setBounds(next);
				visited.add(nbId);
				q.push(nbId);
			}
		}
	}

	onunload(): void {
		for (const p of this.popovers.values()) {
			p.destroy();
		}
		this.popovers.clear();
	}
}
