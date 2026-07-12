import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import { t } from '../lang/helpers';
import type ColorfulStickyNotesPlugin from '../main';
import { WS_TAB_FILTER_ALL, type StickyWorkspace, type StickyWorkspaceTabGroup } from '../types';

/** HTML5 DnD 用 payload（text/plain 兼容性最好） */
const WORKSPACE_DND_MIME = 'text/plain';
const WORKSPACE_TAB_GROUP_DND_MIME = 'text/x-csn-ws-tab-group';

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
					.setButtonText(t('WS_CONFIRM_MOVE_TO_TRASH'))
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

class PermanentlyDeleteStickyWorkspaceConfirmModal extends Modal {
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
		this.titleEl.setText(t('WS_PERMANENT_DELETE_TITLE'));
		contentEl.createEl('p', {
			text: t('WS_PERMANENT_DELETE_BODY', { name: this.workspaceName })
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

class NewWorkspaceTabGroupModal extends Modal {
	constructor(
		app: App,
		private readonly autoNamePreview: string,
		private readonly onCommit: (name: string) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(t('WS_NEW_TAB_GROUP_MODAL_TITLE'));
		this.contentEl.addClass('csn-ws-edit-modal');
		this.contentEl.createDiv({
			cls: 'csn-ws-edit-field-label',
			text: t('WS_NAME_LABEL')
		});
		const input = this.contentEl.createEl('input', {
			type: 'text',
			cls: 'csn-ws-edit-name-input',
			attr: {
				placeholder: t('WS_NEW_TAB_GROUP_USE_AUTO_HINT', { name: this.autoNamePreview }),
				'aria-label': t('WS_NAME_LABEL')
			}
		});
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.commit(input.value);
			}
		});
		const row = this.contentEl.createDiv({ cls: 'csn-ws-edit-actions' });
		const cancel = row.createEl('button', { text: t('MODAL_CANCEL') });
		cancel.addEventListener('click', () => this.close());
		const ok = row.createEl('button', { text: t('MODAL_OK'), cls: 'mod-cta' });
		ok.addEventListener('click', () => void this.commit(input.value));
		requestAnimationFrame(() => input.focus());
	}

	private async commit(rawName: string): Promise<void> {
		await Promise.resolve(this.onCommit(rawName));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class WorkspacePanelModal extends Modal {
	/** 正在执行 `finalizeWorkspaceSwitch` 的工作区 id，用于角标加载态。 */
	private openingWorkspaceId: string | null = null;
	/**
	 * 弹窗打开时 Obsidian 会把焦点落到第一个 tabbable；首张工作区卡片即获焦并出现 :focus-visible 描边。
	 * 仅在本次打开后的首次 render 结束时 blur 一次，避免「额外紫框」；后续 refresh 不干扰键盘导航。
	 */
	private clearInitialWorkspaceTileFocusPending = false;
	private panelMode: 'workspaces' | 'trash' = 'workspaces';
	/** 顶部分组筛选：`@all` 或具体分组 id。 */
	private activeTabFilterId: string = WS_TAB_FILTER_ALL;

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
		this.clearInitialWorkspaceTileFocusPending = true;
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('csn-workspace-panel');

		const mgr = this.plugin.stickies;
		const data = mgr.workspaces;

		this.titleEl.setText(
			this.panelMode === 'trash' ? t('WS_TRASH_PANEL_TITLE') : t('WS_PANEL_TITLE')
		);

		if (this.panelMode === 'workspaces') {
			this.renderTabGroupBar(this.contentEl, () => this.render());
		}

		const bodyEl = this.contentEl.createDiv({ cls: 'csn-ws-panel-body' });
		const gridEl = bodyEl.createDiv({ cls: 'csn-ws-panel-grid' });

		if (this.panelMode === 'workspaces') {
			const visibleWorkspaces = mgr.filterWorkspacesForTab(this.activeTabFilterId);
			if (visibleWorkspaces.length === 0) {
				gridEl.createDiv({
					cls: 'csn-ws-panel-empty',
					text: t('WS_TAB_GROUP_EMPTY')
				});
			} else {
				for (const ws of visibleWorkspaces) {
					this.renderWorkspaceTile(
						gridEl,
						ws,
						data.activeWorkspaceId,
						this.openingWorkspaceId,
						() => this.render()
					);
				}
			}
		} else if (data.trash.length === 0) {
			gridEl.createDiv({
				cls: 'csn-ws-panel-empty',
				text: t('WS_TRASH_EMPTY')
			});
		} else {
			for (const ws of data.trash) {
				this.renderTrashTile(gridEl, ws, () => this.render());
			}
		}

		const toolbar = this.contentEl.createDiv({ cls: 'csn-ws-panel-toolbar' });
		const inner = toolbar.createDiv({ cls: 'csn-ws-panel-toolbar-inner' });
		if (this.panelMode === 'workspaces') {
			const openNewBlankWorkspace = (): void => {
				const nextN = data.workspaces.length + 1;
				const autoPreview = t('WS_NEW_WORKSPACE_AUTO_NAME', { n: nextN });
				const tabGroupId =
					this.activeTabFilterId === WS_TAB_FILTER_ALL ? undefined : this.activeTabFilterId;
				new NewBlankWorkspaceModal(this.app, autoPreview, async ({ name, remark }) => {
					await mgr.createBlankWorkspace({
						name: name.trim() ? name : undefined,
						remark,
						tabGroupId
					});
					new Notice(t('NOTICE_NEW_BLANK_WORKSPACE'));
					this.render();
				}).open();
			};

			const btnTrash = inner.createEl('button', {
				cls: 'csn-ws-panel-toolbar-btn csn-ws-panel-icon-btn--bordered',
				attr: { 'aria-label': t('WS_TOOLBAR_TRASH_ARIA'), type: 'button' }
			});
			setIcon(btnTrash, 'archive');
			if (data.trash.length > 0) {
				btnTrash.createSpan({
					cls: 'csn-ws-panel-toolbar-badge',
					text: String(data.trash.length)
				});
			}
			btnTrash.addEventListener('click', () => {
				this.panelMode = 'trash';
				this.render();
			});

			const btnAdd = inner.createEl('button', {
				cls: 'csn-ws-panel-toolbar-btn csn-ws-panel-icon-btn--bordered csn-ws-panel-toolbar-btn--new',
				attr: { 'aria-label': t('WS_NEW_BLANK_ARIA'), type: 'button' }
			});
			setIcon(btnAdd, 'plus');
			btnAdd.addEventListener('click', openNewBlankWorkspace);
			const clearAddDropStyle = (): void => {
				btnAdd.classList.remove('csn-ws-panel-toolbar-btn--drop-target');
			};
			btnAdd.addEventListener('dragover', (e: DragEvent) => {
				if (!e.dataTransfer?.types.includes(WORKSPACE_DND_MIME)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
				btnAdd.classList.add('csn-ws-panel-toolbar-btn--drop-target');
			});
			btnAdd.addEventListener('dragleave', (e: DragEvent) => {
				const r = e.relatedTarget as Node | null;
				if (r && btnAdd.contains(r)) return;
				clearAddDropStyle();
			});
			btnAdd.addEventListener('drop', (e: DragEvent) => {
				e.preventDefault();
				clearAddDropStyle();
				const fromId = e.dataTransfer?.getData(WORKSPACE_DND_MIME);
				if (!fromId) return;
				void mgr.reorderWorkspaceToEnd(fromId).then(() => this.render());
			});
		} else {
			const btnBack = inner.createEl('button', {
				cls: 'csn-ws-panel-toolbar-btn csn-ws-panel-icon-btn--bordered',
				attr: { 'aria-label': t('WS_TOOLBAR_BACK_ARIA'), type: 'button' }
			});
			setIcon(btnBack, 'arrow-left');
			btnBack.addEventListener('click', () => {
				this.panelMode = 'workspaces';
				this.render();
			});
		}

		if (this.panelMode === 'workspaces' && this.clearInitialWorkspaceTileFocusPending) {
			this.clearInitialWorkspaceTileFocusPending = false;
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					const ae = document.activeElement;
					if (
						ae instanceof HTMLElement &&
						ae.classList.contains('csn-ws-panel-item') &&
						ae.classList.contains('csn-ws-panel-item--clickable') &&
						this.modalEl.contains(ae)
					) {
						ae.blur();
					}
				});
			});
		}
	}

	private renderTabGroupBar(parentEl: HTMLElement, refresh: () => void): void {
		const mgr = this.plugin.stickies;
		const data = mgr.workspaces;
		const bar = parentEl.createDiv({ cls: 'csn-ws-panel-tabbar' });
		const scroll = bar.createDiv({ cls: 'csn-ws-panel-tabbar-scroll' });

		const allTab = scroll.createEl('button', {
			cls: `csn-ws-panel-tab${this.activeTabFilterId === WS_TAB_FILTER_ALL ? ' csn-ws-panel-tab--active' : ''}`,
			text: t('WS_TAB_FILTER_ALL'),
			attr: { type: 'button', 'aria-pressed': String(this.activeTabFilterId === WS_TAB_FILTER_ALL) }
		});
		allTab.addEventListener('click', () => {
			this.activeTabFilterId = WS_TAB_FILTER_ALL;
			refresh();
		});

		for (const group of data.tabGroups) {
			this.renderTabGroupTab(scroll, group, refresh);
		}

		const addTab = scroll.createEl('button', {
			cls: 'csn-ws-panel-tab csn-ws-panel-tab--add',
			attr: {
				type: 'button',
				'aria-label': t('WS_NEW_TAB_GROUP_ARIA')
			}
		});
		setIcon(addTab.createSpan({ cls: 'csn-ws-panel-tab-add-icon' }), 'plus');
		const openNewTabGroup = (): void => {
			const nextN = data.tabGroups.length + 1;
			const autoPreview = t('WS_TAB_GROUP_AUTO_NAME', { n: nextN });
			new NewWorkspaceTabGroupModal(this.app, autoPreview, async name => {
				const id = await mgr.createWorkspaceTabGroup(name.trim() ? name : undefined);
				if (id) {
					this.activeTabFilterId = id;
					refresh();
				}
			}).open();
		};
		addTab.addEventListener('click', openNewTabGroup);

		const clearTabAddDropStyle = (): void => {
			addTab.classList.remove('csn-ws-panel-tab--drop-target');
		};
		addTab.addEventListener('dragover', (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes(WORKSPACE_TAB_GROUP_DND_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			addTab.classList.add('csn-ws-panel-tab--drop-target');
		});
		addTab.addEventListener('dragleave', (e: DragEvent) => {
			const r = e.relatedTarget as Node | null;
			if (r && addTab.contains(r)) return;
			clearTabAddDropStyle();
		});
		addTab.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			clearTabAddDropStyle();
			const fromId = e.dataTransfer?.getData(WORKSPACE_TAB_GROUP_DND_MIME);
			if (!fromId) return;
			void mgr.reorderWorkspaceTabGroupToEnd(fromId).then(() => refresh());
		});
	}

	private renderTabGroupTab(
		scrollEl: HTMLElement,
		group: StickyWorkspaceTabGroup,
		refresh: () => void
	): void {
		const mgr = this.plugin.stickies;
		const isActive = this.activeTabFilterId === group.id;
		const tab = scrollEl.createEl('button', {
			cls: `csn-ws-panel-tab csn-ws-panel-tab--draggable${isActive ? ' csn-ws-panel-tab--active' : ''}`,
			attr: {
				type: 'button',
				'aria-pressed': String(isActive),
				'aria-label': t('WS_TAB_GROUP_ARIA', { name: group.name })
			}
		});
		tab.createSpan({ cls: 'csn-ws-panel-tab-label', text: group.name });
		const dragHandle = tab.createSpan({
			cls: 'csn-ws-panel-tab-drag',
			attr: { draggable: 'true', 'aria-label': t('WS_TAB_GROUP_REORDER_ARIA') }
		});
		setIcon(dragHandle, 'grip-vertical');
		dragHandle.addEventListener('click', e => e.stopPropagation());
		dragHandle.addEventListener('dragstart', (e: DragEvent) => {
			e.stopPropagation();
			tab.classList.add('csn-ws-panel-tab--dragging');
			e.dataTransfer?.setData(WORKSPACE_TAB_GROUP_DND_MIME, group.id);
			e.dataTransfer!.effectAllowed = 'move';
		});
		dragHandle.addEventListener('dragend', () => {
			tab.classList.remove('csn-ws-panel-tab--dragging');
			for (const el of Array.from(scrollEl.querySelectorAll('.csn-ws-panel-tab--drop-target'))) {
				el.classList.remove('csn-ws-panel-tab--drop-target');
			}
			scrollEl.querySelector('.csn-ws-panel-tab--add')?.classList.remove('csn-ws-panel-tab--drop-target');
		});

		tab.addEventListener('click', e => {
			if (e.target instanceof HTMLElement && e.target.closest('.csn-ws-panel-tab-drag')) return;
			this.activeTabFilterId = group.id;
			refresh();
		});

		tab.addEventListener('dragover', (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes(WORKSPACE_TAB_GROUP_DND_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			tab.classList.add('csn-ws-panel-tab--drop-target');
		});
		tab.addEventListener('dragleave', (e: DragEvent) => {
			const r = e.relatedTarget as Node | null;
			if (r && tab.contains(r)) return;
			tab.classList.remove('csn-ws-panel-tab--drop-target');
		});
		tab.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			tab.classList.remove('csn-ws-panel-tab--drop-target');
			const fromId = e.dataTransfer?.getData(WORKSPACE_TAB_GROUP_DND_MIME);
			if (!fromId || fromId === group.id) return;
			void mgr.reorderWorkspaceTabGroupBefore(fromId, group.id).then(() => refresh());
		});
	}

	private renderWorkspaceTile(
		gridEl: HTMLDivElement,
		ws: StickyWorkspace,
		activeId: string | null,
		openingWorkspaceId: string | null,
		refresh: () => void
	): void {
		const mgr = this.plugin.stickies;
		const isActive = ws.id === activeId;
		const isOpening = isActive && openingWorkspaceId === ws.id;

		const row = gridEl.createDiv({
			cls: `csn-ws-panel-item csn-ws-panel-item--clickable${isActive ? ' csn-ws-panel-item--active' : ''}${isOpening ? ' csn-ws-panel-item--opening' : ''}`
		});
		row.tabIndex = 0;
		if (isActive) {
			row.setAttribute('aria-current', 'true');
			if (isOpening) {
				row.setAttribute('aria-label', `${ws.name} — ${t('WS_BADGE_LOADING')}`);
			} else {
				row.setAttribute(
					'aria-label',
					`${ws.name}（${t('WS_BADGE_ACTIVE')}） — ${t('WS_TOGGLE_CLOSE_HINT')}`
				);
			}
		} else {
			row.setAttribute('aria-label', `${ws.name} — ${t('WS_TOGGLE_OPEN_HINT')}`);
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
			gridEl
				.closest('.csn-workspace-panel')
				?.querySelector('.csn-ws-panel-toolbar-btn--new')
				?.classList.remove('csn-ws-panel-toolbar-btn--drop-target');
		});

		if (isActive) {
			if (isOpening) {
				const loadingBadge = row.createSpan({
					cls: 'csn-ws-panel-badge csn-ws-panel-badge--floating csn-ws-panel-badge--loading',
					attr: { 'aria-hidden': 'true' }
				});
				loadingBadge.createSpan({ cls: 'csn-ws-panel-badge-spinner' });
			} else {
				const okBadge = row.createSpan({
					cls: 'csn-ws-panel-badge csn-ws-panel-badge--floating csn-ws-panel-badge--icon-only',
					attr: { 'aria-hidden': 'true' }
				});
				setIcon(okBadge, 'check');
			}
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
		const isBlankWorkspace = !ws.windows || ws.windows.length === 0;
		btnDel.addEventListener('click', e => {
			e.stopPropagation();
			if (isBlankWorkspace) {
				void (async () => {
					await mgr.deleteStickyWorkspace(ws.id);
					refresh();
				})();
				return;
			}
			new DeleteStickyWorkspaceConfirmModal(this.app, ws.name, async () => {
				await mgr.deleteStickyWorkspace(ws.id);
				refresh();
			}).open();
		});

		const toggleWorkspace = async (): Promise<void> => {
			if (this.openingWorkspaceId === ws.id) return;
			if (isActive) {
				await mgr.deselectActiveStickyWorkspace();
				refresh();
				return;
			}
			const token = mgr.beginWorkspaceSwitchForUi(ws.id);
			if (token === null) return;
			this.openingWorkspaceId = ws.id;
			refresh();
			try {
				await mgr.finalizeWorkspaceSwitch(token);
			} finally {
				this.openingWorkspaceId = null;
				refresh();
			}
		};

		row.addEventListener('click', e => {
			const el = e.target;
			if (el instanceof HTMLElement && el.closest('.csn-ws-panel-item-float-actions')) return;
			if (el instanceof HTMLElement && el.closest('.csn-ws-panel-item-drag')) return;
			void toggleWorkspace();
		});

		row.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			if (e.target !== row) return;
			e.preventDefault();
			void toggleWorkspace();
		});
	}

	private renderTrashTile(
		gridEl: HTMLDivElement,
		ws: StickyWorkspace,
		refresh: () => void
	): void {
		const mgr = this.plugin.stickies;
		const row = gridEl.createDiv({
			cls: 'csn-ws-panel-item csn-ws-panel-item--trash'
		});

		const main = row.createDiv({ cls: 'csn-ws-panel-item-main' });
		const titleRow = main.createDiv({ cls: 'csn-ws-panel-item-title-row' });
		titleRow.createSpan({ text: ws.name, cls: 'csn-ws-panel-item-name' });

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
		const btnRestore = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_RESTORE_ARIA') }
		});
		setIcon(btnRestore, 'rotate-ccw');
		btnRestore.addEventListener('click', e => {
			e.stopPropagation();
			void (async () => {
				await mgr.restoreStickyWorkspaceFromTrash(ws.id);
				refresh();
			})();
		});

		const btnForever = actions.createEl('button', {
			cls: 'csn-ws-panel-icon-btn',
			attr: { 'aria-label': t('WS_PERMANENT_DELETE_ARIA') }
		});
		setIcon(btnForever, 'trash');
		btnForever.addEventListener('click', e => {
			e.stopPropagation();
			new PermanentlyDeleteStickyWorkspaceConfirmModal(this.app, ws.name, async () => {
				await mgr.permanentlyDeleteStickyWorkspaceFromTrash(ws.id);
				refresh();
			}).open();
		});
	}

	onClose(): void {
		this.panelMode = 'workspaces';
		this.activeTabFilterId = WS_TAB_FILTER_ALL;
		this.contentEl.empty();
	}
}
