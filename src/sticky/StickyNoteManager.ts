import { normalizePath, Notice, TFile, type App, type EventRef } from 'obsidian';
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
import { loadWorkspacesFile, saveWorkspacesFile } from '../workspace-store';
import { StickyNotePopover } from './StickyNotePopover';

/** ?????????????????????? setViewState????????????????????????????? YAML ?????? */
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
/** ??????/???????????????????????????????????????????????????? */
const GRID_FALLBACK_MIN_W = 280;
const GRID_FALLBACK_MIN_H = 200;

/** ?????????????????????? obsidian ??????????????? `App` ?????? `commands`??? */
function executeCommandById(app: App, commandId: string): boolean {
	const withCommands = app as unknown as {
		commands?: { executeCommandById: (id: string) => boolean };
	};
	return withCommands.commands?.executeCommandById(commandId) ?? false;
}

export class StickyNoteManager {
	private readonly popovers = new Map<string, StickyNotePopover>();
	/** ????????????????????????????????????????????? */
	private readonly bindings = new Map<string, Set<string>>();
	private readonly stickyGridSpan = new Map<string, StickyGridSpan>();
	/** ??????????????????????????????????????????????????????????? */
	private readonly pendingBindings = new Map<string, string[]>();
	private dragSession:
		| {
			id: string;
			groupIds: string[];
			lastPrimary: FloatingBounds;
			ctrlDetach: boolean;
			/** ???????????????????????????????????????????????????????? */
			snapHeightSourceId: string | null;
			/** ??????????????????????????????????? */
			snapWidthSourceId: string | null;
		}
		| null = null;
	private resizeSession:
		| {
			id: string;
			groupIds: string[];
			/** ??????? Ctrl ???????????????????????????????????????? */
			ctrlSpanningResize: boolean;
		}
		| null = null;
	private readonly mount = document.body;
	/** ????? z-index ??????????????????? */
	private stickyZStackSeq = 0;
	/** ??????????????????????????????????????????????????????????? */
	private readonly manualHiddenIds = new Set<string>();
	/** ?????????????????????????????????????????????????? */
	private hideOthersMode = false;
	/** ??????????????????????????????????????? */
	private hideAllMode = false;
	private activePopoverId: string | null = null;
	/** ????? bringStickyToFront ??????? id???????????????????????????????????? vs ?????????????????????? */
	private lastActivatedPopoverId: string | null = null;
	private saveTimer: number | null = null;
	/** ????????????????????????????????? vault ????????????????????? */
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

	/** ??????????????????????????????????????????????????? / ????????????????????? */
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
	 * ??????????????????????????????????
	 * @param keepWorkspaceSession true ????????????????????????????????????? windows??????????????????????????????
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

		/* ?????????????????????????????????????????????????????????? */
		const switchedToDifferent = activeId !== null && activeId !== this.lastActivatedPopoverId;
		if (activeId && switchedToDifferent && pop.isHidden()) {
			/* ??????????????????? */
			this.manualHiddenIds.delete(activeId);
			/* ???????????????????????????????????????????????? */
			if (this.hideAllMode) this.hideAllMode = false;
			/* ??????????????????????????????????????? active ??????????????????????????????????? */
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

	/** ?????????????????????????????????????????????????????? */
	toggleHideCurrentSticky(): void {
		const id = this.ensureActivePopoverId();
		if (!id) return;
		this.hideCurrentStickyById(id);
	}

	private hideCurrentStickyById(id: string): void {
		if (!this.popovers.has(id)) return;
		/* ????????????????????????????????????????????????????????????????????????????????????????? */
		this.hideAllMode = false;
		this.hideOthersMode = false;
		this.manualHiddenIds.add(id);
		this.applyHiddenStateToAll();
		this.popovers.get(id)?.setActiveHighlight(false);
	}

	/** ????????????????????????????????????????? */
	hideOthersSticky(): void {
		const id = this.ensureActivePopoverId();
		if (!id) return;
		this.hideOthersRelativeToId(id);
	}

	private hideOthersRelativeToId(id: string): void {
		if (!this.popovers.has(id)) return;
		/* ????????????????????????????????????????????????? active ???????? */
		this.activePopoverId = id;
		/* ?????????????????????????????????????????????????????? */
		this.hideAllMode = false;
		this.manualHiddenIds.clear();
		this.hideOthersMode = true;
		this.applyHiddenStateToAll();
		this.popovers.get(id)?.setActiveHighlight(true);
	}

	/** ????????????????????????????????????????????? */
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
		/* ??????????????????????????????????????????????????????? */
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

	/** ???????????????????????????? DOM??? */
	private applyHiddenStateToAll(): void {
		const activeId = this.activePopoverId;
		for (const [id, pop] of this.popovers) {
			const hidden =
				this.hideAllMode ||
				this.manualHiddenIds.has(id) ||
				(this.hideOthersMode && activeId !== null && id !== activeId);
			pop.setHidden(hidden);
			/* ????????????????????????????/????????????? */
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

	/** ?????????? frontmatter??id/archived/bg??? */
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

	/** ???????????????????????????????????????????????????????????????????? */
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
			const gs = this.stickyGridSpan.get(id);
			if (gs) row.gridSpan = { ...gs };
			if (file.extension === 'md') {
				row.markdownMode = pop.getMarkdownMode();
			}
			ser.push(row);
		}
		return ser;
	}

	/**
	 * ??????????????????????????????????????????????????????????
	 * ????????????? id ??????????????????? `persistOpenWindows` ????????????????????
	 */
	async createWorkspaceFromCurrentLayout(name: string): Promise<void> {
		this.persistOpenWindows();
		const trimmed = name.trim();
		const finalName = trimmed || `???????? ${this.workspaces.workspaces.length + 1}`;
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
	 * ??????????????????????????????????????????????????????????????????????????????????
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

	/** ???????????????????????????????? gap??????????????????????????? */
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
		/* ???? color: 'default'????????????? YAML ???? colorful-sticky-bg??? */
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
		 * ??????????????????????????????????????? YAML ???????? create???
		 * ???????????????????????????????? processFrontMatter???????????????????????????????????????????????????????????????????
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

		/* `create` ??????????????????????????????????????????????????????????????????? openFile ???????????????????????????????? */
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
			/* ??????????????????????? */
		}
		await pop.openFile(f);

		/** ?????? Markdown ? `loadIfDeferred` ?????????????????????????????????????????? */
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
		/* ?????? frontmatter ???????id / archived / bg????? */
		await this.ensureStickyFrontmatterDefaults(f, { preferredId: id, preferredColor: color }).catch(() => undefined);
		this.bringStickyToFront(pop);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
	}

	/**
	 * `relativeNoExt` ???????????????????????? .md???????????????? `2026/2026-05-07`???
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
			onToggleArchiveCurrentSticky: () => void this.toggleArchiveCurrentStickyForPopover(id),
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

	/** ?????? frontmatter ?????????????????????????????????????????????? */
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

	/** ?????? frontmatter `colorful-sticky-archived`????????????????????? */
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

	/** ?????????????????????????????????????????? */
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
		this.stickyGridSpan.delete(id);
		this.persistOpenWindows();
		this.notifyStickyListOpenIndicators();
	}

	/** ??????????????????????????????????????? .md????? */
	private isPathUnderStickyFolder(filePath: string): boolean {
		const root = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const p = normalizePath(filePath);
		return p === root || p.startsWith(`${root}/`);
	}

	/** ???????? DOM???????????????????????????????????????????????? */
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
		void this.app.vault.trash(file, false).catch(() => {
			new Notice(t('NOTICE_CANNOT_AUTO_DELETE_BLANK_STICKY'));
		});
	}

	/** ????????????????????????????????????????????????????????????????????? */
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
				/* ????????????????????? */
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

	/** ?????????????????????????????????????? setViewState / ????????????? */
	private yieldForStickyChromePaint(): Promise<void> {
		return new Promise(resolve => requestAnimationFrame(() => resolve()));
	}

	/** ???? DOM/????????????????????????????? `color` ??????????????????????????????????????????????? */
	private async prepareExistingStickyShell(
		serial: SerializedStickyWindow
	): Promise<PreparedExistingStickyOpen | null> {
		const file = this.resolveStickyFileForSerialized(serial);
		if (!(file instanceof TFile)) {
			new Notice(`???????????${serial.path}`);
			return null;
		}
		const id = serial.id || this.newId();
		const b = serial.bounds ?? this.getDefaultBounds();
		const savedColor = serial.color;
		const fromYaml = await resolveStickyBgColorForFile(this.app, file);
		/* ?????????????? `color` ???? YAML ????????????????????????????????????? `default` ????????? */
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
		if (this.isValidPersistedGridSpan(serial.gridSpan)) {
			this.stickyGridSpan.set(id, serial.gridSpan!);
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
		opts: { workspaceActive: boolean }
	): Promise<void> {
		const { pop, file, bounds: b, savedColor, hidden, stretched } = prepared;
		await pop.openFile(file, { workspaceActive: opts.workspaceActive });
		pop.setBounds(b);
		/* ??????????????????????????????????????????????????????????????????? */
		pop.setStretched(stretched, { snapHorizontalToViewport: false });
		pop.setHidden(hidden);
		if (savedColor !== undefined) {
			/* ???????????????????????????? frontmatter ??? `colorful-sticky-bg` ?????????????????????????????????? */
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
		/* ???????????????????????????????????? active ????????????????????? */
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

	/** ??????????????????????????????????????????????? */
	private getAllBindingsForId(id: string): string[] {
		const set = this.bindings.get(id);
		if (!set || set.size === 0) return [];
		return [...set].filter(other => this.popovers.has(other));
	}

	/** ?????????/????????????????????????????????????????????????????????? repair??? */
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
	 * ?? source ?????????/??????????????????????????????????????????????????????????????? bindings?????
	 * ???????????????????????????? left?????????????????????????????????
	 */
	private syncBindingPeersChrome(sourceId: string, opts?: { persist?: boolean }): void {
		if (!this.applyBindingPeersChromeStateOnly(sourceId)) return;
		/* ????????? rAF ?????????????????????????????????????????????? */
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.repairBindingGroupRowAfterChromeSync(sourceId);
				if (opts?.persist !== false) {
					this.persistOpenWindows();
				}
			});
		});
	}

	/** ?????????????/??????????????????????????????????????????????????????????? */
	private repairBindingGroupRowAfterChromeSync(sourceId: string): void {
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

	/** ?????????????????????????????/?????????????????????????????? */
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
	 * ??????????????????????????????????????????????????????????
	 * ????????????????????????????????????????????????A->B->C?????
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
			/* ??????????????????????? bindPairWithAxis ????????????????????? */
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
			snapHeightSourceId: null,
			snapWidthSourceId: null
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
			session.snapWidthSourceId = null;
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
		let rowEdgeAlign: 'top' | 'bottom' | null = null;
		if (snapEnabled) {
			const res = this.computeSnapForBounds(id, next, threshold, session.groupIds);
			adjusted = res.bounds;
			snappedToId = res.snappedToId;
			snappedAxis = res.snappedAxis;
			rowEdgeAlign = res.rowEdgeAlign;
		}

		if (bindEnabled && snappedToId && snappedAxis === 'x') {
			this.bindPairWithAxis(id, snappedToId, 'x');
			/* ??????????????????????????????????????????????????????????????????? */
			session.groupIds = this.resolveBindingGroupIds(id);
			const anchor = this.popovers.get(snappedToId);
			if (anchor) {
				const anchorB = anchor.getBounds();
				/* ??????????????????????? */
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
					/* ??????????????????????????????????????????????? */
					height: anchorB.height
				};
				session.snapHeightSourceId = snappedToId;
				session.snapWidthSourceId = null;
				/* ????????????????????????/?????????????????????????????????????????????????? */
				this.syncBindingPeersChrome(snappedToId, { persist: false });
			}
		} else if (bindEnabled && snappedToId && snappedAxis === 'y') {
			this.bindPairWithAxis(id, snappedToId, 'y');
			session.groupIds = this.resolveBindingGroupIds(id);
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

		/* ?????????????????????????????????????????????????????????????????????????? */
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
				/* ??????? getBounds() ???????????????????????????? DOM ?????????????????? maxDy ???? */
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
			const widthSrc = this.dragSession.snapWidthSourceId;
			this.layoutBindingGroupAsGrid(id, { heightSourceId: heightSrc, widthSourceId: widthSrc });
			this.dragSession = null;
			this.persistOpenWindows();
		}
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
		/* ??????????????????????????????????????????????????????????????? / ??????? */
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
			if (session.ctrlSpanningResize && session.groupIds.length > 1) {
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
		let bestDxAbs = threshold + 1;
		let bestDyAbs = threshold + 1;
		let snappedToId: string | null = null;
		let snappedAxis: 'x' | 'y' | null = null;
		let rowEdgeAlign: 'top' | 'bottom' | null = null;

		const overlapLen = (a0: number, a1: number, b0: number, b1: number): number =>
			Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
		const hasEnoughOverlap = (overlapPx: number, aLen: number, bLen: number): boolean => {
			const minLen = Math.max(1, Math.min(aLen, bLen));
			/* ?????????/??????????????????????????????????????????????? */
			const OVERLAP_MIN_PX = 24;
			const OVERLAP_MIN_RATIO = 0.3;
			return overlapPx >= Math.min(OVERLAP_MIN_PX, minLen) || overlapPx / minLen >= OVERLAP_MIN_RATIO;
		};

		/** ??????????????? / ????????? */
		let bestRowDxAbs = threshold + 1;
		let bestRowDx = 0;
		let bestRowTarget: string | null = null;
		let bestRowEdge: 'top' | 'bottom' = 'top';

		/** ????????????????????? */
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

			/* ?????????????????????/?????????????????????????????? */
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

		/* ???????????????????????????????????????????????????????????????? */
		if (bestRowDxAbs <= threshold && bestColDyAbs <= threshold) {
			if (bestRowDxAbs <= bestColDyAbs) {
				bestDx = bestRowDx;
				bestDxAbs = bestRowDxAbs;
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
			bestDxAbs = bestRowDxAbs;
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

	/**
	 * ????????????????????????????? / ???????????????????
	 * @param excludeFromSizingId ????????? / ?????????????? Ctrl ??????????????????????????????????????
	 */

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

		const pos = new Map();
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
		const norm = new Map();
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
