import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import { t } from '../lang/helpers';
import type ColorfulStickyNotesPlugin from '../main';
import { saveWorkspacesFile } from '../workspace-store';
import type { StickyWorkspace } from '../types';

function formatWorkspaceRelativeTime(updatedAt: number | undefined): string {
	if (updatedAt === undefined || !Number.isFinite(updatedAt)) {
		return t('WS_TIME_UNKNOWN');
	}
	const sec = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
	if (sec < 10) return t('WS_TIME_SECONDS');
	if (sec < 60) return t('WS_TIME_ABOUT_MINUTE');
	const min = Math.floor(sec / 60);
	if (min < 60) return t('WS_TIME_MINUTES', { n: min });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t('WS_TIME_HOURS', { n: hr });
	const day = Math.floor(hr / 24);
	if (day < 30) return t('WS_TIME_DAYS', { n: day });
	return t('WS_TIME_OLDER');
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
		this.titleEl.setText(t('WS_RENAME_TITLE'));
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
		const cancel = row.createEl('button', { text: t('MODAL_CANCEL') });
		cancel.addEventListener('click', () => this.close());
		const ok = row.createEl('button', { text: t('MODAL_OK'), cls: 'mod-cta' });
		ok.addEventListener('click', () => this.commit(input.value));
		requestAnimationFrame(() => {
			input.focus();
			input.select();
		});
	}

	private commit(raw: string): void {
		const name = raw.trim();
		if (!name) {
			new Notice(t('NOTICE_NAME_EMPTY'));
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
		this.titleEl.setText(t('WS_DELETE_TITLE'));
		contentEl.createEl('p', {
			text: t('WS_DELETE_BODY', { name: this.workspaceName })
		});
		new Setting(contentEl)
			.setName('')
			.addButton(btn => btn.setButtonText(t('MODAL_CANCEL')).onClick(() => this.close()))
			.addButton(btn =>
				btn
					.setButtonText(t('MODAL_DELETE'))
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
		this.titleEl.setText(t('WS_PANEL_TITLE'));
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
			attr: { placeholder: t('WS_PLACEHOLDER_SAVE_NAME') }
		});
		const saveBtn = saveRow.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_SAVE_ARIA_LABEL') }
		});
		setIcon(saveBtn, 'save');
		saveBtn.addEventListener('click', async () => {
			const v = nameInput.value;
			if (!v.trim()) {
				new Notice(t('NOTICE_ENTER_WORKSPACE_NAME'));
				return;
			}
			saveBtn.disabled = true;
			try {
				await mgr.createWorkspaceFromCurrentLayout(v);
				nameInput.value = '';
				new Notice(t('NOTICE_SAVED_AND_SWITCHED'));
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
			titleRow.createSpan({ text: t('WS_BADGE_ACTIVE'), cls: 'csn-ws-panel-badge' });
		}
		main.createDiv({
			text: formatWorkspaceRelativeTime(ws.updatedAt),
			cls: 'csn-ws-panel-item-meta'
		});

		const actions = row.createDiv({ cls: 'csn-ws-panel-item-actions' });
		const btnEdit = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_EDIT_NAME_ARIA') }
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
			attr: { 'aria-label': t('WS_DELETE_ARIA') }
		});
		setIcon(btnDel, 'trash-2');
		const isDefault = ws.id === 'default';
		if (isDefault) {
			btnDel.setAttribute('aria-label', t('WS_DELETE_DEFAULT_ARIA'));
		}
		btnDel.addEventListener('click', () => {
			if (isDefault) {
				new Notice(t('NOTICE_DEFAULT_WS_CANNOT_DELETE'));
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
			attr: { 'aria-label': t('WS_SWITCH_ARIA') }
		});
		setIcon(btnSwitch, 'download');
		btnSwitch.addEventListener('click', async () => {
			btnSwitch.disabled = true;
			try {
				await mgr.switchWorkspaceAndRestore(ws.id);
				new Notice(t('NOTICE_SWITCHED_WORKSPACE'));
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
