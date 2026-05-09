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

		const gridEl = this.contentEl.createDiv({ cls: 'csn-ws-panel-grid' });
		for (const ws of data.workspaces) {
			this.renderWorkspaceTile(gridEl, ws, data.activeWorkspaceId, () => this.render());
		}

		const addTile = gridEl.createEl('button', {
			cls: 'csn-ws-panel-add-tile',
			attr: { type: 'button', 'aria-label': t('WS_NEW_BLANK_ARIA') }
		});
		setIcon(addTile, 'plus');
		addTile.addEventListener('click', async () => {
			addTile.disabled = true;
			try {
				await mgr.createBlankWorkspace();
				new Notice(t('NOTICE_NEW_BLANK_WORKSPACE'));
				this.render();
			} finally {
				addTile.disabled = false;
			}
		});
	}

	private renderWorkspaceTile(
		gridEl: HTMLDivElement,
		ws: StickyWorkspace,
		activeId: string,
		refresh: () => void
	): void {
		const mgr = this.plugin.stickies;
		const isActive = ws.id === activeId;

		const row = gridEl.createDiv({
			cls: `csn-ws-panel-item csn-ws-panel-item--clickable${isActive ? ' csn-ws-panel-item--active' : ''}`
		});
		row.tabIndex = 0;
		if (isActive) {
			row.setAttribute('aria-current', 'true');
			row.setAttribute('aria-label', `${ws.name}（${t('WS_BADGE_ACTIVE')}）`);
		} else {
			row.setAttribute(
				'aria-label',
				`${ws.name} — ${t('WS_CARD_SWITCH_HINT')} ${t('WS_CARD_SWITCH_HINT_A11Y')}`
			);
		}

		const actions = row.createDiv({ cls: 'csn-ws-panel-item-float-actions' });
		const btnEdit = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_EDIT_NAME_ARIA') }
		});
		setIcon(btnEdit, 'pen-line');
		btnEdit.addEventListener('click', e => {
			e.stopPropagation();
			new RenameStickyWorkspaceModal(this.app, ws.name, async name => {
				await mgr.renameWorkspace(ws.id, name);
				refresh();
			}).open();
		});
		btnEdit.addEventListener('dblclick', e => e.stopPropagation());

		const btnDel = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_DELETE_ARIA') }
		});
		setIcon(btnDel, 'trash-2');
		const isDefault = ws.id === 'default';
		if (isDefault) {
			btnDel.setAttribute('aria-label', t('WS_DELETE_DEFAULT_ARIA'));
		}
		btnDel.addEventListener('click', e => {
			e.stopPropagation();
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
		btnDel.addEventListener('dblclick', e => e.stopPropagation());

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

		const activateWorkspace = async (): Promise<void> => {
			if (isActive) return;
			await mgr.switchWorkspaceAndRestore(ws.id);
			new Notice(t('NOTICE_SWITCHED_WORKSPACE'));
			refresh();
		};

		row.addEventListener('dblclick', e => {
			const el = e.target;
			if (el instanceof HTMLElement && el.closest('.csn-ws-panel-item-float-actions')) return;
			void activateWorkspace();
		});

		row.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			if (e.target !== row) return;
			e.preventDefault();
			void activateWorkspace();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
