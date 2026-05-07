import { App, PluginSettingTab, Setting } from 'obsidian';
import { formatStickyNoteRelativePath } from './filename-template';
import type ColorfulStickyNotesPlugin from './main';
import { FolderPickerModal } from './modals/FolderPickerModal';
import { SHEET_COLOR_ORDER } from './sticky/sticky-color-order';
import type { NoteListOpenLocation, NoteListSort, StickyColorId } from './types';

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
	/** 启动 Obsidian 后自动恢复上次便笺浮动窗口（与「打开便笺窗口（恢复上次会话）」一致）。 */
	restoreStickySessionOnStartup: boolean;
	/** 启动恢复便笺前的等待秒数（0–10），仅在开启「启动时打开上次便笺」时生效。 */
	restoreStickySessionDelaySec: number;
	/** 便笺列表卡片高度（像素，预览区所在整卡高度）。 */
	noteListCardHeight: number;
	/** 便笺列表网格单列最小宽度（像素，`minmax` 下限）。 */
	noteListGridMinWidth: number;
	/** 便笺列表分页：每页显示的卡片数量。 */
	noteListPageSize: number;
	/** 便笺列表排序（默认：创建时间新在前）。 */
	noteListSort: NoteListSort;
	/** 便笺列表按背景色多选筛选（空数组表示显示全部）。 */
	noteListColorFilters: StickyColorId[];
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
}

export const DEFAULT_SETTINGS: ColorfulStickyNotesSettings = {
	stickyFolder: 'StickyNotes',
	filenameTemplate: 'YYYY/YYYY-MM-DD',
	defaultTemplatePath: '',
	defaultViewMode: 'source',
	stickyViewContentZoom: VIEW_CONTENT_ZOOM_DEFAULT,
	noteListViewContentZoom: VIEW_CONTENT_ZOOM_DEFAULT,
	bottomBarAutoHide: true,
	restoreStickySessionOnStartup: false,
	restoreStickySessionDelaySec: 3,
	noteListCardHeight: 160,
	noteListGridMinWidth: 320,
	noteListPageSize: 12,
	noteListSort: 'ctime-desc',
	noteListColorFilters: [],
	noteListOpenLocation: 'right-sidebar',
	confirmBlankStickyTrashOnClose: true,
	defaultNewStickyWidth: 420,
	defaultNewStickyHeight: 360,
	defaultNewStickyBackground: 'yellow'
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
		containerEl.createEl('h2', { text: '多彩便笺' });

		containerEl.createEl('h3', { text: '基本' });
		new Setting(containerEl)
			.setName('便笺文件夹')
			.setDesc('新便笺将创建于此路径下。')
			.addButton(btn => {
				btn.setButtonText('选择…').onClick(() => {
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

		const filenameDesc = document.createDocumentFragment();
		filenameDesc.append(
			'与「核心插件 → 日记」一致：整段即 ',
			Object.assign(document.createElement('a'), {
				href: 'https://momentjs.com/docs/#/displaying/format/',
				textContent: 'Moment 格式',
				target: '_blank',
				rel: 'noopener noreferrer'
			}),
			'，无需 ',
			Object.assign(document.createElement('code'), { textContent: '{{date}}' }),
			'。格式中的 ',
			Object.assign(document.createElement('code'), { textContent: '/' }),
			' 会在「便笺文件夹」下创建子目录（例如 ',
			Object.assign(document.createElement('code'), { textContent: 'YYYY/YYYY-MM-DD' }),
			'）。旧版含 ',
			Object.assign(document.createElement('code'), { textContent: '{{date:…}}' }),
			' 的模板仍可使用。'
		);

		const refreshFilenamePreview = (box: HTMLElement): void => {
			box.empty();
			const raw = (this.plugin.settings.filenameTemplate || '').trim() || 'YYYY/YYYY-MM-DD';
			const sample = formatStickyNoteRelativePath(raw);
			const line = box.createDiv({ cls: 'csn-filename-sample-line' });
			line.appendText('这是当前所用格式的样例：');
			line.createEl('strong', {
				cls: 'csn-filename-sample-value',
				text: sample === 'invalid-format' ? '（格式无效）' : `${sample}.md`
			});
		};

		const filenameSetting = new Setting(containerEl)
			.setName('便笺文件名格式')
			.setDesc(filenameDesc)
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
			.setName('默认 Template 模板')
			.setDesc('新建便笺时写入模板文件内容（留空为新建空白）。填写库内笔记路径。')
			.addText(text =>
				text
					.setPlaceholder('例如 Templates/便笺模板.md')
					.setValue(this.plugin.settings.defaultTemplatePath)
					.onChange(async v => {
						this.plugin.settings.defaultTemplatePath = v;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: '窗口' });
		new Setting(containerEl)
			.setName('启动时打开上次便笺')
			.setDesc(
				'Obsidian 启动并完成布局后，自动恢复上次会话中的便笺窗口（与命令「打开便笺窗口（恢复上次会话）」相同）。'
			)
			.addToggle(t =>
				t.setValue(this.plugin.settings.restoreStickySessionOnStartup).onChange(async v => {
					this.plugin.settings.restoreStickySessionOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('启动恢复延迟')
			.setDesc('布局就绪后再等待若干秒再打开便笺；仅在「启动时打开上次便笺」开启时生效。')
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
					.setTooltip('重置为默认 3 秒')
					.onClick(async () => {
						this.plugin.settings.restoreStickySessionDelaySec =
							DEFAULT_SETTINGS.restoreStickySessionDelaySec;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('关闭空白便笺前确认删除')
			.setDesc(
				'关闭位于「便笺文件夹」下的空白 Markdown 便笺时，会先弹出确认再移入回收站。关闭本项则不再询问并直接删除。'
			)
			.addToggle(t =>
				t.setValue(this.plugin.settings.confirmBlankStickyTrashOnClose).onChange(async v => {
					this.plugin.settings.confirmBlankStickyTrashOnClose = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('默认视图')
			.addDropdown(dd =>
				dd
					.addOption('source', '编辑')
					.addOption('preview', '阅读')
					.setValue(this.plugin.settings.defaultViewMode)
					.onChange(async v => {
						this.plugin.settings.defaultViewMode = v as 'preview' | 'source';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('便笺窗口内容缩放')
			.setDesc(
				`浮动便笺正文显示比例（${Math.round(VIEW_CONTENT_ZOOM_MIN * 100)}%–${Math.round(VIEW_CONTENT_ZOOM_MAX * 100)}%）。`
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
					.setTooltip(`重置为默认 ${VIEW_CONTENT_ZOOM_DEFAULT}`)
					.onClick(async () => {
						this.plugin.settings.stickyViewContentZoom = DEFAULT_SETTINGS.stickyViewContentZoom;
						await this.plugin.saveSettings();
						this.plugin.syncStickyViewContentZoomToOpenViews();
						this.display();
					})
			);

		containerEl.createEl('h3', { text: '新建便笺' });
		new Setting(containerEl)
			.setName('默认宽度')
			.setDesc('新建便笺浮动窗口的初始宽度（像素）。从已有便笺旁新建时仍沿用当前窗口尺寸。')
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
			.setName('默认高度')
			.setDesc('新建便笺浮动窗口的初始高度（像素）。')
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
			.setName('默认背景')
			.setDesc(
				'无模板或模板未指定 colorful-sticky-bg 时，写入便笺的默认背景色（与便笺底部色条一致）。'
			)
			.addDropdown(dd => {
				for (const c of SHEET_COLOR_ORDER) {
					dd.addOption(c.id, c.label);
				}
				return dd
					.setValue(this.plugin.settings.defaultNewStickyBackground)
					.onChange(async v => {
						this.plugin.settings.defaultNewStickyBackground = v as StickyColorId;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: '便笺列表' });
		new Setting(containerEl)
			.setName('打开位置')
			.setDesc(
				'命令或功能区打开「便笺列表」时，若当前尚无该视图，则创建在指定位置；已固定或已打开的列表会切换到该视图。'
			)
			.addDropdown(dd =>
				dd
					.addOption('left-sidebar', '左侧侧边栏')
					.addOption('right-sidebar', '右侧侧边栏')
					.addOption('new-tab', '新标签页')
					.setValue(this.plugin.settings.noteListOpenLocation)
					.onChange(async v => {
						this.plugin.settings.noteListOpenLocation = v as NoteListOpenLocation;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('列表卡片高度')
			.setDesc('便笺列表网格中每张卡片的高度（像素）。')
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
			.setName('网格最小列宽')
			.setDesc('自适应网格中每列的最小宽度（像素）；侧栏较窄时列数会随之减少。')
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
			.setName('每页卡片数量')
			.setDesc('便笺列表分页时每一页最多显示的卡片数（4–48）；数值越大单页加载越多，滚动区可能略卡。')
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
			.setName('列表预览内容缩放')
			.setDesc(
				`列表卡片内 Markdown 预览比例（${Math.round(VIEW_CONTENT_ZOOM_MIN * 100)}%–${Math.round(VIEW_CONTENT_ZOOM_MAX * 100)}%），与浮动便笺窗口独立。`
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
					.setTooltip(`重置为默认 ${VIEW_CONTENT_ZOOM_DEFAULT}`)
					.onClick(async () => {
						this.plugin.settings.noteListViewContentZoom = DEFAULT_SETTINGS.noteListViewContentZoom;
						await this.plugin.saveSettings();
						this.plugin.syncNoteListViewContentZoomToOpenViews();
						this.display();
					})
			);

		containerEl.createEl('h3', { text: '底部工具栏' });
		new Setting(containerEl)
			.setName('自动隐藏')
			.setDesc('鼠标离开底部区域时隐藏底栏（左侧文件名与便笺设置）；打开设置抽屉时也会保持显示。')
			.addToggle(t =>
				t.setValue(this.plugin.settings.bottomBarAutoHide).onChange(async v => {
					this.plugin.settings.bottomBarAutoHide = v;
					await this.plugin.saveSettings();
					this.plugin.stickies.updateBottomBarsFromSettings();
				})
			);
	}
}
