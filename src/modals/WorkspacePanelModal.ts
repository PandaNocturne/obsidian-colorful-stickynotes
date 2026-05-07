import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { saveWorkspacesFile } from '../workspace-store';
import type { StickyWorkspace } from '../types';

export class WorkspacePanelModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: ColorfulStickyNotesPlugin
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('便笺工作区');
		this.contentEl.empty();
		this.contentEl.addClass('csn-workspace-panel');

		const mgr = this.plugin.stickies;
		const refresh = (): void => {
			this.contentEl.empty();
			this.renderBody(refresh);
		};
		this.renderBody(refresh);
	}

	private renderBody(refresh: () => void): void {
		const mgr = this.plugin.stickies;
		const data = mgr.workspaces;

		new Setting(this.contentEl)
			.setName('当前工作区')
			.setDesc('切换后下次启动将默认恢复该工作区布局。')
			.addDropdown(dd => {
				for (const w of data.workspaces) {
					dd.addOption(w.id, w.name);
				}
				dd.setValue(data.activeWorkspaceId).onChange(async v => {
					data.activeWorkspaceId = v;
					await saveWorkspacesFile(this.plugin, data);
					new Notice('已切换工作区（重新打开便笺窗口以应用记录布局）');
				});
			});

		for (const ws of data.workspaces) {
			const row = this.contentEl.createDiv({ cls: 'csn-ws-row' });
			row.createSpan({ text: ws.name, cls: 'csn-ws-name' });
			const btnOpen = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '切换并关闭' } });
			setIcon(btnOpen, 'check');
			this.plugin.registerDomEvent(btnOpen, 'click', async () => {
				mgr.workspaces.activeWorkspaceId = ws.id;
				await saveWorkspacesFile(this.plugin, mgr.workspaces);
				new Notice('已选中工作区');
				this.close();
			});

			if (ws.id !== 'default') {
				const btnDel = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '删除' } });
				setIcon(btnDel, 'trash');
				this.plugin.registerDomEvent(btnDel, 'click', async () => {
					if (!confirm(`删除工作区「${ws.name}」？`)) return;
					mgr.workspaces.workspaces = mgr.workspaces.workspaces.filter(x => x.id !== ws.id);
					if (mgr.workspaces.activeWorkspaceId === ws.id) {
						mgr.workspaces.activeWorkspaceId = mgr.workspaces.workspaces[0]?.id ?? 'default';
					}
					await saveWorkspacesFile(this.plugin, mgr.workspaces);
					refresh();
				});
			}
		}

		let newName = '';
		new Setting(this.contentEl)
			.setName('新建工作区')
			.addText(t =>
				t.setPlaceholder('名称').onChange(v => {
					newName = v;
				})
			)
			.addButton(btn =>
				btn.setButtonText('添加').onClick(async () => {
					const name = newName.trim() || `工作区 ${mgr.workspaces.workspaces.length + 1}`;
					const id = `ws_${Date.now().toString(36)}`;
					const nw: StickyWorkspace = { id, name, windows: [] };
					mgr.workspaces.workspaces.push(nw);
					await saveWorkspacesFile(this.plugin, mgr.workspaces);
					newName = '';
					refresh();
				})
			);

		new Setting(this.contentEl).addButton(btn =>
			btn.setButtonText('关闭').onClick(() => this.close())
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
