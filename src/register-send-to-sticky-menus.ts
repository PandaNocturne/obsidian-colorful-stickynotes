import { Menu, TAbstractFile, TFile, View } from 'obsidian';
import { around } from 'monkey-around';
import { t } from './lang/helpers';
import type ColorfulStickyNotesPlugin from './main';

/** 发送/移动：不在库内笔记中自动写入便笺 frontmatter（id / archived / 背景等）。 */
const sendStickyOpts = { markdownMode: 'preview' as const, skipStickyFrontmatterTouch: true as const };

function addSendToStickyMenuItem(menu: Menu, plugin: ColorfulStickyNotesPlugin, file: TFile): void {
	menu.addItem(item => {
		item
			.setTitle(t('CMD_SEND_TO_STICKY_WINDOW'))
			.setIcon('square-pen')
			.onClick(() => {
				void plugin.openStickyForFile(file, sendStickyOpts);
			});
	});
}

function addMoveToStickyMenuItem(menu: Menu, plugin: ColorfulStickyNotesPlugin, file: TFile): void {
	menu.addItem(item => {
		item
			.setTitle(t('CMD_MOVE_TO_STICKY_WINDOW'))
			.setIcon('picture-in-picture')
			.onClick(() => {
				void plugin.moveFileToStickyWindow(file, sendStickyOpts);
			});
	});
}

/**
 * 文件列表右键、多选右键、标签页右键：发送到便笺窗口 / 移动到便笺窗口。
 */
export function registerSendToStickyMenus(plugin: ColorfulStickyNotesPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
			if (!(file instanceof TFile)) return;
			addSendToStickyMenuItem(menu, plugin, file);
			addMoveToStickyMenuItem(menu, plugin, file);
		})
	);

	plugin.registerEvent(
		plugin.app.workspace.on('files-menu', (menu, files: TAbstractFile[]) => {
			const noteFiles = files.filter((f): f is TFile => f instanceof TFile);
			if (noteFiles.length === 0) return;
			menu.addItem(item => {
				item
					.setTitle(t('CMD_SEND_TO_STICKY_WINDOW'))
					.setIcon('square-pen')
					.onClick(() => {
						void (async () => {
							for (const f of noteFiles) {
								await plugin.openStickyForFile(f, sendStickyOpts);
							}
						})();
					});
			});
			menu.addItem(item => {
				item
					.setTitle(t('CMD_MOVE_TO_STICKY_WINDOW'))
					.setIcon('picture-in-picture')
					.onClick(() => {
						void (async () => {
							for (const f of noteFiles) {
								await plugin.moveFileToStickyWindow(f, sendStickyOpts);
							}
						})();
					});
			});
		})
	);

	const uninstall = around(View.prototype, {
		onPaneMenu(old) {
			return function (this: View, menu: Menu, source: string) {
				old.call(this, menu, source);
				if (source !== 'tab-header') return;
				const vf = 'file' in this ? (this as { file?: unknown }).file : undefined;
				if (!(vf instanceof TFile)) return;
				addSendToStickyMenuItem(menu, plugin, vf);
				addMoveToStickyMenuItem(menu, plugin, vf);
			};
		}
	});
	plugin.register(uninstall);
}
