import { App, PluginSettingTab, Setting } from 'obsidian';
import { formatStickyNoteRelativePath } from './filename-template';
import type ColorfulStickyNotesPlugin from './main';
import { FolderPickerModal } from './modals/FolderPickerModal';

export interface ColorfulStickyNotesSettings {
	stickyFolder: string;
	filenameTemplate: string;
	defaultTemplatePath: string;
	defaultViewMode: 'preview' | 'source';
	defaultPositionMode: 'center' | 'custom';
	defaultPositionX: number;
	defaultPositionY: number;
	/** 便笺内 `.view-content` 的 `zoom`（0.5–1），与阅读/编辑正文显示比例一致。 */
	viewContentZoom: number;
	bottomBarAutoHide: boolean;
	/** 启动 Obsidian 后自动恢复上次便笺浮动窗口（与「打开便笺窗口（恢复上次会话）」一致）。 */
	restoreStickySessionOnStartup: boolean;
	/** 启动恢复便笺前的等待秒数（0–10），仅在开启「启动时打开上次便笺」时生效。 */
	restoreStickySessionDelaySec: number;
	/** 便笺列表：纵向卡片列表或自适应网格。 */
	noteListLayout: 'column' | 'grid';
	/** 关闭空白便笺移入回收站前是否弹出确认框（默认开启）。 */
	confirmBlankStickyTrashOnClose: boolean;
}

export const DEFAULT_SETTINGS: ColorfulStickyNotesSettings = {
	stickyFolder: 'StickyNotes',
	filenameTemplate: 'YYYY/YYYY-MM-DD',
	defaultTemplatePath: '',
	defaultViewMode: 'source',
	defaultPositionMode: 'center',
	defaultPositionX: 80,
	defaultPositionY: 80,
	viewContentZoom: 0.6,
	bottomBarAutoHide: true,
	restoreStickySessionOnStartup: false,
	restoreStickySessionDelaySec: 3,
	noteListLayout: 'column',
	confirmBlankStickyTrashOnClose: true
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
			.setName('内容缩放')
			.setDesc('便笺窗口内笔记正文的显示比例（50%–100%），通过 CSS zoom 作用于阅读/编辑区域。')
			.addSlider(slider =>
				slider
					.setLimits(0.5, 1, 0.05)
					.setValue(this.plugin.settings.viewContentZoom)
					.setInstant(true)
					.setDynamicTooltip()
					.onChange(async v => {
						this.plugin.settings.viewContentZoom = v;
						await this.plugin.saveSettings();
						this.plugin.stickies.updateViewContentZoomFromSettings();
					})
			);

		new Setting(containerEl)
			.setName('默认位置')
			.setDesc('新建便笺窗口出现的位置（不含已保存的工作区布局）。')
			.addDropdown(dd =>
				dd
					.addOption('center', '屏幕居中')
					.addOption('custom', '自定义坐标')
					.setValue(this.plugin.settings.defaultPositionMode)
					.onChange(async v => {
						this.plugin.settings.defaultPositionMode = v as 'center' | 'custom';
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.defaultPositionMode === 'custom') {
			new Setting(containerEl)
				.setName('距左侧（px）')
				.addText(text =>
					text
						.setValue(String(this.plugin.settings.defaultPositionX))
						.onChange(async v => {
							const n = parseInt(v, 10);
							this.plugin.settings.defaultPositionX = Number.isFinite(n) ? n : 0;
							await this.plugin.saveSettings();
						})
				);
			new Setting(containerEl)
				.setName('距顶部（px）')
				.addText(text =>
					text
						.setValue(String(this.plugin.settings.defaultPositionY))
						.onChange(async v => {
							const n = parseInt(v, 10);
							this.plugin.settings.defaultPositionY = Number.isFinite(n) ? n : 0;
							await this.plugin.saveSettings();
						})
				);
		}

		containerEl.createEl('h3', { text: '便笺列表' });
		new Setting(containerEl)
			.setName('默认布局')
			.setDesc('在便笺列表视图内也可随时切换；此处为打开列表时的默认排布。')
			.addDropdown(dd =>
				dd
					.addOption('column', '纵向列表')
					.addOption('grid', '自适应网格')
					.setValue(this.plugin.settings.noteListLayout)
					.onChange(async v => {
						this.plugin.settings.noteListLayout = v as 'column' | 'grid';
						await this.plugin.saveSettings();
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
