import { App, Modal, Setting } from 'obsidian';

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
		this.titleEl.setText('确认删除空白便笺');
		contentEl.createEl('p', {
			text: '当前便笺无正文，是否自动移入回收站'
		});
		new Setting(contentEl)
			.setName('')
			.addButton(btn => btn.setButtonText('取消').onClick(() => this.close()))
			.addButton(btn =>
				btn.setButtonText('确定').setCta().onClick(() => {
					this.opts.onConfirm();
					this.close();
				})
			);
	}
}
