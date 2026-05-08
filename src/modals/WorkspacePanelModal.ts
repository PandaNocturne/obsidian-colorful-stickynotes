import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type ColorfulStickyNotesPlugin from '../main';
import { saveWorkspacesFile } from '../workspace-store';
import type { StickyWorkspace } from '../types';

function formatWorkspaceRelativeTimeZh(updatedAt: number | undefined): string {
	if (updatedAt === undefined || !Number.isFinite(updatedAt)) {
		return '修改时间未知';
	}
	const sec = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
	if (sec < 10) return '修改于几秒前';
	if (sec < 60) return '修改于约 1 分钟前';
	const min = Math.floor(sec / 60);
	if (min < 60) return `修改于 ${min} 分钟前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `修改于 ${hr} 小时前`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `修改于 ${day} 天前`;
	return '修改于较早';
}

class RenameStickyWorkspaceModal extends Modal {
	constructor(
		app: App,
		private readonly initialName: string,
		private readonly onCommit: (name: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('重命名便笺工作区');
		this.contentEl.addClass('csn-ws-rename-modal');
		const input = this.contentEl.createEl('input', {
			type: 'text',
			cls: 'csn-ws-rename-input',
			value: this.initialName
		});
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.commit(input.value);
			}
		});
		const row = this.contentEl.createDiv({ cls: 'csn-ws-rename-actions' });
		const cancel = row.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
		const ok = row.createEl('button', { text: '确定', cls: 'mod-cta' });
		ok.addEventListener('click', () => this.commit(input.value));
		requestAnimationFrame(() => {
			input.focus();
			input.select();
		});
	}

	private commit(raw: string): void {
		const name = raw.trim();
		if (!name) {
			new Notice('名称不能为空');
			return;
		}
		this.onCommit(name);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class DeleteStickyWorkspaceConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly workspaceName: string,
		private readonly onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText('删除便笺工作区');
		contentEl.createEl('p', {
			text: `确定删除便笺工作区「${this.workspaceName}」？此操作不可撤销。`
		});
		new Setting(contentEl)
			.setName('')
			.addButton(btn => btn.setButtonText('取消').onClick(() => this.close()))
			.addButton(btn =>
				btn
					.setButtonText('删除')
					.setWarning()
					.onClick(async () => {
						btn.setDisabled(true);
						try {
							await Promise.resolve(this.onConfirm());
							this.close();
						} finally {
							btn.setDisabled(false);
						}
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class WorkspacePanelModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: ColorfulStickyNotesPlugin
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('便笺工作区');
		this.modalEl.addClass('csn-workspace-panel-modal');
		this.contentEl.empty();
		this.contentEl.addClass('csn-workspace-panel');
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('csn-workspace-panel');

		const mgr = this.plugin.stickies;
		const data = mgr.workspaces;

		const saveRow = this.contentEl.createDiv({ cls: 'csn-ws-panel-save-row' });
		const nameInput = saveRow.createEl('input', {
			type: 'text',
			cls: 'csn-ws-panel-input',
			attr: { placeholder: '输入名称以保存当前便笺工作区布局…' }
		});
		const saveBtn = saveRow.createEl('button', {
			cls: 'csn-ws-panel-icon-btn csn-ws-panel-icon-btn--bordered',
			attr: { 'aria-label': '保存为新的便笺工作区', title: '保存为新的便笺工作区' }
		});
		setIcon(saveBtn, 'save');
		saveBtn.addEventListener('click', async () => {
			const v = nameInput.value;
			if (!v.trim()) {
				new Notice('请输入便笺工作区名称');
				return;
			}
			saveBtn.disabled = true;
			try {
				await mgr.createWorkspaceFromCurrentLayout(v);
				nameInput.value = '';
				new Notice('已保存为新的便笺工作区');
				this.render();
			} finally {
				saveBtn.disabled = false;
			}
		});

		this.contentEl.createDiv({ cls: 'csn-ws-panel-divider' });

		const listEl = this.contentEl.createDiv({ cls: 'csn-ws-panel-list' });
		for (const ws of data.workspaces) {
			this.renderWorkspaceRow(listEl, ws, data.activeWorkspaceId, () => this.render());
		}
	}

	private renderWorkspaceRow(
		listEl: HTMLDivElement,
		ws: StickyWorkspace,
		activeId: string,
		refresh: () => void
	): void {
		const mgr = this.plugin.stickies;
		const isActive = ws.id === activeId;

		const row = listEl.createDiv({ cls: 'csn-ws-panel-item' });
		const main = row.createDiv({ cls: 'csn-ws-panel-item-main' });
		const titleRow = main.createDiv({ cls: 'csn-ws-panel-item-title-row' });
		titleRow.createSpan({ text: ws.name, cls: 'csn-ws-panel-item-name' });
		if (isActive) {
			titleRow.createSpan({ text: '使用中', cls: 'csn-ws-panel-badge' });
		}
		main.createDiv({
			text: formatWorkspaceRelativeTimeZh(ws.updatedAt),
			cls: 'csn-ws-panel-item-meta'
		});

		const actions = row.createDiv({ cls: 'csn-ws-panel-item-actions' });
		const btnEdit = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': '编辑便笺工作区名称', title: '编辑便笺工作区名称' }
		});
		setIcon(btnEdit, 'pen-line');
		btnEdit.addEventListener('click', () => {
			new RenameStickyWorkspaceModal(this.app, ws.name, async name => {
				await mgr.renameWorkspace(ws.id, name);
				refresh();
			}).open();
		});

		const btnDel = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': '删除便笺工作区', title: '删除便笺工作区' }
		});
		setIcon(btnDel, 'trash-2');
		const isDefault = ws.id === 'default';
		if (isDefault) {
			btnDel.setAttribute('aria-label', '删除便笺工作区（默认便笺工作区不可删除）');
			btnDel.title = '默认便笺工作区不可删除';
		}
		btnDel.addEventListener('click', () => {
			if (isDefault) {
				new Notice('默认便笺工作区不可删除');
				return;
			}
			new DeleteStickyWorkspaceConfirmModal(this.app, ws.name, async () => {
				mgr.workspaces.workspaces = mgr.workspaces.workspaces.filter(x => x.id !== ws.id);
				if (mgr.workspaces.activeWorkspaceId === ws.id) {
					mgr.workspaces.activeWorkspaceId = mgr.workspaces.workspaces[0]?.id ?? 'default';
				}
				await saveWorkspacesFile(this.plugin, mgr.workspaces);
				refresh();
			}).open();
		});

		const btnSwitch = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': '切换到该便笺工作区', title: '切换到该便笺工作区' }
		});
		setIcon(btnSwitch, 'download');
		btnSwitch.addEventListener('click', async () => {
			btnSwitch.disabled = true;
			try {
				await mgr.switchWorkspaceAndRestore(ws.id);
				new Notice('已切换到该便笺工作区');
				refresh();
			} finally {
				btnSwitch.disabled = false;
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
