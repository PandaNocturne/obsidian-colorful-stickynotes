import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import { t } from '../lang/helpers';
import type ColorfulStickyNotesPlugin from '../main';
import { defaultWorkspacesFile } from '../workspace-store';
import type { StickyWorkspace } from '../types';

/** HTML5 DnD 用 payload（text/plain 兼容性最好） */
const WORKSPACE_DND_MIME = 'text/plain';

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

class EditStickyWorkspaceModal extends Modal {
	constructor(
		app: App,
		private readonly initialName: string,
		private readonly initialRemark: string,
		private readonly onCommit: (payload: { name: string; remark: string }) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(t('WS_EDIT_WORKSPACE_TITLE'));
		this.contentEl.addClass('csn-ws-edit-modal');

		this.contentEl.createDiv({
			cls: 'csn-ws-edit-field-label',
			text: t('WS_NAME_LABEL')
		});
		const input = this.contentEl.createEl('input', {
			type: 'text',
			cls: 'csn-ws-edit-name-input',
			value: this.initialName
		});

		this.contentEl.createDiv({
			cls: 'csn-ws-edit-field-label',
			text: t('WS_REMARK_LABEL')
		});
		const textarea = this.contentEl.createEl('textarea', {
			cls: 'csn-ws-edit-remark-input',
			attr: { rows: '4', placeholder: t('WS_REMARK_PLACEHOLDER') }
		});
		textarea.value = this.initialRemark;

		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.commit(input.value, textarea.value);
			}
		});

		const row = this.contentEl.createDiv({ cls: 'csn-ws-edit-actions' });
		const cancel = row.createEl('button', { text: t('MODAL_CANCEL') });
		cancel.addEventListener('click', () => this.close());
		const ok = row.createEl('button', { text: t('MODAL_OK'), cls: 'mod-cta' });
		ok.addEventListener('click', () => void this.commit(input.value, textarea.value));
		requestAnimationFrame(() => {
			input.focus();
			input.select();
		});
	}

	private async commit(rawName: string, rawRemark: string): Promise<void> {
		const name = rawName.trim();
		if (!name) {
			new Notice(t('NOTICE_NAME_EMPTY'));
			return;
		}
		await Promise.resolve(this.onCommit({ name, remark: rawRemark }));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 新建空白工作区：填写后确认添加（名称可留空则自动命名） */
class NewBlankWorkspaceModal extends Modal {
	constructor(
		app: App,
		private readonly autoNamePreview: string,
		private readonly onCommit: (payload: { name: string; remark: string }) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(t('WS_NEW_BLANK_MODAL_TITLE'));
		this.contentEl.addClass('csn-ws-edit-modal');
		this.contentEl.createEl('p', {
			cls: 'csn-ws-new-blank-modal-desc',
			text: t('WS_NEW_BLANK_MODAL_BODY')
		});

		this.contentEl.createDiv({
			cls: 'csn-ws-edit-field-label',
			text: t('WS_NAME_LABEL')
		});
		const input = this.contentEl.createEl('input', {
			type: 'text',
			cls: 'csn-ws-edit-name-input',
			attr: {
				placeholder: t('WS_NEW_BLANK_USE_AUTO_HINT', { name: this.autoNamePreview }),
				'aria-label': t('WS_NAME_LABEL')
			}
		});

		this.contentEl.createDiv({
			cls: 'csn-ws-edit-field-label',
			text: t('WS_REMARK_LABEL')
		});
		const textarea = this.contentEl.createEl('textarea', {
			cls: 'csn-ws-edit-remark-input',
			attr: { rows: '4', placeholder: t('WS_REMARK_PLACEHOLDER') }
		});

		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.commit(input.value, textarea.value);
			}
		});

		const row = this.contentEl.createDiv({ cls: 'csn-ws-edit-actions' });
		const cancel = row.createEl('button', { text: t('MODAL_CANCEL') });
		cancel.addEventListener('click', () => this.close());
		const ok = row.createEl('button', { text: t('MODAL_OK'), cls: 'mod-cta' });
		ok.addEventListener('click', () => void this.commit(input.value, textarea.value));
		requestAnimationFrame(() => input.focus());
	}

	private async commit(rawName: string, rawRemark: string): Promise<void> {
		await Promise.resolve(this.onCommit({ name: rawName, remark: rawRemark }));
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

		const addTile = gridEl.createDiv({
			cls: 'csn-ws-panel-add-tile',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': t('WS_NEW_BLANK_ARIA')
			}
		});
		const addIconWrap = addTile.createSpan({ cls: 'csn-ws-panel-add-tile-icon' });
		setIcon(addIconWrap, 'plus');
		const openNewBlankWorkspace = (): void => {
			const nextN = data.workspaces.length + 1;
			const autoPreview = t('WS_NEW_WORKSPACE_AUTO_NAME', { n: nextN });
			new NewBlankWorkspaceModal(this.app, autoPreview, async ({ name, remark }) => {
				await mgr.createBlankWorkspace({
					name: name.trim() ? name : undefined,
					remark
				});
				new Notice(t('NOTICE_NEW_BLANK_WORKSPACE'));
				this.render();
			}).open();
		};
		addTile.addEventListener('click', openNewBlankWorkspace);
		addTile.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			e.preventDefault();
			openNewBlankWorkspace();
		});

		const clearAddDropStyle = (): void => {
			addTile.classList.remove('csn-ws-panel-add-tile--drop-target');
		};
		addTile.addEventListener('dragover', (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes(WORKSPACE_DND_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			addTile.classList.add('csn-ws-panel-add-tile--drop-target');
		});
		addTile.addEventListener('dragleave', (e: DragEvent) => {
			const r = e.relatedTarget as Node | null;
			if (r && addTile.contains(r)) return;
			clearAddDropStyle();
		});
		addTile.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			clearAddDropStyle();
			const fromId = e.dataTransfer?.getData(WORKSPACE_DND_MIME);
			if (!fromId) return;
			void mgr.reorderWorkspaceToEnd(fromId).then(() => this.render());
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
			row.setAttribute('aria-label', ws.name);
		}

		const dragHandle = row.createDiv({
			cls: 'csn-ws-panel-item-drag',
			attr: { draggable: 'true', 'aria-label': t('WS_REORDER_DRAG_ARIA') }
		});
		setIcon(dragHandle, 'move');
		dragHandle.addEventListener('click', e => e.stopPropagation());
		dragHandle.addEventListener('dragstart', (e: DragEvent) => {
			e.stopPropagation();
			row.classList.add('csn-ws-panel-item--dragging');
			e.dataTransfer?.setData(WORKSPACE_DND_MIME, ws.id);
			e.dataTransfer!.effectAllowed = 'move';
		});
		dragHandle.addEventListener('dragend', () => {
			row.classList.remove('csn-ws-panel-item--dragging');
			for (const el of Array.from(gridEl.querySelectorAll('.csn-ws-panel-item--drop-target'))) {
				el.classList.remove('csn-ws-panel-item--drop-target');
			}
			gridEl.querySelector('.csn-ws-panel-add-tile')?.classList.remove('csn-ws-panel-add-tile--drop-target');
		});

		if (isActive) {
			row.createSpan({
				text: t('WS_BADGE_ACTIVE'),
				cls: 'csn-ws-panel-badge csn-ws-panel-badge--floating'
			});
		}

		const main = row.createDiv({ cls: 'csn-ws-panel-item-main' });
		const titleRow = main.createDiv({ cls: 'csn-ws-panel-item-title-row' });
		titleRow.createSpan({ text: ws.name, cls: 'csn-ws-panel-item-name' });

		row.addEventListener('dragover', (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes(WORKSPACE_DND_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			row.classList.add('csn-ws-panel-item--drop-target');
		});
		row.addEventListener('dragleave', (e: DragEvent) => {
			const r = e.relatedTarget as Node | null;
			if (r && row.contains(r)) return;
			row.classList.remove('csn-ws-panel-item--drop-target');
		});
		row.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			row.classList.remove('csn-ws-panel-item--drop-target');
			const fromId = e.dataTransfer?.getData(WORKSPACE_DND_MIME);
			if (!fromId || fromId === ws.id) return;
			void mgr.reorderWorkspaceBefore(fromId, ws.id).then(() => refresh());
		});
		const remarkText = ws.remark?.trim();
		if (remarkText) {
			main.createDiv({
				text: remarkText,
				cls: 'csn-ws-panel-item-remark'
			});
		} else {
			main.createDiv({
				text: t('WS_REMARK_EMPTY_PLACEHOLDER'),
				cls: 'csn-ws-panel-item-remark csn-ws-panel-item-remark--placeholder'
			});
		}

		const footer = row.createDiv({ cls: 'csn-ws-panel-item-footer' });
		const footLeft = footer.createDiv({ cls: 'csn-ws-panel-item-footer-left' });
		footLeft.createDiv({
			text: formatWorkspaceRelativeTime(ws.updatedAt),
			cls: 'csn-ws-panel-item-meta'
		});

		const actions = footer.createDiv({ cls: 'csn-ws-panel-item-float-actions' });
		const btnEdit = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_EDIT_WORKSPACE_ARIA') }
		});
		setIcon(btnEdit, 'pen-line');
		btnEdit.addEventListener('click', e => {
			e.stopPropagation();
			new EditStickyWorkspaceModal(this.app, ws.name, ws.remark ?? '', async ({ name, remark }) => {
				await mgr.updateWorkspace(ws.id, name, remark);
				refresh();
			}).open();
		});

		const btnCopy = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_COPY_WORKSPACE_ARIA') }
		});
		setIcon(btnCopy, 'copy');
		btnCopy.addEventListener('click', e => {
			e.stopPropagation();
			void (async () => {
				await mgr.duplicateWorkspace(ws.id);
				refresh();
			})();
		});

		const btnDel = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_DELETE_ARIA') }
		});
		setIcon(btnDel, 'trash-2');
		btnDel.addEventListener('click', e => {
			e.stopPropagation();
			new DeleteStickyWorkspaceConfirmModal(this.app, ws.name, async () => {
				mgr.workspaces.workspaces = mgr.workspaces.workspaces.filter(x => x.id !== ws.id);
				if (mgr.workspaces.workspaces.length === 0) {
					const fresh = defaultWorkspacesFile();
					mgr.workspaces.workspaces = fresh.workspaces;
					mgr.workspaces.activeWorkspaceId = fresh.activeWorkspaceId;
				} else if (mgr.workspaces.activeWorkspaceId === ws.id) {
					mgr.workspaces.activeWorkspaceId = mgr.workspaces.workspaces[0]!.id;
				}
				await mgr.flushWorkspacesToDisk();
				refresh();
			}).open();
		});

		const activateWorkspace = async (): Promise<void> => {
			if (isActive) return;
			const token = mgr.beginWorkspaceSwitchForUi(ws.id);
			if (token === null) return;
			refresh();
			new Notice(t('NOTICE_SWITCHED_WORKSPACE'));
			await mgr.finalizeWorkspaceSwitch(token);
		};

		row.addEventListener('click', e => {
			const el = e.target;
			if (el instanceof HTMLElement && el.closest('.csn-ws-panel-item-float-actions')) return;
			if (el instanceof HTMLElement && el.closest('.csn-ws-panel-item-drag')) return;
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
