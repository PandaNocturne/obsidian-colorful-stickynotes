import { App, Modal, Setting } from 'obsidian';
import { t } from '../lang/helpers';

export class BlankStickyDeleteConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			onConfirm: () => void;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(t('BLANK_TRASH_CONFIRM_TITLE'));
		contentEl.createEl('p', {
			text: t('BLANK_TRASH_CONFIRM_BODY')
		});
		new Setting(contentEl)
			.setName('')
			.addButton(btn => btn.setButtonText(t('MODAL_CANCEL')).onClick(() => this.close()))
			.addButton(btn =>
				btn.setButtonText(t('MODAL_OK')).setCta().onClick(() => {
					this.opts.onConfirm();
					this.close();
				})
			);
	}
}
