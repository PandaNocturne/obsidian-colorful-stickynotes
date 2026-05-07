import { Notice, Plugin, TFile } from 'obsidian';
import { ColorfulStickyNotesSettingTab, DEFAULT_SETTINGS, type ColorfulStickyNotesSettings } from './settings';
import { WorkspacePanelModal } from './modals/WorkspacePanelModal';
import { StickyNoteManager } from './sticky/StickyNoteManager';
import { StickyNoteListView } from './views/StickyNoteListView';
import { VIEW_STICKY_NOTE_LIST } from './types';

export default class ColorfulStickyNotesPlugin extends Plugin {
	settings!: ColorfulStickyNotesSettings;
	stickies!: StickyNoteManager;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.stickies = new StickyNoteManager(this, this.app);
		await this.stickies.init();

		this.registerView(VIEW_STICKY_NOTE_LIST, leaf => new StickyNoteListView(leaf, this));

		this.addRibbonIcon('square-pen', '打开便笺', () => {
			void this.restoreStickySession();
		});

		this.addRibbonIcon('layout-list', '便笺列表', () => {
			void this.openNoteListView();
		});

		this.addRibbonIcon('layout', '便笺工作区', () => {
			this.openWorkspacePanel();
		});

		this.addCommand({
			id: 'open-sticky-note-windows',
			name: '打开便笺窗口（恢复上次会话）',
			callback: () => {
				void this.restoreStickySession();
			}
		});

		this.addCommand({
			id: 'open-sticky-note-list',
			name: '打开便笺列表',
			callback: () => {
				void this.openNoteListView();
			}
		});

		this.addCommand({
			id: 'open-sticky-workspace-panel',
			name: '打开便笺工作区',
			callback: () => {
				this.openWorkspacePanel();
			}
		});

		this.addSettingTab(new ColorfulStickyNotesSettingTab(this.app, this));

		if (this.settings.restoreStickySessionOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				void this.restoreStickySession();
			});
		}
	}

	onunload(): void {
		/* 勿 detach 便笺列表：重载插件时不应关闭用户已固定在侧栏的叶视图。 */
		this.stickies?.onunload();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as ColorfulStickyNotesSettings;
		delete (this.settings as unknown as Record<string, unknown>).bottomBarCommands;
		const z = this.settings.viewContentZoom;
		if (typeof z !== 'number' || !Number.isFinite(z)) {
			this.settings.viewContentZoom = DEFAULT_SETTINGS.viewContentZoom;
		} else {
			this.settings.viewContentZoom = Math.max(0.5, Math.min(1, z));
		}
		const layout = this.settings.noteListLayout;
		if (layout !== 'column' && layout !== 'grid') {
			this.settings.noteListLayout = DEFAULT_SETTINGS.noteListLayout;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	openWorkspacePanel(): void {
		new WorkspacePanelModal(this.app, this).open();
	}

	async openNoteListView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_STICKY_NOTE_LIST)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) {
				new Notice('无法创建右侧分栏');
				return;
			}
			await right.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
			leaf = right;
		} else {
			await leaf.setViewState({ type: VIEW_STICKY_NOTE_LIST, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/** 打开或聚焦指定文件的便笺窗口 */
	async openStickyForFile(file: TFile): Promise<void> {
		await this.stickies.openStickyForFile(file);
	}

	private async restoreStickySession(): Promise<void> {
		await this.stickies.restoreWorkspaceWindows();
	}
}
