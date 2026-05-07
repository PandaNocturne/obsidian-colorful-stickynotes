import { App, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { formatStickyNoteRelativePath } from './filename-template';
import type ColorfulStickyNotesPlugin from './main';
import { FolderPickerModal } from './modals/FolderPickerModal';

export interface BottomBarCommand {
	id: string;
	icon: string;
	tooltip: string;
}

export interface ColorfulStickyNotesSettings {
	stickyFolder: string;
	filenameTemplate: string;
	defaultTemplatePath: string;
	defaultViewMode: 'preview' | 'source';
	defaultPositionMode: 'center' | 'custom';
	defaultPositionX: number;
	defaultPositionY: number;
	bottomBarAutoHide: boolean;
	bottomBarCommands: BottomBarCommand[];
}

export const DEFAULT_SETTINGS: ColorfulStickyNotesSettings = {
	stickyFolder: 'StickyNotes',
	filenameTemplate: 'YYYY/YYYY-MM-DD',
	defaultTemplatePath: '',
	defaultViewMode: 'source',
	defaultPositionMode: 'center',
	defaultPositionX: 80,
	defaultPositionY: 80,
	bottomBarAutoHide: true,
	bottomBarCommands: [
		{ id: 'editor:toggle-bold', icon: 'bold', tooltip: '加粗' },
		{ id: 'editor:toggle-italics', icon: 'italic', tooltip: '倾斜' },
		{ id: 'editor:insert-link', icon: 'link', tooltip: '链接' },
		{ id: 'editor:toggle-ulist', icon: 'list', tooltip: '无序列表' },
		{ id: 'editor:attach-file', icon: 'image', tooltip: '添加图片/附件' }
	]
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

		const filenameBlock = containerEl.createDiv({ cls: 'csn-setting-filename-block' });
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

		const refreshFilenamePreview = (previewEl: HTMLElement): void => {
			previewEl.empty();
			const raw = (this.plugin.settings.filenameTemplate || '').trim() || 'YYYY/YYYY-MM-DD';
			const sample = formatStickyNoteRelativePath(raw);
			const line = previewEl.createDiv({ cls: 'csn-filename-sample-line' });
			line.appendText('这是当前所用格式的样例：');
			line.createEl('strong', {
				cls: 'csn-filename-sample-value',
				text: sample === 'invalid-format' ? '（格式无效）' : `${sample}.md`
			});
		};

		new Setting(filenameBlock)
			.setName('便笺文件名格式')
			.setDesc(filenameDesc)
			.addText(text =>
				text
					.setValue(this.plugin.settings.filenameTemplate)
					.onChange(async v => {
						this.plugin.settings.filenameTemplate = v;
						await this.plugin.saveSettings();
						refreshFilenamePreview(previewEl);
					})
			);
		const previewEl = filenameBlock.createDiv({ cls: 'csn-setting-filename-preview' });
		refreshFilenamePreview(previewEl);

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

		containerEl.createEl('h3', { text: '底部工具栏' });
		new Setting(containerEl)
			.setName('自动隐藏')
			.setDesc('鼠标离开底部区域时隐藏工具栏（悬浮时显示）。')
			.addToggle(t =>
				t.setValue(this.plugin.settings.bottomBarAutoHide).onChange(async v => {
					this.plugin.settings.bottomBarAutoHide = v;
					await this.plugin.saveSettings();
					this.plugin.stickies.updateBottomBarsFromSettings();
				})
			);

		new Setting(containerEl)
			.setName('已固定的命令')
			.setDesc('在便笺窗口底部显示；在窗口内点击「+」可继续添加。')
			.addButton(btn =>
				btn.setButtonText('清空').onClick(async () => {
					this.plugin.settings.bottomBarCommands = [];
					await this.plugin.saveSettings();
					this.plugin.stickies.updateBottomBarsFromSettings();
					this.display();
				})
			);

		for (let i = 0; i < this.plugin.settings.bottomBarCommands.length; i++) {
			const cmd = this.plugin.settings.bottomBarCommands[i]!;
			const row = containerEl.createDiv({ cls: 'csn-cmd-row' });
			row.createSpan({ text: cmd.tooltip || cmd.id, cls: 'csn-cmd-label' });
			const btn = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '删除' } });
			setIcon(btn, 'minus-circle');
			btn.addEventListener('click', async () => {
				this.plugin.settings.bottomBarCommands.splice(i, 1);
				await this.plugin.saveSettings();
				this.plugin.stickies.updateBottomBarsFromSettings();
				this.display();
			});
		}
	}
}
