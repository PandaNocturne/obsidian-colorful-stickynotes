import { App, Modal, Setting } from 'obsidian';
import { t } from '../lang/helpers';

export class ListBatchDeleteConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			count: number;
			onConfirm: () => void;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(t('LIST_BATCH_DELETE_CONFIRM_TITLE'));
		contentEl.createEl('p', {
			text: t('LIST_BATCH_DELETE_CONFIRM_BODY', { n: this.opts.count })
		});
		new Setting(contentEl)
			.setName('')
			.addButton(btn => btn.setButtonText(t('MODAL_CANCEL')).onClick(() => this.close()))
			.addButton(btn =>
				btn.setButtonText(t('MODAL_DELETE')).setWarning().onClick(() => {
					this.opts.onConfirm();
					this.close();
				})
			);
	}
}
