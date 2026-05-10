import { App, PluginSettingTab, Setting } from 'obsidian';
import { formatStickyNoteRelativePath } from './filename-template';
import { t } from './lang/helpers';
import type ColorfulStickyNotesPlugin from './main';
import { FolderPickerModal } from './modals/FolderPickerModal';
import { MarkdownFilePickerModal } from './modals/MarkdownFilePickerModal';
import { SHEET_COLOR_ORDER } from './sticky/sticky-color-order';
import type {
	HeaderNewStickyAdjacentSide,
	NoteListArchiveFilter,
	NoteListFloatOpenFilter,
	NoteListOpenLocation,
	NoteListSort,
	StickyAssistAlignSnapMode,
	StickyColorId
} from './types';

/** 便笺窗口与列表预览正文的 zoom 范围（与设置项一致）。 */
export const VIEW_CONTENT_ZOOM_MIN = 0.3;
export const VIEW_CONTENT_ZOOM_MAX = 1;
export const VIEW_CONTENT_ZOOM_DEFAULT = 0.65;
export const VIEW_CONTENT_ZOOM_STEP = 0.05;

export function clampViewContentZoom(value: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return VIEW_CONTENT_ZOOM_DEFAULT;
	return Math.max(VIEW_CONTENT_ZOOM_MIN, Math.min(VIEW_CONTENT_ZOOM_MAX, value));
}

/** 列表卡片高度 / 网格列宽：支持 `px`（会按范围钳制）或其它 CSS 长度单位。 */
export function normalizeNoteListDimensionCss(
	value: unknown,
	fallback: string,
	minPx: number,
	maxPx: number
): string {
	const clampPx = (n: number) => `${Math.max(minPx, Math.min(maxPx, Math.round(n)))}px`;
	const normalizeFallback = (): string => {
		const t = fallback.trim();
		const bare = /^(\d+(?:\.\d+)?)$/.exec(t);
		if (bare) {
			const n = parseFloat(bare[1] ?? '');
			return Number.isFinite(n) ? clampPx(n) : t;
		}
		const pxM = /^(\d+(?:\.\d+)?)\s*px$/i.exec(t);
		if (pxM) {
			const n = parseFloat(pxM[1] ?? '');
			return Number.isFinite(n) ? clampPx(n) : t;
		}
		return t || fallback;
	};

	if (typeof value === 'number' && Number.isFinite(value)) {
		return clampPx(value);
	}
	if (typeof value !== 'string') return normalizeFallback();
	const s = value.trim();
	if (!s) return normalizeFallback();

	const bare = /^(\d+(?:\.\d+)?)$/.exec(s);
	if (bare) {
		const n = parseFloat(bare[1] ?? '');
		return Number.isFinite(n) ? clampPx(n) : normalizeFallback();
	}
	const pxM = /^(\d+(?:\.\d+)?)\s*px$/i.exec(s);
	if (pxM) {
		const n = parseFloat(pxM[1] ?? '');
		return Number.isFinite(n) ? clampPx(n) : normalizeFallback();
	}

	const compact = s.replace(/\s+/g, '');
	if (/^[\d.]+[a-z%]+$/i.test(compact) && compact.length <= 24) {
		return s;
	}
	return normalizeFallback();
}

export interface ColorfulStickyNotesSettings {
	stickyFolder: string;
	filenameTemplate: string;
	defaultTemplatePath: string;
	defaultViewMode: 'preview' | 'source';
	/** 浮动便笺内 `.view-content` 的 `zoom`。 */
	stickyViewContentZoom: number;
	/** 便笺列表预览卡片正文的 `zoom`。 */
	noteListViewContentZoom: number;
	bottomBarAutoHide: boolean;
	/** 左右贴边时自动拉伸窗口高度；移开贴边后恢复原高度。 */
	stickyEdgeAutoStretchHeight: boolean;
	/** 双击便笺头部切换拉伸/恢复。 */
	stickyHeaderDoubleClickStretch: boolean;
	/** 阅读（预览）模式下，双击便笺主体区域（.csn-sticky-main）切换到编辑模式。 */
	stickyMainDoubleClickToEdit: boolean;
	/** 辅助对齐吸附的触发方式：`none` 关闭；`auto` 拖动即吸附；`ctrl` 未绑定时按住 Ctrl 吸附，已在绑定组时按住 Ctrl 解绑。 */
	stickyAssistAlignSnapMode: StickyAssistAlignSnapMode;
	/** 吸附阈值（px）。 */
	stickyAssistAlignSnapThresholdPx: number;
	/**
	 * 解除绑定时的「仍算在吸附带内」判定：相对吸附阈值的倍数（默认 2）。
	 * 实际使用 `round(吸附阈值 px × 本值)` 与绑定邻窗比对；仅影响 Ctrl 模式下解绑/保留绑定逻辑。
	 */
	stickyAssistAlignSnapUnbindRangeMultiplier: number;
	/** 吸附后自动绑定；绑定窗口可连带移动。 */
	stickyAssistAlignBind: boolean;
	/** 启动 Obsidian 后自动恢复上次便笺浮动窗口（与「打开便笺窗口（恢复上次会话）」一致）。 */
	restoreStickySessionOnStartup: boolean;
	/** 启动恢复便笺前的等待秒数（0–10），仅在开启「启动时打开上次便笺」时生效。 */
	restoreStickySessionDelaySec: number;
	/** 便笺列表卡片预览区（`.csn-list-card-body--rendered`）是否使用 `overflow: auto` 在区域内滚动（默认开启）。关闭后为 `overflow: visible`。 */
	noteListCardOverflowHidden: boolean;
	/** 便笺列表卡片高度（CSS 长度，默认 `160px`；可用 rem、% 等）。 */
	noteListCardHeight: string;
	/** 便笺列表网格单列最小宽度（CSS 长度，默认 `320px`）。 */
	noteListGridMinWidth: string;
	/** 便笺列表分页：每页显示的卡片数量。 */
	noteListPageSize: number;
	/** 便笺列表排序（默认：创建时间新在前）。 */
	noteListSort: NoteListSort;
	/** 便笺列表置顶路径（靠前优先显示；顺序即置顶顺序）。 */
	noteListPinnedPaths: string[];
	/** 便笺列表按背景色多选筛选（空数组表示显示全部）。 */
	noteListColorFilters: StickyColorId[];
	/** 便笺列表按单个工作区快照筛选；`null` = 不选，显示便笺目录下全部。 */
	noteListWorkspaceFilterId: string | null;
	/** 便笺列表：仅显示已打开浮动窗口 / 未打开 / 全部。 */
	noteListFloatOpenFilter: NoteListFloatOpenFilter;
	/** 便笺列表：按归档属性筛选（`colorful-sticky-archived`）。 */
	noteListArchiveFilter: NoteListArchiveFilter;
	/** 便笺列表首次打开时的挂载位置。 */
	noteListOpenLocation: NoteListOpenLocation;
	/** 关闭空白便笺移入回收站前是否弹出确认框（默认开启）。 */
	confirmBlankStickyTrashOnClose: boolean;
	/** 新建便笺窗口默认宽度（px）。 */
	defaultNewStickyWidth: number;
	/** 新建便笺窗口默认高度（px）。 */
	defaultNewStickyHeight: number;
	/** 新建便笺默认背景（写入 frontmatter；与色条顺序第一项一致时为「亮黄」）。 */
	defaultNewStickyBackground: StickyColorId;
	/** 便笺头部「+」新建时相对当前窗口的优先侧（相邻左侧 / 相邻右侧）。 */
	headerNewStickyAdjacentSide: HeaderNewStickyAdjacentSide;
	/** 列表拖入 Canvas 时，文件节点默认宽度（px）。 */
	canvasLinkNodeWidth: number;
	/** 列表拖入 Canvas 时，文件节点默认高度（px）。 */
	canvasLinkNodeHeight: number;
	/** 列表拖入 Canvas 后，是否自动双击底边以贴合内容高度。 */
	canvasLinkAutoFitHeight: boolean;
	/** 列表拖入 Canvas 时是否同步节点颜色。 */
	canvasLinkMatchColor: boolean;
	/** 列表拖入 Canvas 后是否将画布 zoom 至当前选中（新建）节点。 */
	canvasLinkZoomToSelection: boolean;
	/** 列表拖拽时是否显示 Canvas 拖拽行为提示。 */
	canvasLinkShowDragHint: boolean;
	/** 列表批量拖入 Canvas 时相邻卡片的间隔（px）。 */
	canvasLinkBatchGridGap: number;
	/** 列表批量拖入 Canvas 时每行最大卡片数量。 */
	canvasLinkBatchMaxPerRow: number;
	/**
	 * @deprecated 旧版「纵向错开」的设置键，保留用于迁移到 `canvasLinkBatchGridGap`。
	 * 不再用于排布计算，也不再在设置 UI 中展示。
	 */
	canvasLinkBatchStackDy: number;
}

export const DEFAULT_SETTINGS: ColorfulStickyNotesSettings = {
	stickyFolder: 'StickyNotes',
	filenameTemplate: 'YYYY/YYYY-MM-DD',
	defaultTemplatePath: '',
	defaultViewMode: 'source',
	stickyViewContentZoom: VIEW_CONTENT_ZOOM_DEFAULT,
	noteListViewContentZoom: VIEW_CONTENT_ZOOM_DEFAULT,
	bottomBarAutoHide: false,
	stickyEdgeAutoStretchHeight: false,
	stickyHeaderDoubleClickStretch: false,
	stickyMainDoubleClickToEdit: true,
	stickyAssistAlignSnapMode: 'ctrl',
	stickyAssistAlignSnapThresholdPx: 10,
	stickyAssistAlignSnapUnbindRangeMultiplier: 2,
	stickyAssistAlignBind: true,
	restoreStickySessionOnStartup: false,
	restoreStickySessionDelaySec: 3,
	noteListCardOverflowHidden: true,
	noteListCardHeight: '160px',
	noteListGridMinWidth: '320px',
	noteListPageSize: 12,
	noteListSort: 'ctime-desc',
	noteListPinnedPaths: [],
	noteListColorFilters: [],
	noteListWorkspaceFilterId: null,
	noteListFloatOpenFilter: 'all',
	noteListArchiveFilter: 'all',
	noteListOpenLocation: 'right-sidebar',
	confirmBlankStickyTrashOnClose: true,
	defaultNewStickyWidth: 420,
	defaultNewStickyHeight: 360,
	defaultNewStickyBackground: 'yellow',
	headerNewStickyAdjacentSide: 'left',
	canvasLinkNodeWidth: 420,
	canvasLinkNodeHeight: 320,
	canvasLinkAutoFitHeight: true,
	canvasLinkMatchColor: true,
	canvasLinkZoomToSelection: false,
	canvasLinkShowDragHint: true,
	canvasLinkBatchGridGap: 24,
	canvasLinkBatchMaxPerRow: 10,
	canvasLinkBatchStackDy: 24
};

export class ColorfulStickyNotesSettingTab extends PluginSettingTab {
	plugin: ColorfulStickyNotesPlugin;

	constructor(app: App, plugin: ColorfulStickyNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setHeading().setName(t('SETTINGS_HEADING_BASIC'));
		new Setting(containerEl)
			.setName(t('SETTINGS_STICKY_FOLDER_NAME'))
			.setDesc(t('SETTINGS_STICKY_FOLDER_DESC'))
			.addButton(btn => {
				btn.setButtonText(t('SETTINGS_CHOOSE_FOLDER')).onClick(() => {
					const m = new FolderPickerModal(this.app, path => {
						void (async () => {
							this.plugin.settings.stickyFolder = path;
							await this.plugin.saveSettings();
							m.close();
							this.display();
						})();
					});
					m.open();
				});
			})
			.addText(text => {
				text
					.setPlaceholder('Sticky notes')
					.setValue(this.plugin.settings.stickyFolder)
					.onChange(async v => {
						this.plugin.settings.stickyFolder = v || 'StickyNotes';
						await this.plugin.saveSettings();
					});
			});

		const refreshFilenamePreview = (lineEl: HTMLElement, templateRaw?: string): void => {
			lineEl.empty();
			lineEl.createSpan({ cls: 'csn-filename-preview-label', text: t('SETTINGS_FILENAME_PREVIEW_LABEL') });
			const src = templateRaw !== undefined ? templateRaw : this.plugin.settings.filenameTemplate;
			const raw = (src || '').trim() || 'YYYY/YYYY-MM-DD';
			const sample = formatStickyNoteRelativePath(raw);
			lineEl.createSpan({
				cls: 'csn-filename-preview-path',
				text: sample === 'invalid-format' ? t('SETTINGS_FILENAME_INVALID') : `${sample}.md`
			});
		};

		const filenameSetting = new Setting(containerEl).setName(t('SETTINGS_FILENAME_FORMAT_NAME'));

		filenameSetting.descEl.empty();
		const descP = filenameSetting.descEl.createEl('p', { cls: 'csn-setting-filename-desc' });
		const momentA = descP.createEl('a', {
			href: 'https://momentjs.com/docs/#/displaying/format/',
			text: t('SETTINGS_FILENAME_MOMENT_LINK'),
			cls: 'external-link'
		});
		momentA.setAttr('target', '_blank');
		momentA.setAttr('rel', 'noopener noreferrer');
		descP.appendText(t('SETTINGS_FILENAME_DESC_TAIL'));

		const previewLine = filenameSetting.descEl.createDiv({ cls: 'csn-filename-preview-line' });
		refreshFilenamePreview(previewLine);

		filenameSetting.addText(text => {
			text.setValue(this.plugin.settings.filenameTemplate).onChange(async v => {
				this.plugin.settings.filenameTemplate = v;
				await this.plugin.saveSettings();
				refreshFilenamePreview(previewLine, text.getValue());
			});
			text.inputEl.addEventListener('input', () => {
				refreshFilenamePreview(previewLine, text.getValue());
			});
		});

		new Setting(containerEl)
			.setName(t('SETTINGS_DEFAULT_TEMPLATE_NAME'))
			.setDesc(t('SETTINGS_DEFAULT_TEMPLATE_DESC'))
			.addButton(btn => {
				btn.setButtonText(t('SETTINGS_CHOOSE_TEMPLATE_NOTE')).onClick(() => {
					const m = new MarkdownFilePickerModal(this.app, path => {
						void (async () => {
							this.plugin.settings.defaultTemplatePath = path;
							await this.plugin.saveSettings();
							m.close();
							this.display();
						})();
					});
					m.open();
				});
			})
			.addText(text =>
				text
					.setPlaceholder(t('SETTINGS_DEFAULT_TEMPLATE_PLACEHOLDER'))
					.setValue(this.plugin.settings.defaultTemplatePath)
					.onChange(async v => {
						this.plugin.settings.defaultTemplatePath = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setHeading().setName(t('SETTINGS_HEADING_STICKY_WINDOW'));
		new Setting(containerEl)
			.setName(t('SETTINGS_RESTORE_ON_STARTUP_NAME'))
			.setDesc(t('SETTINGS_RESTORE_ON_STARTUP_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.restoreStickySessionOnStartup).onChange(async v => {
					this.plugin.settings.restoreStickySessionOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_RESTORE_DELAY_NAME'))
			.setDesc(t('SETTINGS_RESTORE_DELAY_DESC'))
			.addSlider(slider =>
				slider
					.setLimits(0, 10, 1)
					.setValue(this.plugin.settings.restoreStickySessionDelaySec)
					.setDynamicTooltip()
					.setInstant(true)
					.onChange(async v => {
						this.plugin.settings.restoreStickySessionDelaySec = Math.round(v);
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton(btn =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip(t('SETTINGS_RESTORE_DELAY_RESET_TOOLTIP'))
					.onClick(async () => {
						this.plugin.settings.restoreStickySessionDelaySec =
							DEFAULT_SETTINGS.restoreStickySessionDelaySec;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_HEADER_NEW_SIDE_NAME'))
			.setDesc(t('SETTINGS_HEADER_NEW_SIDE_DESC'))
			.addDropdown(dd =>
				dd
					.addOption('left', t('SETTINGS_ADJACENT_LEFT'))
					.addOption('right', t('SETTINGS_ADJACENT_RIGHT'))
					.setValue(this.plugin.settings.headerNewStickyAdjacentSide)
					.onChange(async v => {
						this.plugin.settings.headerNewStickyAdjacentSide = v as HeaderNewStickyAdjacentSide;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_DEFAULT_VIEW_NAME'))
			.addDropdown(dd =>
				dd
					.addOption('source', t('SETTINGS_MODE_SOURCE'))
					.addOption('preview', t('SETTINGS_MODE_PREVIEW'))
					.setValue(this.plugin.settings.defaultViewMode)
					.onChange(async v => {
						this.plugin.settings.defaultViewMode = v as 'preview' | 'source';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_STICKY_ZOOM_NAME'))
			.setDesc(
				t('SETTINGS_STICKY_ZOOM_DESC', {
					min: Math.round(VIEW_CONTENT_ZOOM_MIN * 100),
					max: Math.round(VIEW_CONTENT_ZOOM_MAX * 100)
				})
			)
			.addSlider(slider =>
				slider
					.setLimits(VIEW_CONTENT_ZOOM_MIN, VIEW_CONTENT_ZOOM_MAX, VIEW_CONTENT_ZOOM_STEP)
					.setValue(this.plugin.settings.stickyViewContentZoom)
					.setInstant(true)
					.setDynamicTooltip()
					.onChange(async v => {
						this.plugin.settings.stickyViewContentZoom = v;
						await this.plugin.saveSettings();
						this.plugin.syncStickyViewContentZoomToOpenViews();
					})
			)
			.addExtraButton(btn =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip(t('SETTINGS_RESET_ZOOM_TOOLTIP', { value: VIEW_CONTENT_ZOOM_DEFAULT }))
					.onClick(async () => {
						this.plugin.settings.stickyViewContentZoom = DEFAULT_SETTINGS.stickyViewContentZoom;
						await this.plugin.saveSettings();
						this.plugin.syncStickyViewContentZoomToOpenViews();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_DEFAULT_WIDTH_NAME'))
			.setDesc(t('SETTINGS_DEFAULT_WIDTH_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.defaultNewStickyWidth))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.defaultNewStickyWidth = Number.isFinite(n)
							? Math.max(200, Math.min(1600, n))
							: DEFAULT_SETTINGS.defaultNewStickyWidth;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_DEFAULT_HEIGHT_NAME'))
			.setDesc(t('SETTINGS_DEFAULT_HEIGHT_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.defaultNewStickyHeight))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.defaultNewStickyHeight = Number.isFinite(n)
							? Math.max(200, Math.min(1200, n))
							: DEFAULT_SETTINGS.defaultNewStickyHeight;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_DEFAULT_BG_NAME'))
			.setDesc(t('SETTINGS_DEFAULT_BG_DESC'))
			.addDropdown(dd => {
				for (const c of SHEET_COLOR_ORDER) {
					dd.addOption(c.id, t(c.labelKey));
				}
				return dd
					.setValue(this.plugin.settings.defaultNewStickyBackground)
					.onChange(async v => {
						this.plugin.settings.defaultNewStickyBackground = v as StickyColorId;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(t('SETTINGS_BOTTOM_BAR_AUTO_HIDE_NAME'))
			.setDesc(t('SETTINGS_BOTTOM_BAR_AUTO_HIDE_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.bottomBarAutoHide).onChange(async v => {
					this.plugin.settings.bottomBarAutoHide = v;
					await this.plugin.saveSettings();
					this.plugin.stickies.updateBottomBarsFromSettings();
				})
			);

		new Setting(containerEl).setHeading().setName(t('SETTINGS_HEADING_LIST'));
		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_OPEN_LOCATION_NAME'))
			.setDesc(t('SETTINGS_LIST_OPEN_LOCATION_DESC'))
			.addDropdown(dd =>
				dd
					.addOption('left-sidebar', t('SETTINGS_LIST_LEFT_SIDEBAR'))
					.addOption('right-sidebar', t('SETTINGS_LIST_RIGHT_SIDEBAR'))
					.addOption('new-tab', t('SETTINGS_LIST_NEW_TAB'))
					.setValue(this.plugin.settings.noteListOpenLocation)
					.onChange(async v => {
						this.plugin.settings.noteListOpenLocation = v as NoteListOpenLocation;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_CARD_HEIGHT_NAME'))
			.setDesc(t('SETTINGS_LIST_CARD_HEIGHT_DESC'))
			.addText(text =>
				text
					.setPlaceholder('160px')
					.setValue(this.plugin.settings.noteListCardHeight)
					.onChange(async v => {
						this.plugin.settings.noteListCardHeight = normalizeNoteListDimensionCss(
							v,
							DEFAULT_SETTINGS.noteListCardHeight,
							120,
							600
						);
						await this.plugin.saveSettings();
						this.plugin.syncNoteListGridMetricsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_GRID_MIN_WIDTH_NAME'))
			.setDesc(t('SETTINGS_LIST_GRID_MIN_WIDTH_DESC'))
			.addText(text =>
				text
					.setPlaceholder('320px')
					.setValue(this.plugin.settings.noteListGridMinWidth)
					.onChange(async v => {
						this.plugin.settings.noteListGridMinWidth = normalizeNoteListDimensionCss(
							v,
							DEFAULT_SETTINGS.noteListGridMinWidth,
							180,
							800
						);
						await this.plugin.saveSettings();
						this.plugin.syncNoteListGridMetricsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_PAGE_SIZE_NAME'))
			.setDesc(t('SETTINGS_LIST_PAGE_SIZE_DESC'))
			.addText(text =>
				text
					.setPlaceholder('12')
					.setValue(String(this.plugin.settings.noteListPageSize))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.noteListPageSize = Number.isFinite(n)
							? Math.max(4, Math.min(48, Math.round(n)))
							: DEFAULT_SETTINGS.noteListPageSize;
						await this.plugin.saveSettings();
						this.plugin.refreshStickyListPageSizeChanged();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_PREVIEW_ZOOM_NAME'))
			.setDesc(
				t('SETTINGS_LIST_PREVIEW_ZOOM_DESC', {
					min: Math.round(VIEW_CONTENT_ZOOM_MIN * 100),
					max: Math.round(VIEW_CONTENT_ZOOM_MAX * 100)
				})
			)
			.addSlider(slider =>
				slider
					.setLimits(VIEW_CONTENT_ZOOM_MIN, VIEW_CONTENT_ZOOM_MAX, VIEW_CONTENT_ZOOM_STEP)
					.setValue(this.plugin.settings.noteListViewContentZoom)
					.setInstant(true)
					.setDynamicTooltip()
					.onChange(async v => {
						this.plugin.settings.noteListViewContentZoom = v;
						await this.plugin.saveSettings();
						this.plugin.syncNoteListViewContentZoomToOpenViews();
					})
			)
			.addExtraButton(btn =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip(t('SETTINGS_RESET_ZOOM_TOOLTIP', { value: VIEW_CONTENT_ZOOM_DEFAULT }))
					.onClick(async () => {
						this.plugin.settings.noteListViewContentZoom = DEFAULT_SETTINGS.noteListViewContentZoom;
						await this.plugin.saveSettings();
						this.plugin.syncNoteListViewContentZoomToOpenViews();
						this.display();
					})
			);

		new Setting(containerEl).setHeading().setName(t('SETTINGS_HEADING_ASSIST_FEATURES'));
		new Setting(containerEl)
			.setName(t('SETTINGS_EDGE_STRETCH_NAME'))
			.setDesc(t('SETTINGS_EDGE_STRETCH_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.stickyEdgeAutoStretchHeight).onChange(async v => {
					this.plugin.settings.stickyEdgeAutoStretchHeight = v;
					await this.plugin.saveSettings();
					this.plugin.syncStickyEdgeAutoStretchToOpenViews();
				})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_HEADER_DOUBLE_CLICK_STRETCH_NAME'))
			.setDesc(t('SETTINGS_HEADER_DOUBLE_CLICK_STRETCH_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.stickyHeaderDoubleClickStretch).onChange(async v => {
					this.plugin.settings.stickyHeaderDoubleClickStretch = v;
					await this.plugin.saveSettings();
					this.plugin.syncStickyHeaderDoubleClickStretchToOpenViews();
				})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_MAIN_DBLCLICK_TO_SOURCE_NAME'))
			.setDesc(t('SETTINGS_MAIN_DBLCLICK_TO_SOURCE_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.stickyMainDoubleClickToEdit).onChange(async v => {
					this.plugin.settings.stickyMainDoubleClickToEdit = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_AUTO_DELETE_BLANK_NAME'))
			.setDesc(t('SETTINGS_AUTO_DELETE_BLANK_DESC'))
			.addToggle(toggle =>
				toggle.setValue(!this.plugin.settings.confirmBlankStickyTrashOnClose).onChange(async v => {
					this.plugin.settings.confirmBlankStickyTrashOnClose = !v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setHeading().setName(t('SETTINGS_HEADING_ASSIST'));
		new Setting(containerEl)
			.setName(t('SETTINGS_SNAP_TRIGGER_NAME'))
			.setDesc(t('SETTINGS_SNAP_TRIGGER_DESC'))
			.addDropdown(dd =>
				dd
					.addOption('none', t('SETTINGS_SNAP_TRIGGER_NONE'))
					.addOption('auto', t('SETTINGS_SNAP_TRIGGER_AUTO'))
					.addOption('ctrl', t('SETTINGS_SNAP_TRIGGER_CTRL'))
					.setValue(this.plugin.settings.stickyAssistAlignSnapMode)
					.onChange(async v => {
						this.plugin.settings.stickyAssistAlignSnapMode = v as StickyAssistAlignSnapMode;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_SNAP_THRESHOLD_NAME'))
			.setDesc(t('SETTINGS_SNAP_THRESHOLD_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.stickyAssistAlignSnapThresholdPx))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.stickyAssistAlignSnapThresholdPx = Number.isFinite(n)
							? Math.max(1, Math.min(50, n))
							: DEFAULT_SETTINGS.stickyAssistAlignSnapThresholdPx;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_BIND_AFTER_SNAP_NAME'))
			.setDesc(t('SETTINGS_BIND_AFTER_SNAP_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.stickyAssistAlignBind).onChange(async v => {
					this.plugin.settings.stickyAssistAlignBind = v;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_SNAP_UNBIND_RANGE_MULT_NAME'))
			.setDesc(t('SETTINGS_SNAP_UNBIND_RANGE_MULT_DESC'))
			.addSlider(slider =>
				slider
					.setLimits(1, 8, 0.1)
					.setValue(this.plugin.settings.stickyAssistAlignSnapUnbindRangeMultiplier)
					.setInstant(true)
					.setDynamicTooltip()
					.onChange(async v => {
						const n = Math.max(1, Math.min(8, Math.round(v * 10) / 10));
						this.plugin.settings.stickyAssistAlignSnapUnbindRangeMultiplier = n;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton(btn =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip(
						t('SETTINGS_SNAP_UNBIND_RANGE_RESET_TOOLTIP', {
							value: String(DEFAULT_SETTINGS.stickyAssistAlignSnapUnbindRangeMultiplier)
						})
					)
					.onClick(async () => {
						this.plugin.settings.stickyAssistAlignSnapUnbindRangeMultiplier =
							DEFAULT_SETTINGS.stickyAssistAlignSnapUnbindRangeMultiplier;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl).setHeading().setName(t('SETTINGS_HEADING_CANVAS_LINK'));
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_CARD_WIDTH_NAME'))
			.setDesc(t('SETTINGS_CANVAS_CARD_WIDTH_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.canvasLinkNodeWidth))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.canvasLinkNodeWidth = Number.isFinite(n)
							? Math.max(120, Math.min(2000, n))
							: DEFAULT_SETTINGS.canvasLinkNodeWidth;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_CARD_HEIGHT_NAME'))
			.setDesc(t('SETTINGS_CANVAS_CARD_HEIGHT_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.canvasLinkNodeHeight))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.canvasLinkNodeHeight = Number.isFinite(n)
							? Math.max(80, Math.min(2000, n))
							: DEFAULT_SETTINGS.canvasLinkNodeHeight;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_CARD_AUTO_FIT_HEIGHT_NAME'))
			.setDesc(t('SETTINGS_CANVAS_CARD_AUTO_FIT_HEIGHT_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.canvasLinkAutoFitHeight).onChange(async v => {
					this.plugin.settings.canvasLinkAutoFitHeight = v;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_MATCH_COLOR_NAME'))
			.setDesc(t('SETTINGS_CANVAS_MATCH_COLOR_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.canvasLinkMatchColor).onChange(async v => {
					this.plugin.settings.canvasLinkMatchColor = v;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_ZOOM_SELECTION_NAME'))
			.setDesc(t('SETTINGS_CANVAS_ZOOM_SELECTION_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.canvasLinkZoomToSelection).onChange(async v => {
					this.plugin.settings.canvasLinkZoomToSelection = v;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_DRAG_HINT_NAME'))
			.setDesc(t('SETTINGS_CANVAS_DRAG_HINT_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.canvasLinkShowDragHint).onChange(async v => {
					this.plugin.settings.canvasLinkShowDragHint = v;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_BATCH_GAP_NAME'))
			.setDesc(t('SETTINGS_CANVAS_BATCH_GAP_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.canvasLinkBatchGridGap))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.canvasLinkBatchGridGap = Number.isFinite(n)
							? Math.max(0, Math.min(500, Math.round(n)))
							: DEFAULT_SETTINGS.canvasLinkBatchGridGap;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName(t('SETTINGS_CANVAS_BATCH_MAX_PER_ROW_NAME'))
			.setDesc(t('SETTINGS_CANVAS_BATCH_MAX_PER_ROW_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.canvasLinkBatchMaxPerRow))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.canvasLinkBatchMaxPerRow = Number.isFinite(n)
							? Math.max(1, Math.min(50, Math.round(n)))
							: DEFAULT_SETTINGS.canvasLinkBatchMaxPerRow;
						await this.plugin.saveSettings();
					})
			);
	}
}
