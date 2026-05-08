import { App, PluginSettingTab, Setting } from 'obsidian';
import { formatStickyNoteRelativePath } from './filename-template';
import { t } from './lang/helpers';
import type ColorfulStickyNotesPlugin from './main';
import { FolderPickerModal } from './modals/FolderPickerModal';
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
	/** 便笺列表卡片高度（像素，预览区所在整卡高度）。 */
	noteListCardHeight: number;
	/** 便笺列表网格单列最小宽度（像素，`minmax` 下限）。 */
	noteListGridMinWidth: number;
	/** 便笺列表分页：每页显示的卡片数量。 */
	noteListPageSize: number;
	/** 便笺列表排序（默认：创建时间新在前）。 */
	noteListSort: NoteListSort;
	/** 便笺列表置顶路径（靠前优先显示；顺序即置顶顺序）。 */
	noteListPinnedPaths: string[];
	/** 便笺列表按背景色多选筛选（空数组表示显示全部）。 */
	noteListColorFilters: StickyColorId[];
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
}

export const DEFAULT_SETTINGS: ColorfulStickyNotesSettings = {
	stickyFolder: 'StickyNotes',
	filenameTemplate: 'YYYY/YYYY-MM-DD',
	defaultTemplatePath: '',
	defaultViewMode: 'source',
	stickyViewContentZoom: VIEW_CONTENT_ZOOM_DEFAULT,
	noteListViewContentZoom: VIEW_CONTENT_ZOOM_DEFAULT,
	bottomBarAutoHide: true,
	stickyEdgeAutoStretchHeight: true,
	stickyHeaderDoubleClickStretch: true,
	stickyAssistAlignSnapMode: 'ctrl',
	stickyAssistAlignSnapThresholdPx: 10,
	stickyAssistAlignSnapUnbindRangeMultiplier: 2,
	stickyAssistAlignBind: true,
	restoreStickySessionOnStartup: false,
	restoreStickySessionDelaySec: 3,
	noteListCardOverflowHidden: true,
	noteListCardHeight: 160,
	noteListGridMinWidth: 320,
	noteListPageSize: 12,
	noteListSort: 'ctime-desc',
	noteListPinnedPaths: [],
	noteListColorFilters: [],
	noteListFloatOpenFilter: 'all',
	noteListArchiveFilter: 'all',
	noteListOpenLocation: 'right-sidebar',
	confirmBlankStickyTrashOnClose: true,
	defaultNewStickyWidth: 420,
	defaultNewStickyHeight: 360,
	defaultNewStickyBackground: 'yellow',
	headerNewStickyAdjacentSide: 'left'
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
		containerEl.createEl('h2', { text: t('SETTINGS_PLUGIN_TITLE') });

		containerEl.createEl('h3', { text: t('SETTINGS_HEADING_GENERAL') });
		new Setting(containerEl)
			.setName(t('SETTINGS_STICKY_FOLDER_NAME'))
			.setDesc(t('SETTINGS_STICKY_FOLDER_DESC'))
			.addButton(btn => {
				btn.setButtonText(t('SETTINGS_CHOOSE_FOLDER')).onClick(() => {
					const m = new FolderPickerModal(this.app, async path => {
						this.plugin.settings.stickyFolder = path;
						await this.plugin.saveSettings();
						m.close();
						this.display();
					});
					m.open();
				});
			})
			.addText(text => {
				text
					.setPlaceholder('StickyNotes')
					.setValue(this.plugin.settings.stickyFolder)
					.onChange(async v => {
						this.plugin.settings.stickyFolder = v || 'StickyNotes';
						await this.plugin.saveSettings();
					});
			});

		const refreshFilenamePreview = (box: HTMLElement): void => {
			box.empty();
			const raw = (this.plugin.settings.filenameTemplate || '').trim() || 'YYYY/YYYY-MM-DD';
			const sample = formatStickyNoteRelativePath(raw);
			const line = box.createDiv({ cls: 'csn-filename-sample-line' });
			line.appendText(t('SETTINGS_FILENAME_SAMPLE_INTRO'));
			line.createEl('strong', {
				cls: 'csn-filename-sample-value',
				text: sample === 'invalid-format' ? t('SETTINGS_FILENAME_INVALID') : `${sample}.md`
			});
		};

		const filenameSetting = new Setting(containerEl)
			.setName(t('SETTINGS_FILENAME_FORMAT_NAME'))
			.setDesc(t('SETTINGS_FILENAME_DESC'))
			.addText(text =>
				text
					.setValue(this.plugin.settings.filenameTemplate)
					.onChange(async v => {
						this.plugin.settings.filenameTemplate = v;
						await this.plugin.saveSettings();
						refreshFilenamePreview(previewBox);
					})
			);

		const infoParent =
			filenameSetting.settingEl.querySelector('.setting-item-info') ?? filenameSetting.settingEl;
		const previewBox = infoParent
			.createDiv({ cls: 'csn-setting-filename-preview-wrap' })
			.createDiv({ cls: 'csn-setting-filename-preview-box' });
		refreshFilenamePreview(previewBox);

		new Setting(containerEl)
			.setName(t('SETTINGS_DEFAULT_TEMPLATE_NAME'))
			.setDesc(t('SETTINGS_DEFAULT_TEMPLATE_DESC'))
			.addText(text =>
				text
					.setPlaceholder(t('SETTINGS_DEFAULT_TEMPLATE_PLACEHOLDER'))
					.setValue(this.plugin.settings.defaultTemplatePath)
					.onChange(async v => {
						this.plugin.settings.defaultTemplatePath = v;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: t('SETTINGS_HEADING_WINDOW') });
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
			.setName(t('SETTINGS_CONFIRM_BLANK_TRASH_NAME'))
			.setDesc(t('SETTINGS_CONFIRM_BLANK_TRASH_DESC'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.confirmBlankStickyTrashOnClose).onChange(async v => {
					this.plugin.settings.confirmBlankStickyTrashOnClose = v;
					await this.plugin.saveSettings();
				})
			);

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

		containerEl.createEl('h3', { text: t('SETTINGS_HEADING_ASSIST') });
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
			.setName(t('SETTINGS_SNAP_UNBIND_RANGE_MULT_NAME'))
			.setDesc(t('SETTINGS_SNAP_UNBIND_RANGE_MULT_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.stickyAssistAlignSnapUnbindRangeMultiplier))
					.onChange(async v => {
						const n = parseFloat(v.replace(/,/g, '.'));
						this.plugin.settings.stickyAssistAlignSnapUnbindRangeMultiplier = Number.isFinite(n)
							? Math.max(1, Math.min(8, Math.round(n * 10) / 10))
							: DEFAULT_SETTINGS.stickyAssistAlignSnapUnbindRangeMultiplier;
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

		containerEl.createEl('h3', { text: t('SETTINGS_HEADING_NEW_STICKY') });
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

		containerEl.createEl('h3', { text: t('SETTINGS_HEADING_LIST') });
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
			.setName(t('SETTINGS_LIST_CARD_OVERFLOW_NAME'))
			.setDesc(t('SETTINGS_LIST_CARD_OVERFLOW_DESC'))
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.noteListCardOverflowHidden)
					.onChange(async v => {
						this.plugin.settings.noteListCardOverflowHidden = v;
						await this.plugin.saveSettings();
						this.plugin.syncNoteListGridMetricsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_CARD_HEIGHT_NAME'))
			.setDesc(t('SETTINGS_LIST_CARD_HEIGHT_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.noteListCardHeight))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.noteListCardHeight = Number.isFinite(n)
							? Math.max(120, Math.min(600, n))
							: DEFAULT_SETTINGS.noteListCardHeight;
						await this.plugin.saveSettings();
						this.plugin.syncNoteListGridMetricsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_GRID_MIN_WIDTH_NAME'))
			.setDesc(t('SETTINGS_LIST_GRID_MIN_WIDTH_DESC'))
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.noteListGridMinWidth))
					.onChange(async v => {
						const n = parseInt(v, 10);
						this.plugin.settings.noteListGridMinWidth = Number.isFinite(n)
							? Math.max(180, Math.min(800, n))
							: DEFAULT_SETTINGS.noteListGridMinWidth;
						await this.plugin.saveSettings();
						this.plugin.syncNoteListGridMetricsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(t('SETTINGS_LIST_PAGE_SIZE_NAME'))
			.setDesc(t('SETTINGS_LIST_PAGE_SIZE_DESC'))
			.addText(text =>
				text
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

		containerEl.createEl('h3', { text: t('SETTINGS_HEADING_BOTTOM_BAR') });
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
	}
}
