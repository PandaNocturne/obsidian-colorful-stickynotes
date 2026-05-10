import { normalizePath, Notice, TFile, WorkspaceLeaf, type App, type EventRef } from 'obsidian';
import { t } from '../lang/helpers';
import type ColorfulStickyNotesPlugin from '../main';
import { formatStickyNoteRelativePath } from '../filename-template';
import type {
	FloatingBounds,
	SerializedStickyWindow,
	StickyColorId,
	StickyGridSpan,
	StickyWorkspace,
	WorkspacesFile
} from '../types';
import {
	getStickyBgColorFromMetadataCache,
	parseStickyBgColorFromMarkdownSource,
	resolveStickyBgColorForFile
} from '../utils/sticky-bg-from-file';
import { isBlankStickyMarkdown } from '../utils/is-blank-sticky-markdown';
import { resolveStickyArchivedForFile } from '../utils/sticky-archived-from-file';
import { BlankStickyDeleteConfirmModal } from '../modals/BlankStickyDeleteConfirmModal';
import {
	defaultWorkspacesFile,
	loadWorkspacesFile,
	newStickyWorkspaceId,
	saveWorkspacesFile
} from '../workspace-store';
import { StickyNotePopover } from './StickyNotePopover';

/** 打开已有便笺前先建好外壳；正式 `setViewState`/打开文件后再与磁盘 YAML 等对齐全貌。 */
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
const STICKY_BOTTOM_ALIGN_SNAP_PX = 10;
const GRID_LAYOUT_ITERATIONS = 4;
/** 网格测量兜底：列宽 / 行高的下限（像素）。 */
const GRID_FALLBACK_MIN_W = 280;
const GRID_FALLBACK_MIN_H = 200;
/** 暂时关闭网格跨行/跨列（Ctrl 缩放后占多格）及持久化；改为 `true` 恢复。 */
const ENABLE_GRID_MULTI_CELL_SPAN = false;

/** 调用 Obsidian 未公开的 `App.commands.executeCommandById`（类型上仅约束为 App）。 */
function executeCommandById(app: App, commandId: string): boolean {
	const withCommands = app as unknown as {
		commands?: { executeCommandById: (id: string) => boolean };
	};
	return withCommands.commands?.executeCommandById(commandId) ?? false;
}

export class StickyNoteManager {
	private readonly popovers = new Map<string, StickyNotePopover>();
	/** 便笺两两绑定（同组拖动 / 吸附排版）。 */
	private readonly bindings = new Map<string, Set<string>>();
	private readonly stickyGridSpan = new Map<string, StickyGridSpan>();
	/** 自快照恢复时暂存的绑定同伴 id（同伴窗口尚未创建完）。 */
	private readonly pendingBindings = new Map<string, string[]>();
	private dragSession:
		| {
			id: string;
			groupIds: string[];
			lastPrimary: FloatingBounds;
			ctrlDetach: boolean;
			/**
			 * Ctrl-trigger + grouped + detach at drag start: keep binding graph until drag end;
			 * unbind only if released outside snap reach of bound peers.
			 */
			deferBindingClear?: boolean;
			/** 横向吸附时高度对齐所参照的同伴窗口 id。 */
			snapHeightSourceId: string | null;
			/** 纵向吸附时宽度对齐所参照的同伴窗口 id。 */
			snapWidthSourceId: string | null;
		}
		| null = null;
	private resizeSession:
		| {
			id: string;
			groupIds: string[];
			/** 按住 Ctrl 缩放时是否按跨多格网格伸展处理。 */
			ctrlSpanningResize: boolean;
		}
		| null = null;
	private readonly mount = document.body;
	/** 便笺叠放次序，递增后写入 CSS z-index，保证后激活的更靠上。 */
	private stickyZStackSeq = 0;
	/** 用户手动隐藏的便笺 id（与「隐藏其他」「隐藏全部」独立）。 */
	private readonly manualHiddenIds = new Set<string>();
	/** 「隐藏其他」：仅保留当前活动便笺可见。 */
	private hideOthersMode = false;
	/** 「隐藏全部」：所有便笺视觉上隐藏。 */
	private hideAllMode = false;
	private activePopoverId: string | null = null;
	/** 上次因激活而置顶的便笺 id（与 `activePopoverId` 配合判断是否切换了窗口）。 */
	private lastActivatedPopoverId: string | null = null;
	private saveTimer: number | null = null;
	/** 工作区切换世代：每次 begin 递增；finalize/restore 若发现已过期则中止，避免快速连点覆盖数据。 */
	private workspaceSwitchGeneration = 0;
	/** 串行化 finalize，避免两次切换的 flush/close/restore 交错执行。 */
	private workspaceSwitchTail: Promise<void> = Promise.resolve();
	/**
	 * 与 {@link workspaceSwitchGeneration} 对齐：存在时表示切换/关闭流程进行中，
	 * 禁止常规持久化与列表写操作，直至 finalize / deselect 在 finally 中解除。
	 */
	private workspacePersistFreezeToken: number | null = null;
	/** 执行删除命令后监听 vault `delete`，异步确认关闭便笺窗口。 */
	private pendingDeleteListener: EventRef | null = null;
	private pendingDeleteSafetyTimer: number | null = null;

	workspaces: WorkspacesFile = defaultWorkspacesFile();

	constructor(
		private readonly plugin: ColorfulStickyNotesPlugin,
		private readonly app: App
	) { }

	/** 当前浮动便笺打开的文件路径集合（供列表「已打开」等标识）。 */
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
	 * 关闭所有浮动便笺窗口。
	 * @param keepWorkspaceSession 为 true 时保留工作区会话：仅 destroy 各窗口并清空映射，不逐个 `closeSticky`（用于工作区切换等批量拆解）。
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

		/* 若切换到另一张便笺且目标当前为隐藏态，视为用户主动唤回。 */
		const switchedToDifferent = activeId !== null && activeId !== this.lastActivatedPopoverId;
		if (activeId && switchedToDifferent && pop.isHidden()) {
			/* 从「手动隐藏」集合中移除。 */
			this.manualHiddenIds.delete(activeId);
			/* 若正处于「隐藏全部」，一并解除以便可操作。 */
			if (this.hideAllMode) this.hideAllMode = false;
			/* 重新计算各窗口隐藏态与高亮。 */
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
		const first = this.popovers.keys().next();
		const next: string | null = first.done ? null : first.value;
		this.activePopoverId = next;
		return next;
	}

	/** 切换隐藏当前活动便笺（记入手动隐藏集合）。 */
	toggleHideCurrentSticky(): void {
		const id = this.ensureActivePopoverId();
		if (!id) return;
		this.hideCurrentStickyById(id);
	}

	private hideCurrentStickyById(id: string): void {
		if (!this.popovers.has(id)) return;
		/* 单窗隐藏时退出「隐藏全部」「隐藏其他」，避免状态互相覆盖。 */
		this.hideAllMode = false;
		this.hideOthersMode = false;
		this.manualHiddenIds.add(id);
		this.applyHiddenStateToAll();
		this.popovers.get(id)?.setActiveHighlight(false);
	}

	/** 隐藏除当前活动便笺以外的所有便笺。 */
	hideOthersSticky(): void {
		const id = this.ensureActivePopoverId();
		if (!id) return;
		this.hideOthersRelativeToId(id);
	}

	private hideOthersRelativeToId(id: string): void {
		if (!this.popovers.has(id)) return;
		/* 以指定 id 作为当前活动便笺。 */
		this.activePopoverId = id;
		/* 清空手动隐藏并进入「隐藏其他」模式。 */
		this.hideAllMode = false;
		this.manualHiddenIds.clear();
		this.hideOthersMode = true;
		this.applyHiddenStateToAll();
		this.popovers.get(id)?.setActiveHighlight(true);
	}

	/** 结束「隐藏其他」，恢复显示被隐藏的便笺。 */
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
		/* 「隐藏全部」前退出「隐藏其他」并清空手动隐藏集合。 */
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

	/** 根据模式位更新各便笺 DOM 的隐藏态与高亮。 */
	private applyHiddenStateToAll(): void {
		const activeId = this.activePopoverId;
		for (const [id, pop] of this.popovers) {
			const hidden =
				this.hideAllMode ||
				this.manualHiddenIds.has(id) ||
				(this.hideOthersMode && activeId !== null && id !== activeId);
			pop.setHidden(hidden);
			/* 隐藏窗口不必保留「活动」高亮。 */
			if (hidden) pop.setActiveHighlight(false);
		}
	}

	/** 取消防抖后立即写入磁盘，避免与切换/面板保存交错或延迟覆盖。 */
	async flushWorkspacesToDisk(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await saveWorkspacesFile(this.plugin, this.workspaces);
	}

	private scheduleSaveWorkspaces(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flushWorkspacesToDisk();
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

	/** 补齐便笺 frontmatter：`id`、`archived`、背景色等默认值。 */
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
			const colorVal = obj[FM_COLOR_KEY];
			if (
				preferredColor &&
				preferredColor !== 'default' &&
				(typeof colorVal !== 'string' || colorVal.trim().length === 0)
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

	/** 将当前打开的浮动便笺序列化为工作区快照条目（含边界、绑定、模式等）。 */
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
				bindings: this.getAllBindingsForId(id),
				yamlVisible: pop.getYamlVisible()
			};
			if (popColor != null) row.color = popColor;
			if (ENABLE_GRID_MULTI_CELL_SPAN) {
				const gs = this.stickyGridSpan.get(id);
				if (gs) row.gridSpan = { ...gs };
			}
			if (file.extension === 'md') {
				row.markdownMode = pop.getMarkdownMode();
			}
			ser.push(row);
		}
		return ser;
	}

	/**
	 * 从当前浮动布局新建一条工作区并设为活动区。
	 * 会先 `persistOpenWindows` 再快照；新条目 id 由 `newStickyWorkspaceId` 生成。
	 */
	async createWorkspaceFromCurrentLayout(name: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		this.persistOpenWindows();
		const trimmed = name.trim();
		const n = this.workspaces.workspaces.length + 1;
		const finalName = trimmed || t('WS_NEW_WORKSPACE_AUTO_NAME', { n });
		const snapshot = this.serializeOpenWindowsSnapshot();
		const id = newStickyWorkspaceId();
		const nw: StickyWorkspace = {
			id,
			name: finalName,
			windows: snapshot,
			updatedAt: Date.now()
		};
		this.workspaces.workspaces.push(nw);
		this.workspaces.activeWorkspaceId = id;
		await this.flushWorkspacesToDisk();
	}

	/**
	 * 持久化当前布局后新建空白工作区（无窗口快照）并写入列表；
	 * 不切换活动工作区，不改变已打开的浮动便笺。
	 * @param options.name 留空或仅空白则使用自动命名（便笺工作区 n）。
	 */
	async createBlankWorkspace(options?: { name?: string; remark?: string }): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		this.persistOpenWindows();
		const id = newStickyWorkspaceId();
		const n = this.workspaces.workspaces.length + 1;
		const nameTrim = options?.name?.trim() ?? '';
		const nw: StickyWorkspace = {
			id,
			name: nameTrim ? nameTrim : t('WS_NEW_WORKSPACE_AUTO_NAME', { n }),
			windows: [],
			updatedAt: Date.now()
		};
		const remarkTrim = options?.remark?.trim() ?? '';
		if (remarkTrim) nw.remark = remarkTrim;
		this.workspaces.workspaces.push(nw);
		await this.flushWorkspacesToDisk();
	}

	/**
	 * 保存当前布局并将活动工作区 id 切到 wsId（内存立即生效，可马上刷新面板高亮）。
	 * 须再调用 {@link finalizeWorkspaceSwitch} 完成落盘与便笺窗口恢复。
	 * @returns 本次切换的世代号；失败返回 null。
	 */
	beginWorkspaceSwitchForUi(wsId: string): number | null {
		if (!this.workspaces.workspaces.some(w => w.id === wsId)) return null;
		if (this.isWorkspacePersistFrozen()) return null;
		this.persistOpenWindows({ bypassFreeze: true });
		const token = ++this.workspaceSwitchGeneration;
		this.workspacePersistFreezeToken = token;
		this.workspaces.activeWorkspaceId = wsId;
		return token;
	}

	private isStaleWorkspaceSwitch(token: number): boolean {
		return token !== this.workspaceSwitchGeneration;
	}

	private isWorkspacePersistFrozen(): boolean {
		return this.workspacePersistFreezeToken !== null;
	}

	private endWorkspacePersistFreeze(token: number): void {
		if (this.workspacePersistFreezeToken === token) {
			this.workspacePersistFreezeToken = null;
		}
	}

	/** 便笺工作区列表或磁盘写入（非切换流程内）是否允许；冻结中时提示并返回 false。 */
	private assertWorkspaceMetaMutable(): boolean {
		if (this.isWorkspacePersistFrozen()) return false;
		return true;
	}

	/** 落盘活动工作区、关闭当前浮动便笺并按快照恢复（在 beginWorkspaceSwitchForUi 之后调用）。 */
	async finalizeWorkspaceSwitch(token: number): Promise<void> {
		const job = this.workspaceSwitchTail.then(async () => {
			try {
				if (this.isStaleWorkspaceSwitch(token)) return;
				await this.flushWorkspacesToDisk();
				if (this.isStaleWorkspaceSwitch(token)) return;
				this.closeAllOpenStickyWindows(true);
				if (this.isStaleWorkspaceSwitch(token)) return;
				await this.restoreWorkspaceWindows(token);
			} finally {
				this.endWorkspacePersistFreeze(token);
			}
		});
		this.workspaceSwitchTail = job.catch(() => undefined);
		await job;
	}

	/**
	 * 完整切换：等价于 beginWorkspaceSwitchForUi + finalizeWorkspaceSwitch。
	 */
	async switchWorkspaceAndRestore(wsId: string): Promise<void> {
		const token = this.beginWorkspaceSwitchForUi(wsId);
		if (token === null) return;
		await this.finalizeWorkspaceSwitch(token);
	}

	/**
	 * 再次单击当前活动区：把当前浮动布局写回该区快照后取消选中并关闭浮动便笺（与删除当前区时的「无选中」行为一致）。
	 * 经 workspaceSwitchTail 排队，避免与进行中的切换交错。
	 */
	async deselectActiveStickyWorkspace(): Promise<void> {
		const job = this.workspaceSwitchTail.then(async () => {
			if (this.workspaces.activeWorkspaceId === null) return;
			if (this.isWorkspacePersistFrozen()) return;
			this.persistOpenWindows({ bypassFreeze: true });
			if (this.saveTimer !== null) {
				window.clearTimeout(this.saveTimer);
				this.saveTimer = null;
			}
			const token = ++this.workspaceSwitchGeneration;
			this.workspacePersistFreezeToken = token;
			try {
				this.workspaces.activeWorkspaceId = null;
				this.closeAllOpenStickyWindows(true);
				await this.flushWorkspacesToDisk();
			} finally {
				this.endWorkspacePersistFreeze(token);
			}
		});
		this.workspaceSwitchTail = job.then(
			() => undefined,
			() => undefined
		);
		await job.catch(() => undefined);
	}

	async updateWorkspace(wsId: string, name: string, remark: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		const ws = this.workspaces.workspaces.find(w => w.id === wsId);
		if (!ws) return;
		const next = name.trim();
		if (!next) {
			new Notice(t('NOTICE_NAME_EMPTY'));
			return;
		}
		ws.name = next;
		const r = remark.trim();
		if (r) ws.remark = r;
		else delete ws.remark;
		ws.updatedAt = Date.now();
		await this.flushWorkspacesToDisk();
		new Notice(t('NOTICE_WORKSPACE_UPDATED'));
	}

	/** 复制工作区快照为新条目；不切换活动工作区。若源为当前活动区，先持久化当前打开的便笺布局再复制。 */
	async duplicateWorkspace(wsId: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		const ws = this.workspaces.workspaces.find(w => w.id === wsId);
		if (!ws) return;
		if (this.workspaces.activeWorkspaceId === wsId) {
			this.persistOpenWindows();
		}
		const id = newStickyWorkspaceId();
		const windowsCopy: SerializedStickyWindow[] = structuredClone(ws.windows);
		const nw: StickyWorkspace = {
			id,
			name: t('WS_DUPLICATE_NAME', { name: ws.name }),
			windows: windowsCopy,
			updatedAt: Date.now()
		};
		if (ws.remark) nw.remark = ws.remark;
		this.workspaces.workspaces.push(nw);
		await this.flushWorkspacesToDisk();
		new Notice(t('NOTICE_WORKSPACE_COPIED'));
	}

	/**
	 * 从主列表移除并落盘。有窗口快照的工作区移入 `trash`；**空白工作区**（`windows` 为空）不入回收站，等同直接删除。
	 * 删除当前活动区时：不自动选中其它区（避免当前浮动布局误写入另一区快照），关闭浮动便笺且不向任何区 persist。
	 * 主列表为空时恢复内置默认工作区（保留 `trash` 中条目）。
	 */
	async deleteStickyWorkspace(wsId: string): Promise<void> {
		const job = this.workspaceSwitchTail.then(async () => {
			if (this.isWorkspacePersistFrozen()) return;
			this.workspaceSwitchGeneration++;
			const idx = this.workspaces.workspaces.findIndex(x => x.id === wsId);
			if (idx < 0) return;
			const [removed] = this.workspaces.workspaces.splice(idx, 1);
			if (!removed) return;
			const isBlank = !removed.windows || removed.windows.length === 0;
			if (!isBlank) {
				removed.updatedAt = Date.now();
				this.workspaces.trash.unshift(removed);
			}
			const wasActive = this.workspaces.activeWorkspaceId === wsId;
			if (this.workspaces.workspaces.length === 0) {
				const fresh = defaultWorkspacesFile();
				this.workspaces.workspaces = fresh.workspaces;
				this.workspaces.activeWorkspaceId = fresh.activeWorkspaceId;
				this.closeAllOpenStickyWindows(true);
			} else if (wasActive) {
				this.workspaces.activeWorkspaceId = null;
				this.closeAllOpenStickyWindows(true);
			}
			if (this.saveTimer !== null) {
				window.clearTimeout(this.saveTimer);
				this.saveTimer = null;
			}
			await this.flushWorkspacesToDisk();
			if (this.plugin.settings.noteListWorkspaceFilterId === wsId) {
				this.plugin.settings.noteListWorkspaceFilterId = null;
				void this.plugin.saveSettings();
			}
			this.plugin.refreshStickyListIfOpen();
			new Notice(
				isBlank ? t('NOTICE_BLANK_WORKSPACE_DELETED') : t('NOTICE_WORKSPACE_MOVED_TO_TRASH')
			);
		});
		this.workspaceSwitchTail = job.catch(() => undefined);
		await job;
	}

	/** 从回收站还原到主列表末尾。 */
	async restoreStickyWorkspaceFromTrash(wsId: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		const tIdx = this.workspaces.trash.findIndex(w => w.id === wsId);
		if (tIdx < 0) return;
		const [w] = this.workspaces.trash.splice(tIdx, 1);
		if (!w) return;
		if (this.workspaces.workspaces.some(x => x.id === w.id)) return;
		w.updatedAt = Date.now();
		this.workspaces.workspaces.push(w);
		await this.flushWorkspacesToDisk();
		new Notice(t('NOTICE_WORKSPACE_RESTORED'));
		this.plugin.refreshStickyListIfOpen();
	}

	/** 从回收站永久删除快照。 */
	async permanentlyDeleteStickyWorkspaceFromTrash(wsId: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		const before = this.workspaces.trash.length;
		this.workspaces.trash = this.workspaces.trash.filter(x => x.id !== wsId);
		if (this.workspaces.trash.length === before) return;
		await this.flushWorkspacesToDisk();
		if (this.plugin.settings.noteListWorkspaceFilterId === wsId) {
			this.plugin.settings.noteListWorkspaceFilterId = null;
			void this.plugin.saveSettings();
		}
		new Notice(t('NOTICE_WORKSPACE_PERMANENTLY_DELETED'));
		this.plugin.refreshStickyListIfOpen();
	}

	/** 将工作区拖到另一张卡片前时：插入到 `beforeId` 之前。 */
	async reorderWorkspaceBefore(draggedId: string, beforeId: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		if (draggedId === beforeId) return;
		const list = this.workspaces.workspaces;
		const fromIdx = list.findIndex(w => w.id === draggedId);
		const toIdx = list.findIndex(w => w.id === beforeId);
		if (fromIdx < 0 || toIdx < 0) return;
		const next = [...list];
		const [moved] = next.splice(fromIdx, 1);
		if (moved === undefined) return;
		const insertAt = next.findIndex(w => w.id === beforeId);
		if (insertAt < 0) return;
		next.splice(insertAt, 0, moved);
		this.workspaces.workspaces = next;
		await this.flushWorkspacesToDisk();
	}

	/** 拖到「新建」格上时移到列表末尾。 */
	async reorderWorkspaceToEnd(draggedId: string): Promise<void> {
		if (!this.assertWorkspaceMetaMutable()) return;
		const list = this.workspaces.workspaces;
		const fromIdx = list.findIndex(w => w.id === draggedId);
		if (fromIdx < 0) return;
		const next = [...list];
		const [moved] = next.splice(fromIdx, 1);
		if (moved === undefined) return;
		next.push(moved);
		this.workspaces.workspaces = next;
		await this.flushWorkspacesToDisk();
	}

	private persistOpenWindows(opts?: { bypassFreeze?: boolean }): void {
		if (!opts?.bypassFreeze && this.isWorkspacePersistFrozen()) return;
		const ws = this.activeWorkspace();
		if (!ws) return;
		ws.windows = this.serializeOpenWindowsSnapshot();
		ws.updatedAt = Date.now();
		this.scheduleSaveWorkspaces();
	}

	/** 在现有便笺旁新建时的间距（像素），与 `offsetBoundsFromSource` 一致。 */
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

	async openStickyForFile(
		file: TFile,
		opts?: { markdownMode?: 'preview' | 'source' }
	): Promise<void> {
		for (const pop of this.popovers.values()) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path === file.path) {
				pop.focus();
				if (file.extension === 'md' && opts?.markdownMode) {
					await pop.setMarkdownViewMode(opts.markdownMode);
				}
				return;
			}
		}
		/* `color: default` 仅表示壳层不设色，实际底色仍可由 YAML `colorful-sticky-bg` 决定。 */
		await this.openExistingSticky({
			id: this.newId(),
			path: file.path,
			stickyId: this.readStickyIdFromCache(file) ?? undefined,
			bounds: this.getDefaultBounds(),
			...(opts?.markdownMode ? { markdownMode: opts.markdownMode } : {})
		});
	}

	/** 关闭该笔记对应的浮动便笺窗口（与从窗口关闭一致，含空白便笺确认）。 */
	async closeStickyWindowForFile(file: TFile): Promise<void> {
		const ids: string[] = [];
		for (const [id, pop] of this.popovers) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path === file.path) ids.push(id);
		}
		for (const id of ids) {
			await this.handleStickyCloseRequest(id);
		}
	}

	/**
	 * 在便笺中打开该文件（行为同 openStickyForFile），并关闭主工作区中仍打开该文件的叶标签（不含便笺浮动叶）。
	 */
	async moveFileToStickyWindow(
		file: TFile,
		opts?: { markdownMode?: 'preview' | 'source' }
	): Promise<void> {
		await this.openStickyForFile(file, opts);
		const stickyLeaves = new Set<WorkspaceLeaf>();
		for (const p of this.popovers.values()) {
			if (p.leaf) stickyLeaves.add(p.leaf);
		}
		const norm = normalizePath(file.path);
		const toDetach: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves(leaf => {
			if (stickyLeaves.has(leaf)) return;
			const v = leaf.view;
			const vf = v && 'file' in v ? (v as { file?: TFile }).file : undefined;
			if (vf && normalizePath(vf.path) === norm) {
				toDetach.push(leaf);
			}
		});
		for (const leaf of toDetach) {
			leaf.detach();
		}
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
		 * 若需要非默认底色且正文尚无 YAML：先在创建内容里写入 frontmatter，
		 * 避免空文件 `create` 后再 `processFrontMatter` 与列表刷新竞态导致闪烁或丢色。
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

		/* `create` 会触发 vault 事件；在 openFile 与列表刷新交错前先取消防抖刷新，减少重复整表渲染。 */
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
			/* 预热缓存失败不影响后续打开。 */
		}
		await pop.openFile(f);

		/** 新建后稍延再刷新列表，给 Markdown `loadIfDeferred` 与元数据一轮稳定时间。 */
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
		/* 再次确保 frontmatter 含 sticky id、archived、背景等字段。 */
		await this.ensureStickyFrontmatterDefaults(f, { preferredId: id, preferredColor: color }).catch(() => undefined);
		this.bringStickyToFront(pop);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
	}

	/**
	 * 将 `relativeNoExt`（无扩展名、可含子路径）解析为库内 `.md` 绝对路径，例如 `2026/2026-05-07`。
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

	/** 路径已存在时，在末级文件名后加 `-n` 以生成不冲突的相对路径（仍含父目录）。 */
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
			onToggleArchiveCurrentSticky: () => void this.toggleArchiveCurrentStickyForPopover(id),
			onActivate: () => this.bringStickyToFrontById(id),
			onDragStart: e => this.handleDragStart(id, e),
			onDragMove: (next, e) => this.handleDragMove(id, next, e),
			onDragEnd: e => this.handleDragEnd(id, e),
			onResizeStart: (e, dir) => this.handleResizeStart(id, e, dir),
			onResizeMove: (next, e, dir) => this.handleResizeMove(id, next, e, dir),
			onResizeEnd: e => this.handleResizeEnd(id, e),
			allowViewportHeightStretch: () => {
				if (!ENABLE_GRID_MULTI_CELL_SPAN) return true;
				const g = this.stickyGridSpan.get(id);
				return !(g && g.rowMin < g.rowMax);
			}
		});
	}

	private async applyColorToFile(popoverId: string, color: StickyColorId): Promise<void> {
		const pop = this.popovers.get(popoverId);
		const file = pop?.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
		if (!(file instanceof TFile)) return;
		await this.setStickyBackgroundColorForFile(file, color);
	}

	/** 写入 frontmatter 中的便笺背景色，并同步所有打开该文件的便笺壳颜色。 */
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

	/** 写入 frontmatter `colorful-sticky-archived`（归档标记）。 */
	async setStickyArchivedForFile(file: TFile, archived: boolean): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, fm => {
			(fm as Record<string, unknown>)[FM_ARCHIVED_KEY] = archived;
		});
	}

	private async toggleArchiveCurrentStickyForPopover(popoverId: string): Promise<void> {
		const pop = this.popovers.get(popoverId);
		const file =
			pop?.leaf?.view && 'file' in pop.leaf.view
				? (pop.leaf.view as { file?: TFile }).file
				: undefined;
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const cur = await resolveStickyArchivedForFile(this.app, file);
		const nextArchived = !cur;
		await this.setStickyArchivedForFile(file, nextArchived);
		if (nextArchived) this.closeSticky(popoverId);
	}

	/** 关闭所有展示该文件的便笺窗口并将文件移入回收站。 */
	async trashStickyNoteFile(file: TFile): Promise<void> {
		const ids: string[] = [];
		for (const [id, pop] of this.popovers) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf?.path === file.path) ids.push(id);
		}
		for (const id of ids) this.closeSticky(id);
		try {
			await this.app.fileManager.trashFile(file);
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
		this.stickyGridSpan.delete(id);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
	}

	/** 路径是否位于配置的便笺根目录下（用于空白 .md 关闭时是否自动回收）。 */
	private isPathUnderStickyFolder(filePath: string): boolean {
		const root = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const p = normalizePath(filePath);
		return p === root || p.startsWith(`${root}/`);
	}

	/** 用户关闭便笺：拆掉 DOM/叶视图并持久化；可选将空白笔记送入回收站。 */
	private finalizeUserCloseSticky(id: string, file: TFile | undefined, trashIfBlank: boolean): void {
		const pop = this.popovers.get(id);
		if (!pop) return;
		pop.destroy();
		this.popovers.delete(id);
		this.stickyGridSpan.delete(id);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
		if (!trashIfBlank || !(file instanceof TFile)) return;
		if (!this.app.vault.getAbstractFileByPath(file.path)) return;
		void this.app.fileManager.trashFile(file).catch(() => {
			new Notice(t('NOTICE_CANNOT_AUTO_DELETE_BLANK_STICKY'));
		});
	}

	/** 处理用户点击关闭：若在便笺目录且内容为空白，可按设置确认后自动回收。 */
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
				/* 读取失败则不视为空白自动删除。 */
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

	/** 从快照准备便笺壳（DOM + leaf），暂不 finalize 打开；用于批量恢复时并行创建。 */
	private async prepareExistingStickyShell(
		serial: SerializedStickyWindow
	): Promise<PreparedExistingStickyOpen | null> {
		const file = this.resolveStickyFileForSerialized(serial);
		if (!(file instanceof TFile)) {
			new Notice(`找不到便笺文件：${serial.path}`);
			return null;
		}
		const id = serial.id || this.newId();
		const b = serial.bounds ?? this.getDefaultBounds();
		const savedColor = serial.color;
		const fromYaml = await resolveStickyBgColorForFile(this.app, file);
		/* 快照带 `color` 但正文尚无 YAML 色：打开后再写入 frontmatter；`default` 表示不强行上色。 */
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
		if (ENABLE_GRID_MULTI_CELL_SPAN && this.isValidPersistedGridSpan(serial.gridSpan)) {
			const span = serial.gridSpan;
			this.stickyGridSpan.set(id, span);
		}
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
		opts: { workspaceActive: boolean; persistLayout?: boolean; switchToken?: number }
	): Promise<void> {
		if (opts.switchToken !== undefined && this.isStaleWorkspaceSwitch(opts.switchToken)) return;
		const { pop, file, bounds: b, savedColor, hidden, stretched } = prepared;
		await pop.openFile(file, { workspaceActive: opts.workspaceActive });
		if (opts.switchToken !== undefined && this.isStaleWorkspaceSwitch(opts.switchToken)) return;
		pop.setBounds(b);
		/* 恢复布局：拉伸态不参与水平贴边吸附，避免绑定组互相打乱。 */
		pop.setStretched(stretched, { snapHorizontalToViewport: false });
		pop.setHidden(hidden);
		if (savedColor !== undefined) {
			/* 若缓存与正文仍无 `colorful-sticky-bg`，用快照色补写 frontmatter。 */
			const yamlColor =
				getStickyBgColorFromMetadataCache(this.app, file) ??
				(await resolveStickyBgColorForFile(this.app, file));
			if (yamlColor === null && savedColor !== 'default') {
				await this.setStickyBackgroundColorForFile(file, savedColor);
			}
		}
		if (opts.switchToken !== undefined && this.isStaleWorkspaceSwitch(opts.switchToken)) return;
		/* 批量恢复时禁止在此处 persist：并行完成顺序会导致快照只含部分窗口并覆盖磁盘。 */
		if (opts.persistLayout !== false) {
			this.persistOpenWindows();
		}
		this.notifyStickyListOpenIndicators();
	}

	async openExistingSticky(serial: SerializedStickyWindow): Promise<void> {
		const prepared = await this.prepareExistingStickyShell(serial);
		if (!prepared) return;
		await this.finalizeExistingStickyOpen(prepared, { workspaceActive: true });
	}

	/** 按当前活动工作区快照恢复窗口；快照为空时不自动新建便笺。switchToken 与 begin 返回的世代一致时才会完整执行；中途过期会关闭已创建的壳并中止。 */
	async restoreWorkspaceWindows(switchToken?: number): Promise<void> {
		if (switchToken !== undefined && this.isStaleWorkspaceSwitch(switchToken)) return;
		const ws = this.activeWorkspace();
		const openPaths = new Set<string>();
		for (const pop of this.popovers.values()) {
			const vf =
				pop.leaf?.view && 'file' in pop.leaf.view ? (pop.leaf.view as { file?: TFile }).file : undefined;
			if (vf) openPaths.add(vf.path);
		}
		if (!ws || ws.windows.length === 0) {
			return;
		}
		const pending = ws.windows.filter(w => !openPaths.has(w.path));
		if (pending.length === 0) return;
		const preparedList = (
			await Promise.all(pending.map(w => this.prepareExistingStickyShell(w)))
		).filter((p): p is PreparedExistingStickyOpen => p !== null);
		if (switchToken !== undefined && this.isStaleWorkspaceSwitch(switchToken)) {
			this.closeAllOpenStickyWindows(true);
			return;
		}
		if (preparedList.length === 0) return;
		for (const p of preparedList) {
			if (switchToken !== undefined && this.isStaleWorkspaceSwitch(switchToken)) {
				this.closeAllOpenStickyWindows(true);
				return;
			}
			await this.finalizeExistingStickyOpen(p, {
				workspaceActive: false,
				persistLayout: false,
				switchToken
			});
		}
		if (switchToken !== undefined && this.isStaleWorkspaceSwitch(switchToken)) {
			this.closeAllOpenStickyWindows(true);
			return;
		}
		this.syncAllBindingGroupsChromeAfterRestore();
		if (switchToken !== undefined && this.isStaleWorkspaceSwitch(switchToken)) {
			this.closeAllOpenStickyWindows(true);
			return;
		}
		this.persistOpenWindows({ bypassFreeze: true });
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

	/** 返回与 id 仍存在于内存中的同伴绑定 id 列表。 */
	private getAllBindingsForId(id: string): string[] {
		const set = this.bindings.get(id);
		if (!set || set.size === 0) return [];
		return [...set].filter(other => this.popovers.has(other));
	}

	private static bindingRowIntervalsOverlap(
		a: { rowMin: number; rowMax: number },
		b: { rowMin: number; rowMax: number }
	): boolean {
		return a.rowMin <= b.rowMax && b.rowMin <= a.rowMax;
	}

	/** 与 `layoutBindingGroupAsGrid` 相同的 span / placement 管线，供折叠同步按「网格行」过滤同伴。 */
	private resolveBindingChromeLayoutContext(group: string[]): {
		spanById: Map<string, StickyGridSpan>;
		placement: Map<string, { c: number; r: number }>;
	} | null {
		const topo = this.computeBindingGroupNorm(group);
		if (!topo) return null;
		const spanById = this.collectSpanMapForGroup(group, undefined);
		this.pruneStaleGridSpans(topo.norm, spanById);
		this.dedupeOverlappingSpans(spanById);
		const { placement } = this.resolveVirtualPlacement(
			topo.norm,
			topo.maxC,
			topo.maxR,
			group,
			spanById
		);
		return { spanById, placement };
	}

	private memberRowIntervalFromMaps(
		memberId: string,
		spanById: Map<string, StickyGridSpan>,
		placement: Map<string, { c: number; r: number }>
	): { rowMin: number; rowMax: number } | null {
		const span = spanById.get(memberId);
		if (span) return { rowMin: span.rowMin, rowMax: span.rowMax };
		const cell = placement.get(memberId);
		if (!cell) return null;
		return { rowMin: cell.r, rowMax: cell.r };
	}

	/** 仅同步绑定同伴的折叠/拉伸 UI 状态（不写盘）；返回 false 表示无需后续 repair。 */
	private applyBindingPeersChromeStateOnly(sourceId: string): boolean {
		const src = this.popovers.get(sourceId);
		if (!src) return false;
		const group = this.resolveBindingGroupIds(sourceId);
		if (group.length <= 1) return false;
		const ctx = this.resolveBindingChromeLayoutContext(group);
		if (!ctx) return true;
		const srcIv = this.memberRowIntervalFromMaps(sourceId, ctx.spanById, ctx.placement);
		if (!srcIv) return true;
		const collapsed = src.getCollapsed();
		const stretched = src.isStretched();
		for (const gid of group) {
			if (gid === sourceId) continue;
			const peerIv = this.memberRowIntervalFromMaps(gid, ctx.spanById, ctx.placement);
			if (!peerIv || !StickyNoteManager.bindingRowIntervalsOverlap(srcIv, peerIv)) continue;
			const p = this.popovers.get(gid);
			if (!p) continue;
			if (p.getCollapsed() !== collapsed) {
				p.setCollapsed(collapsed, { silent: true });
			}
			const peerGs = ENABLE_GRID_MULTI_CELL_SPAN ? this.stickyGridSpan.get(gid) : undefined;
			const peerMultiRow = !!(peerGs && peerGs.rowMin < peerGs.rowMax);
			const targetStretched = peerMultiRow && stretched ? false : stretched;
			if (p.isStretched() !== targetStretched) {
				p.setStretched(targetStretched, { snapHorizontalToViewport: false });
			}
		}
		return true;
	}

	/**
	 * 在 source 折叠/拉伸变化后同步同行绑定同伴的 UI，
	 * 再双帧 rAF 后补一次网格行修复（`repairBindingGroupRowAfterChromeSync`）。
	 */
	private syncBindingPeersChrome(sourceId: string, opts?: { persist?: boolean }): void {
		if (!this.applyBindingPeersChromeStateOnly(sourceId)) return;
		/* 双 rAF：等 DOM/布局稳定后再修网格，避免读错位。 */
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.repairBindingGroupRowAfterChromeSync(sourceId);
				if (opts?.persist !== false) {
					this.persistOpenWindows();
				}
			});
		});
	}

	/** 折叠/拉伸同步后按绑定组重新网格排版（拖动中跳过，松手再算）。 */
	private repairBindingGroupRowAfterChromeSync(sourceId: string): void {
		/* Dragging: only the title bar moves the active sticky; defer grid layout to drag end. */
		if (this.dragSession) return;
		const group = this.resolveBindingGroupIds(sourceId);
		if (group.length <= 1) return;
		let anchorId = group[0]!;
		let bestL = Number.POSITIVE_INFINITY;
		let bestT = Number.POSITIVE_INFINITY;
		for (const gid of group) {
			const pop = this.popovers.get(gid);
			if (!pop) continue;
			const phy = pop.getPhysicalBounds();
			if (phy.left < bestL || (phy.left === bestL && phy.top < bestT)) {
				bestL = phy.left;
				bestT = phy.top;
				anchorId = gid;
			}
		}
		this.layoutBindingGroupAsGrid(anchorId, { heightSourceId: sourceId });
	}

	/** 工作区批量恢复后：对每个绑定组做一次行修复并持久化布局。 */
	private syncAllBindingGroupsChromeAfterRestore(): void {
		const seen = new Set<string>();
		const repairAnchors: string[] = [];
		for (const id of this.popovers.keys()) {
			if (seen.has(id)) continue;
			const group = this.resolveBindingGroupIds(id);
			for (const g of group) seen.add(g);
			if (group.length <= 1) continue;
			let anchorId = group[0]!;
			let bestL = Number.POSITIVE_INFINITY;
			let bestT = Number.POSITIVE_INFINITY;
			for (const gid of group) {
				const pop = this.popovers.get(gid);
				if (!pop) continue;
				const phy = pop.getPhysicalBounds();
				if (phy.left < bestL || (phy.left === bestL && phy.top < bestT)) {
					bestL = phy.left;
					bestT = phy.top;
					anchorId = gid;
				}
			}
			repairAnchors.push(anchorId);
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
	 * 在指定轴上建立 a-b 绑定：会先拆掉 a 在该轴上与其它同伴的旧绑定，再 `bindPair`。
	 * 用于避免一条轴上形成 A-B-C 链式多重吸附。
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
		this.stickyGridSpan.delete(id);
	}

	private applyPendingBindingsForId(id: string): void {
		const wants = this.pendingBindings.get(id);
		if (!wants || wants.length === 0) return;
		for (const other of wants) {
			if (!this.popovers.has(other)) continue;
			/* 恢复快照时同伴已齐：简单成对连接即可（无需再推断轴向）。 */
			this.bindPair(id, other);
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
			for (const x of this.getAllBindingsForId(cur)) {
				if (seen.has(x)) continue;
				if (!this.popovers.has(x)) continue;
				seen.add(x);
				q.push(x);
			}
		}
		return out;
	}

	/**
	 * Auto: Ctrl = detach/solo drag.
	 * None: Alt = detach.
	 * Ctrl-trigger: ungrouped ? Alt only (detach); grouped ? Ctrl or Alt removes binding so Ctrl can mean snap when alone.
	 */
	private isDragDetachModifier(e: PointerEvent, dragId: string): boolean {
		const mode = this.plugin.settings.stickyAssistAlignSnapMode;
		if (mode === 'auto') return e.ctrlKey;
		if (mode === 'none') return e.altKey;
		const grouped = this.resolveBindingGroupIds(dragId).length > 1;
		if (grouped) return e.ctrlKey || e.altKey;
		return e.altKey;
	}

	private isAssistSnapEnabledThisMove(e: PointerEvent): boolean {
		const mode = this.plugin.settings.stickyAssistAlignSnapMode;
		if (mode === 'none') return false;
		if (mode === 'auto') return true;
		return e.ctrlKey;
	}

	private handleDragStart(id: string, e: PointerEvent): void {
		if (!this.popovers.has(id)) return;
		const detach = this.isDragDetachModifier(e, id);
		const grouped = this.resolveBindingGroupIds(id).length > 1;
		const deferBindingClear =
			this.plugin.settings.stickyAssistAlignSnapMode === 'ctrl' && grouped && detach;
		if (detach && !deferBindingClear) this.unbindAll(id);
		const groupIds = detach ? [id] : this.resolveBindingGroupIds(id);
		const primary = this.popovers.get(id)?.getBounds();
		if (!primary) return;
		this.dragSession = {
			id,
			groupIds,
			lastPrimary: primary,
			ctrlDetach: detach,
			deferBindingClear,
			snapHeightSourceId: null,
			snapWidthSourceId: null
		};
	}

	private handleDragMove(id: string, next: FloatingBounds, e: PointerEvent): FloatingBounds {
		const session = this.dragSession;
		if (!session || session.id !== id) return next;
		const detach = this.isDragDetachModifier(e, id);
		if (detach) {
			if (!session.ctrlDetach) {
				session.ctrlDetach = true;
				if (!session.deferBindingClear) this.unbindAll(id);
				session.groupIds = [id];
			}
			session.snapHeightSourceId = null;
			session.snapWidthSourceId = null;
			session.lastPrimary = next;
			return next;
		}

		const snapEnabled = this.isAssistSnapEnabledThisMove(e);
		const bindEnabled = this.plugin.settings.stickyAssistAlignBind;
		const threshold = Math.max(
			1,
			Math.min(50, Math.round(this.plugin.settings.stickyAssistAlignSnapThresholdPx))
		);

		let adjusted = next;
		let snappedToId: string | null = null;
		let snappedAxis: 'x' | 'y' | null = null;
		let rowEdgeAlign: 'top' | 'bottom' | null = null;
		if (snapEnabled) {
			const res = this.computeSnapForBounds(id, next, threshold, this.resolveBindingGroupIds(id));
			adjusted = res.bounds;
			snappedToId = res.snappedToId;
			snappedAxis = res.snappedAxis;
			rowEdgeAlign = res.rowEdgeAlign;
		}

		if (bindEnabled && snappedToId && snappedAxis === 'x') {
			this.bindPairWithAxis(id, snappedToId, 'x');
			const anchor = this.popovers.get(snappedToId);
			if (anchor) {
				const anchorB = anchor.getBounds();
				/* 取吸附侧：左缘或右缘贴同伴。 */
				const leftCandidate = anchorB.left - STICKY_EDGE_GAP_PX - adjusted.width;
				const rightCandidate = anchorB.left + anchorB.width + STICKY_EDGE_GAP_PX;
				const useLeft =
					Math.abs(adjusted.left - leftCandidate) <= Math.abs(adjusted.left - rightCandidate);
				const rowTop =
					rowEdgeAlign === 'bottom'
						? anchorB.top + anchorB.height - adjusted.height
						: anchorB.top;
				adjusted = {
					...adjusted,
					left: useLeft ? leftCandidate : rightCandidate,
					top: rowTop,
					/* 同行吸附：高度与锚窗对齐。 */
					height: anchorB.height
				};
				session.snapHeightSourceId = snappedToId;
				session.snapWidthSourceId = null;
				/* 同步同伴折叠/拉伸，但不立刻 persist（拖动中频繁写盘）。 */
				this.syncBindingPeersChrome(snappedToId, { persist: false });
			}
		} else if (bindEnabled && snappedToId && snappedAxis === 'y') {
			this.bindPairWithAxis(id, snappedToId, 'y');
			const anchor = this.popovers.get(snappedToId);
			if (anchor) {
				const anchorB = anchor.getBounds();
				const below =
					adjusted.top + adjusted.height / 2 >= anchorB.top + anchorB.height / 2;
				const nextTop = below
					? anchorB.top + anchorB.height + STICKY_EDGE_GAP_PX
					: anchorB.top - adjusted.height - STICKY_EDGE_GAP_PX;
				adjusted = {
					...adjusted,
					left: anchorB.left,
					width: anchorB.width,
					top: nextTop
				};
				session.snapWidthSourceId = snappedToId;
				session.snapHeightSourceId = null;
				this.syncBindingPeersChrome(snappedToId, { persist: false });
			}
		}

		const desiredDx = adjusted.left - session.lastPrimary.left;
		const desiredDy = adjusted.top - session.lastPrimary.top;
		let dx = desiredDx;
		let dy = desiredDy;

		/* 成组拖动：按整组包围盒夹紧，避免拖出视口（dx/dy 取可行区间）。 */
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
				/* 主窗用「逻辑框 + 物理尺寸」拼边界；同伴用物理框，避免折叠态 getBounds 低估高度导致 maxDy 失真。 */
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
		const session = this.dragSession;
		if (session?.id !== id) return;
		const heightSrc = session.snapHeightSourceId;
		const widthSrc = session.snapWidthSourceId;
		const threshold = Math.max(
			1,
			Math.min(50, Math.round(this.plugin.settings.stickyAssistAlignSnapThresholdPx))
		);
		const mult = Math.max(
			1,
			Math.min(8, Math.round(this.plugin.settings.stickyAssistAlignSnapUnbindRangeMultiplier * 10) / 10)
		);
		const unbindSnapThreshold = Math.max(1, Math.min(200, Math.round(threshold * mult)));
		if (this.plugin.settings.stickyAssistAlignSnapMode === 'ctrl' && session.ctrlDetach) {
			const hasPeers = (this.bindings.get(id)?.size ?? 0) > 0;
			if (hasPeers && !this.isWithinSnapReachOfAnyBindingPeer(id, unbindSnapThreshold)) {
				this.unbindAll(id);
			}
		}
		this.layoutBindingGroupAsGrid(id, { heightSourceId: heightSrc, widthSourceId: widthSrc });
		this.dragSession = null;
		this.persistOpenWindows();
	}

	private handleResizeStart(id: string, _e: PointerEvent, _dir: unknown): void {
		const groupIds = this.resolveBindingGroupIds(id);
		this.resizeSession = { id, groupIds, ctrlSpanningResize: false };
	}

	private handleResizeMove(id: string, next: FloatingBounds, e: PointerEvent, _dir: unknown): FloatingBounds {
		const session = this.resizeSession;
		if (!session || session.id !== id) return next;
		if (session.groupIds.length <= 1) return next;
		if (e.ctrlKey) {
			session.ctrlSpanningResize = true;
			return next;
		}
		/* 绑定组连动缩放：多轮迭代贴合邻窗（横向邻接同步高度 / 纵向邻接同步宽度）。 */
		for (let iter = 0; iter < GRID_LAYOUT_ITERATIONS; iter++) {
			for (const anchorId of session.groupIds) {
				const anchorBounds = anchorId === id ? next : this.popovers.get(anchorId)?.getBounds();
				const anchorPhy = this.popovers.get(anchorId)?.getPhysicalBounds();
				if (!anchorBounds || !anchorPhy) continue;
				for (const nbId of this.getAllBindingsForId(anchorId)) {
					if (!session.groupIds.includes(nbId)) continue;
					const pop = this.popovers.get(nbId);
					if (!pop) continue;
					const b = pop.getBounds();
					const nbPhy = pop.getPhysicalBounds();
					if (this.isAxisBinding(anchorId, nbId, 'x')) {
						const anchorCx = anchorBounds.left + anchorBounds.width / 2;
						const nbCx = b.left + b.width / 2;
						const placeLeft = nbCx <= anchorCx;
						const left = placeLeft
							? anchorBounds.left - STICKY_EDGE_GAP_PX - b.width
							: anchorBounds.left + anchorBounds.width + STICKY_EDGE_GAP_PX;
						pop.setBounds({ ...b, left, top: anchorBounds.top, height: anchorBounds.height });
					} else {
						const anchorCy = anchorPhy.top + anchorPhy.height / 2;
						const nbCy = nbPhy.top + nbPhy.height / 2;
						const placeAbove = nbCy <= anchorCy;
						const top = placeAbove
							? anchorBounds.top - STICKY_EDGE_GAP_PX - b.height
							: anchorBounds.top + anchorBounds.height + STICKY_EDGE_GAP_PX;
						pop.setBounds({ ...b, top, left: anchorBounds.left, width: anchorBounds.width });
					}
				}
			}
		}
		return next;
	}

	private handleResizeEnd(id: string, _e: PointerEvent): void {
		const session = this.resizeSession;
		if (session?.id === id) {
			let spanOpts:
				| { multiCellSpanForId: { id: string; colMin: number; colMax: number; rowMin: number; rowMax: number } }
				| undefined;
			if (
				ENABLE_GRID_MULTI_CELL_SPAN &&
				session.ctrlSpanningResize &&
				session.groupIds.length > 1
			) {
				const span = this.computeMultiCellSpanFromResize(id);
				if (span) {
					spanOpts = { multiCellSpanForId: { id, ...span } };
					this.stickyGridSpan.set(id, span);
				} else {
					this.stickyGridSpan.delete(id);
				}
			}
			this.layoutBindingGroupAsGrid(id, spanOpts);
			this.resizeSession = null;
			this.persistOpenWindows();
		}
	}

	/**
	 * Whether `movingId` is still within `threshold` px (snap logic) to at least one directly bound peer.
	 * Only peers are considered as targets; other windows are ignored. For drag-end unbind, pass
	 * `snapThresholdPx * stickyAssistAlignSnapUnbindRangeMultiplier` (capped) instead of the raw snap threshold.
	 */
	private isWithinSnapReachOfAnyBindingPeer(movingId: string, threshold: number): boolean {
		const peers = this.bindings.get(movingId);
		if (!peers || peers.size === 0) return true;
		const pop = this.popovers.get(movingId);
		if (!pop) return true;
		const b = pop.getBounds();
		const ignoreIds: string[] = [];
		for (const wid of this.popovers.keys()) {
			if (wid === movingId) continue;
			if (peers.has(wid)) continue;
			ignoreIds.push(wid);
		}
		const res = this.computeSnapForBounds(movingId, b, threshold, ignoreIds);
		return res.snappedToId != null && peers.has(res.snappedToId);
	}

	private computeSnapForBounds(
		_movingId: string,
		b: FloatingBounds,
		threshold: number,
		ignoreIds: readonly string[]
	): {
		bounds: FloatingBounds;
		snappedToId: string | null;
		snappedAxis: 'x' | 'y' | null;
		rowEdgeAlign: 'top' | 'bottom' | null;
	} {
		const ignore = new Set(ignoreIds);
		ignore.add(_movingId);
		const left = b.left;
		const top = b.top;
		const right = b.left + b.width;
		const bottom = b.top + b.height;

		let bestDx = 0;
		let bestDy = 0;
		let bestDyAbs = threshold + 1;
		let snappedToId: string | null = null;
		let snappedAxis: 'x' | 'y' | null = null;
		let rowEdgeAlign: 'top' | 'bottom' | null = null;

		const overlapLen = (a0: number, a1: number, b0: number, b1: number): number =>
			Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
		const hasEnoughOverlap = (overlapPx: number, aLen: number, bLen: number): boolean => {
			const minLen = Math.max(1, Math.min(aLen, bLen));
			/* 判定「同一行/列」所需的重叠：像素下限或占较短边比例。 */
			const OVERLAP_MIN_PX = 24;
			const OVERLAP_MIN_RATIO = 0.3;
			return overlapPx >= Math.min(OVERLAP_MIN_PX, minLen) || overlapPx / minLen >= OVERLAP_MIN_RATIO;
		};

		/** 同行（竖直重叠）候选：最佳水平吸附位移与目标。 */
		let bestRowDxAbs = threshold + 1;
		let bestRowDx = 0;
		let bestRowTarget: string | null = null;
		let bestRowEdge: 'top' | 'bottom' = 'top';

		/** 同列（水平重叠）候选：最佳竖直吸附位移与目标。 */
		let bestColDyAbs = threshold + 1;
		let bestColDy = 0;
		let bestColTarget: string | null = null;

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
			const bottomNear = Math.abs(bottom - oBottom) <= STICKY_BOTTOM_ALIGN_SNAP_PX;

			/* 高度接近且竖直边对齐时，允许微调 dy 做「齐顶/齐底」式吸附。 */
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
						rowEdgeAlign = 'top';
					}
					const bottomDelta = oBottom - bottom;
					const bottomAbs = Math.abs(bottomDelta);
					if (bottomAbs <= STICKY_BOTTOM_ALIGN_SNAP_PX && bottomAbs < bestDyAbs) {
						bestDyAbs = bottomAbs;
						bestDy = bottomDelta;
						snappedToId = id;
						snappedAxis = 'x';
						rowEdgeAlign = 'bottom';
					}
				}
			}

			const candidatesX = [
				{ dx: oLeft - left, target: id },
				{ dx: oRight - left, target: id },
				{ dx: oLeft - STICKY_EDGE_GAP_PX - right, target: id },
				{ dx: oRight + STICKY_EDGE_GAP_PX - left, target: id }
			];
			const considerRowSnap = sameRow && (topNear || bottomNear);
			if (considerRowSnap) {
				const preferBottom = bottomNear && !topNear;
				const preferTop = topNear && !bottomNear;
				const edge: 'top' | 'bottom' =
					preferBottom ? 'bottom' : preferTop ? 'top' : Math.abs(top - oTop) <= Math.abs(bottom - oBottom) ? 'top' : 'bottom';
				for (const c of candidatesX) {
					const a = Math.abs(c.dx);
					if (a <= threshold && a < bestRowDxAbs) {
						bestRowDxAbs = a;
						bestRowDx = c.dx;
						bestRowTarget = c.target;
						bestRowEdge = edge;
					}
				}
			}

			const xOverlap = overlapLen(left, right, oLeft, oRight);
			const sameCol = hasEnoughOverlap(xOverlap, b.width, ob.width);
			const widthClose = Math.abs(b.width - ob.width) <= Math.max(8, Math.round(threshold * 1.2));
			const leftNear = Math.abs(left - oLeft) <= threshold;
			if (sameCol && (leftNear || widthClose)) {
				const candidatesY = [
					{ dy: oTop - top, target: id },
					{ dy: oBottom + STICKY_EDGE_GAP_PX - top, target: id },
					{ dy: oTop - STICKY_EDGE_GAP_PX - bottom, target: id },
					{ dy: oBottom - bottom, target: id }
				];
				for (const c of candidatesY) {
					const a = Math.abs(c.dy);
					if (a <= threshold && a < bestColDyAbs) {
						bestColDyAbs = a;
						bestColDy = c.dy;
						bestColTarget = c.target;
					}
				}
			}
		}

		/* 若同行与同列吸附同时成立，取位移更小的一侧优先。 */
		if (bestRowDxAbs <= threshold && bestColDyAbs <= threshold) {
			if (bestRowDxAbs <= bestColDyAbs) {
				bestDx = bestRowDx;
				snappedToId = bestRowTarget;
				snappedAxis = 'x';
				rowEdgeAlign = bestRowEdge;
				if (bestRowEdge === 'top') {
					const ob = bestRowTarget ? this.popovers.get(bestRowTarget)?.getBounds() : undefined;
					if (ob) bestDy = ob.top - top;
				} else {
					const ob = bestRowTarget ? this.popovers.get(bestRowTarget)?.getBounds() : undefined;
					if (ob) bestDy = ob.top + ob.height - bottom;
				}
				bestDyAbs = Math.abs(bestDy);
			} else {
				bestDy = bestColDy;
				bestDyAbs = bestColDyAbs;
				snappedToId = bestColTarget;
				snappedAxis = 'y';
				rowEdgeAlign = null;
			}
		} else if (bestRowDxAbs <= threshold) {
			bestDx = bestRowDx;
			snappedToId = bestRowTarget;
			snappedAxis = 'x';
			rowEdgeAlign = bestRowEdge;
			if (bestRowEdge === 'top') {
				const ob = bestRowTarget ? this.popovers.get(bestRowTarget)?.getBounds() : undefined;
				if (ob) bestDy = ob.top - top;
			} else {
				const ob = bestRowTarget ? this.popovers.get(bestRowTarget)?.getBounds() : undefined;
				if (ob) bestDy = ob.top + ob.height - bottom;
			}
			bestDyAbs = Math.abs(bestDy);
		} else if (bestColDyAbs <= threshold) {
			bestDy = bestColDy;
			bestDyAbs = bestColDyAbs;
			snappedToId = bestColTarget;
			snappedAxis = 'y';
			rowEdgeAlign = null;
		}

		return {
			bounds: { ...b, left: b.left + bestDx, top: b.top + bestDy },
			snappedToId,
			snappedAxis,
			rowEdgeAlign
		};
	}

	private static rectsOverlap(
		a: { left: number; top: number; width: number; height: number },
		b: { left: number; top: number; width: number; height: number }
	): boolean {
		const ax2 = a.left + a.width;
		const ay2 = a.top + a.height;
		const bx2 = b.left + b.width;
		const by2 = b.top + b.height;
		return a.left < bx2 && ax2 > b.left && a.top < by2 && ay2 > b.top;
	}

	/** 校验快照里的网格跨格 span 是否合理（有限、非逆序、范围上限）。 */
	private isValidPersistedGridSpan(s: StickyGridSpan | undefined): s is StickyGridSpan {
		if (!s) return false;
		if (!Number.isFinite(s.colMin) || !Number.isFinite(s.colMax)) return false;
		if (!Number.isFinite(s.rowMin) || !Number.isFinite(s.rowMax)) return false;
		if (s.colMin > s.colMax || s.rowMin > s.rowMax) return false;
		if (s.colMin < 0 || s.rowMin < 0) return false;
		if (s.colMax - s.colMin > 32 || s.rowMax - s.rowMin > 32) return false;
		return true;
	}

	private computeBindingGroupNorm(group: string[]): {
		anchorId: string;
		norm: Map<string, { c: number; r: number }>;
		maxC: number;
		maxR: number;
	} | null {
		type GridCell = { c: number; r: number };
		if (group.length <= 1) return null;
		const groupSet = new Set(group);
		let anchorId: string = group[0]!;
		let bestL = Number.POSITIVE_INFINITY;
		let bestT = Number.POSITIVE_INFINITY;
		for (const gid of group) {
			const pop = this.popovers.get(gid);
			if (!pop) continue;
			const phy = pop.getPhysicalBounds();
			if (phy.left < bestL || (phy.left === bestL && phy.top < bestT)) {
				bestL = phy.left;
				bestT = phy.top;
				anchorId = gid;
			}
		}

		const pos = new Map<string, GridCell>();
		pos.set(anchorId, { c: 0, r: 0 });
		const q = [anchorId];
		while (q.length > 0) {
			const cur = q.shift();
			if (cur === undefined) continue;
			const pcell = pos.get(cur);
			if (!pcell) continue;
			const curPop = this.popovers.get(cur);
			if (!curPop) continue;
			const cPhy = curPop.getPhysicalBounds();
			for (const other of this.getAllBindingsForId(cur)) {
				if (!groupSet.has(other)) continue;
				const axis = this.inferBindingAxis(cur, other);
				const oPop = this.popovers.get(other);
				if (!oPop) continue;
				const oPhy = oPop.getPhysicalBounds();
				let nc = pcell.c;
				let nr = pcell.r;
				if (axis === "x") {
					nc = oPhy.left + oPhy.width / 2 < cPhy.left + cPhy.width / 2 ? pcell.c - 1 : pcell.c + 1;
					nr = pcell.r;
				} else {
					nc = pcell.c;
					nr = oPhy.top + oPhy.height / 2 < cPhy.top + cPhy.height / 2 ? pcell.r - 1 : pcell.r + 1;
				}
				if (!pos.has(other)) {
					pos.set(other, { c: nc, r: nr });
					q.push(other);
				}
			}
		}

		let minC = Number.POSITIVE_INFINITY;
		let minR = Number.POSITIVE_INFINITY;
		for (const pr of pos.values()) {
			minC = Math.min(minC, pr.c);
			minR = Math.min(minR, pr.r);
		}
		const norm = new Map<string, GridCell>();
		for (const [wid, pr] of pos) {
			norm.set(wid, { c: pr.c - minC, r: pr.r - minR });
		}

		let maxC = 0;
		let maxR = 0;
		for (const pr of norm.values()) {
			maxC = Math.max(maxC, pr.c);
			maxR = Math.max(maxR, pr.r);
		}
		return { anchorId, norm, maxC, maxR };
	}

	private collectSpanMapForGroup(
		group: string[],
		opts?: {
			multiCellSpanForId?: { id: string; colMin: number; colMax: number; rowMin: number; rowMax: number };
		}
	): Map<string, StickyGridSpan> {
		const m = new Map<string, StickyGridSpan>();
		if (!ENABLE_GRID_MULTI_CELL_SPAN) return m;
		for (const id of group) {
			const x = this.stickyGridSpan.get(id);
			if (x) m.set(id, { ...x });
		}
		if (opts?.multiCellSpanForId) {
			const z = opts.multiCellSpanForId;
			m.set(z.id, { colMin: z.colMin, colMax: z.colMax, rowMin: z.rowMin, rowMax: z.rowMax });
		}
		return m;
	}

	private pruneStaleGridSpans(norm: Map<string, { c: number; r: number }>, spanById: Map<string, StickyGridSpan>): void {
		for (const sid of [...spanById.keys()]) {
			const span = spanById.get(sid);
			if (!span) continue;
			const h = norm.get(sid);
			if (
				!h ||
				h.c < span.colMin ||
				h.c > span.colMax ||
				h.r < span.rowMin ||
				h.r > span.rowMax
			) {
				spanById.delete(sid);
				this.stickyGridSpan.delete(sid);
			}
		}
	}

	private dedupeOverlappingSpans(spanById: Map<string, StickyGridSpan>): void {
		const occ = new Map<string, string>();
		for (const sid of [...spanById.keys()].sort()) {
			const span = spanById.get(sid);
			if (!span) continue;
			let conflict = false;
			for (let c = span.colMin; c <= span.colMax && !conflict; c++) {
				for (let r = span.rowMin; r <= span.rowMax; r++) {
					const k = `${c},${r}`;
					const o = occ.get(k);
					if (o !== undefined && o !== sid) {
						conflict = true;
						break;
					}
				}
			}
			if (conflict) {
				spanById.delete(sid);
				this.stickyGridSpan.delete(sid);
				continue;
			}
			for (let c = span.colMin; c <= span.colMax; c++) {
				for (let r = span.rowMin; r <= span.rowMax; r++) {
					occ.set(`${c},${r}`, sid);
				}
			}
		}
	}

	private resolveVirtualPlacement(
		norm: Map<string, { c: number; r: number }>,
		maxC: number,
		maxR: number,
		group: string[],
		spanById: Map<string, StickyGridSpan>
	): { placement: Map<string, { c: number; r: number }>; maxC: number; maxR: number } {
		const occupied = new Map<string, string>();
		const placement = new Map<string, { c: number; r: number }>();
		const key = (c: number, r: number) => `${c},${r}`;

		for (const sid of spanById.keys()) {
			const span = spanById.get(sid);
			if (!span) continue;
			for (let c = span.colMin; c <= span.colMax; c++) {
				for (let r = span.rowMin; r <= span.rowMax; r++) {
					occupied.set(key(c, r), sid);
				}
			}
			placement.set(sid, { c: span.colMin, r: span.rowMin });
		}

		let mc = maxC;
		let mr = maxR;

		const scanFree = (): { c: number; r: number } => {
			for (let r = 0; r <= mr + 24; r++) {
				for (let c = 0; c <= mc + 24; c++) {
					if (!occupied.has(key(c, r))) return { c, r };
				}
			}
			return { c: mc + 1, r: 0 };
		};

		for (const wid of group) {
			if (spanById.has(wid)) continue;
			const home = norm.get(wid);
			if (!home) continue;
			const { c, r } = home;
			const k0 = key(c, r);
			if (!occupied.has(k0)) {
				occupied.set(k0, wid);
				placement.set(wid, { c, r });
				mc = Math.max(mc, c);
				mr = Math.max(mr, r);
				continue;
			}
			const free = scanFree();
			occupied.set(key(free.c, free.r), wid);
			placement.set(wid, free);
			mc = Math.max(mc, free.c);
			mr = Math.max(mr, free.r);
		}

		return { placement, maxC: mc, maxR: mr };
	}

	/**
	 * 据占位与跨格 span 计算列宽、行高及每列行起点。
	 * `sizingExcludeIds`：不参与初始测量的窗口（如 Ctrl 跨格缩放中的主导窗）；
	 * `opts.heightSourceId` / `widthSourceId`：拖动吸附后强制对齐的高度或宽度来源。
	 */
	private measureBindingGridMetrics(
		group: string[],
		anchorId: string,
		placement: Map<string, { c: number; r: number }>,
		maxC: number,
		maxR: number,
		spanById: Map<string, StickyGridSpan>,
		sizingExcludeIds: Set<string>,
		opts?: { heightSourceId?: string | null; widthSourceId?: string | null }
	): {
		colW: Map<number, number>;
		rowH: Map<number, number>;
		colStart: Map<number, number>;
		rowStart: Map<number, number>;
	} | null {
		const colW = new Map<number, number>();
		const rowH = new Map<number, number>();

		for (const wid of group) {
			if (spanById.has(wid)) continue;
			if (sizingExcludeIds.has(wid)) continue;
			const pop = this.popovers.get(wid);
			if (!pop) continue;
			const cell = placement.get(wid);
			if (!cell) continue;
			const logic = pop.getBounds();
			const phy = pop.getPhysicalBounds();
			const wCell = phy.width;
			const hCell = pop.getCollapsed() ? phy.height : logic.height;
			colW.set(cell.c, Math.max(colW.get(cell.c) ?? 0, wCell));
			rowH.set(cell.r, Math.max(rowH.get(cell.r) ?? 0, hCell));
		}

		for (let c = 0; c <= maxC; c++) {
			if (!colW.has(c)) colW.set(c, GRID_FALLBACK_MIN_W);
		}
		for (let r = 0; r <= maxR; r++) {
			if (!rowH.has(r)) rowH.set(r, GRID_FALLBACK_MIN_H);
		}

		const gap = STICKY_EDGE_GAP_PX;
		for (const [sid, span] of spanById) {
			const pop = this.popovers.get(sid);
			if (!pop) continue;
			const phy = pop.getPhysicalBounds();
			const logic = pop.getBounds();
			const needW = phy.width;
			const needH = pop.getCollapsed() ? phy.height : logic.height;
			let sumW = 0;
			for (let c = span.colMin; c <= span.colMax; c++) sumW += colW.get(c) ?? 0;
			sumW += gap * (span.colMax - span.colMin);
			if (needW > sumW) {
				colW.set(span.colMax, (colW.get(span.colMax) ?? 0) + (needW - sumW));
			}
			let sumH = 0;
			for (let r = span.rowMin; r <= span.rowMax; r++) sumH += rowH.get(r) ?? 0;
			sumH += gap * (span.rowMax - span.rowMin);
			if (needH > sumH) {
				rowH.set(span.rowMax, (rowH.get(span.rowMax) ?? 0) + (needH - sumH));
			}
		}

		const hRefId = opts?.heightSourceId;
		const wRefId = opts?.widthSourceId;
		if (hRefId) {
			const ref = this.popovers.get(hRefId);
			const pr = placement.get(hRefId);
			if (ref && pr !== undefined && !ref.getCollapsed()) {
				const rh = ref.getBounds().height;
				rowH.set(pr.r, Math.max(rowH.get(pr.r) ?? 0, rh));
			}
		}
		if (wRefId) {
			const ref = this.popovers.get(wRefId);
			const pc = placement.get(wRefId);
			if (ref && pc !== undefined) {
				const rw = ref.getPhysicalBounds().width;
				colW.set(pc.c, Math.max(colW.get(pc.c) ?? 0, rw));
			}
		}

		const aNorm = placement.get(anchorId);
		const aPop = this.popovers.get(anchorId);
		if (!aNorm || !aPop) return null;
		const aPhy = aPop.getPhysicalBounds();

		const colStart = new Map<number, number>();
		const rowStart = new Map<number, number>();
		colStart.set(aNorm.c, aPhy.left);
		rowStart.set(aNorm.r, aPhy.top);

		for (let c = aNorm.c - 1; c >= 0; c--) {
			const curW = colW.get(c) ?? 0;
			const rightNeighborStart = colStart.get(c + 1)!;
			colStart.set(c, rightNeighborStart - gap - curW);
		}
		for (let c = aNorm.c + 1; c <= maxC; c++) {
			const prevW = colW.get(c - 1) ?? 0;
			const prevStart = colStart.get(c - 1)!;
			colStart.set(c, prevStart + prevW + gap);
		}

		for (let r = aNorm.r - 1; r >= 0; r--) {
			const curH = rowH.get(r) ?? 0;
			const belowStart = rowStart.get(r + 1)!;
			rowStart.set(r, belowStart - gap - curH);
		}
		for (let r = aNorm.r + 1; r <= maxR; r++) {
			const prevH = rowH.get(r - 1) ?? 0;
			const prevStart = rowStart.get(r - 1)!;
			rowStart.set(r, prevStart + prevH + gap);
		}

		return { colW, rowH, colStart, rowStart };
	}

	private computeMultiCellSpanFromResize(resizeId: string): {
		colMin: number;
		colMax: number;
		rowMin: number;
		rowMax: number;
	} | null {
		const pop = this.popovers.get(resizeId);
		if (!pop || pop.getCollapsed()) return null;
		const group = this.resolveBindingGroupIds(resizeId);
		const topo = this.computeBindingGroupNorm(group);
		if (!topo) return null;
		const spanById = this.collectSpanMapForGroup(group, undefined);
		this.pruneStaleGridSpans(topo.norm, spanById);
		this.dedupeOverlappingSpans(spanById);
		const { placement, maxC, maxR } = this.resolveVirtualPlacement(
			topo.norm,
			topo.maxC,
			topo.maxR,
			group,
			spanById
		);
		const sizingExclude = new Set(spanById.keys());
		sizingExclude.add(resizeId);
		const m = this.measureBindingGridMetrics(
			group,
			topo.anchorId,
			placement,
			maxC,
			maxR,
			spanById,
			sizingExclude,
			undefined
		);
		if (!m) return null;
		const R = pop.getPhysicalBounds();
		let colMin = Number.POSITIVE_INFINITY;
		let colMax = -1;
		let rowMin = Number.POSITIVE_INFINITY;
		let rowMax = -1;
		let hit = false;
		for (let c = 0; c <= maxC; c++) {
			for (let r = 0; r <= maxR; r++) {
				const cl = m.colStart.get(c);
				const ct = m.rowStart.get(r);
				const cw = m.colW.get(c);
				const ch = m.rowH.get(r);
				if (cl === undefined || ct === undefined || cw === undefined || ch === undefined) continue;
				const cell = { left: cl, top: ct, width: cw, height: ch };
				if (StickyNoteManager.rectsOverlap(R, cell)) {
					hit = true;
					colMin = Math.min(colMin, c);
					colMax = Math.max(colMax, c);
					rowMin = Math.min(rowMin, r);
					rowMax = Math.max(rowMax, r);
				}
			}
		}
		if (!hit || colMax < 0) return null;
		if (colMin === colMax && rowMin === rowMax) return null;
		return { colMin, colMax, rowMin, rowMax };
	}

	private layoutBindingGroupAsGrid(
		rootId: string,
		opts?: {
			heightSourceId?: string | null;
			widthSourceId?: string | null;
			multiCellSpanForId?: { id: string; colMin: number; colMax: number; rowMin: number; rowMax: number };
		}
	): void {
		const root = this.popovers.get(rootId);
		if (!root) return;
		const group = this.resolveBindingGroupIds(rootId);
		if (group.length <= 1) return;

		const topo = this.computeBindingGroupNorm(group);
		if (!topo) return;
		const spanById = this.collectSpanMapForGroup(group, opts);
		this.pruneStaleGridSpans(topo.norm, spanById);
		this.dedupeOverlappingSpans(spanById);
		const { placement, maxC, maxR } = this.resolveVirtualPlacement(
			topo.norm,
			topo.maxC,
			topo.maxR,
			group,
			spanById
		);
		const sizingExclude = new Set<string>();
		const m = this.measureBindingGridMetrics(
			group,
			topo.anchorId,
			placement,
			maxC,
			maxR,
			spanById,
			sizingExclude,
			opts
		);
		if (!m) return;

		for (const wid of group) {
			const pop = this.popovers.get(wid);
			if (!pop) continue;
			const pcell = placement.get(wid);
			if (!pcell) continue;
			const logic = pop.getBounds();
			const span = spanById.get(wid);
			if (span) {
				const nl = m.colStart.get(span.colMin) ?? logic.left;
				const nw = (m.colStart.get(span.colMax) ?? nl) + (m.colW.get(span.colMax) ?? 0) - nl;
				const nt = m.rowStart.get(span.rowMin) ?? logic.top;
				const nh = (m.rowStart.get(span.rowMax) ?? nt) + (m.rowH.get(span.rowMax) ?? 0) - nt;
				if (pop.getCollapsed()) {
					pop.setBounds({ ...logic, left: nl, top: nt, width: nw });
				} else {
					pop.setBounds({ ...logic, left: nl, top: nt, width: nw, height: nh });
				}
				continue;
			}

			const nw = m.colW.get(pcell.c) ?? logic.width;
			const nh = m.rowH.get(pcell.r) ?? logic.height;
			const nl = m.colStart.get(pcell.c) ?? logic.left;
			const nt = m.rowStart.get(pcell.r) ?? logic.top;

			if (pop.getCollapsed()) {
				pop.setBounds({ ...logic, left: nl, top: nt, width: nw });
			} else {
				pop.setBounds({ ...logic, left: nl, top: nt, width: nw, height: nh });
			}
		}

		this.ensureBindingGroupInViewport(group);
	}

	private ensureBindingGroupInViewport(groupIds: readonly string[]): void {
		const margin = StickyNoteManager.VIEW_MARGIN;
		let minLeft = Number.POSITIVE_INFINITY;
		let minTop = Number.POSITIVE_INFINITY;
		let maxRight = Number.NEGATIVE_INFINITY;
		let maxBottom = Number.NEGATIVE_INFINITY;
		for (const gid of groupIds) {
			const pop = this.popovers.get(gid);
			if (!pop) continue;
			const b = pop.getPhysicalBounds();
			minLeft = Math.min(minLeft, b.left);
			minTop = Math.min(minTop, b.top);
			maxRight = Math.max(maxRight, b.left + b.width);
			maxBottom = Math.max(maxBottom, b.top + b.height);
		}
		if (!Number.isFinite(minLeft)) return;
		const minDx = margin - minLeft;
		const maxDx = window.innerWidth - margin - maxRight;
		const minDy = margin - minTop;
		const maxDy = window.innerHeight - margin - maxBottom;
		const dx = Math.min(maxDx, Math.max(minDx, 0));
		const dy = Math.min(maxDy, Math.max(minDy, 0));
		if (dx === 0 && dy === 0) return;
		for (const gid of groupIds) {
			const pop = this.popovers.get(gid);
			if (!pop) continue;
			const b = pop.getBounds();
			pop.setBounds({ ...b, left: b.left + dx, top: b.top + dy });
		}
	}

	onunload(): void {
		for (const p of this.popovers.values()) {
			p.destroy();
		}
		this.popovers.clear();
	}
}
