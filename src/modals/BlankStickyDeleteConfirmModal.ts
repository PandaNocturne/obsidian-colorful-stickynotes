import { App, Modal, Setting } from 'obsidian';

export class BlankStickyDeleteConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			fileName: string;
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
			text: `「${this.opts.fileName}」尚无正文。关闭该便笺后将移入回收站。`
		});
		new Setting(contentEl)
			.setName('')
			.addButton(btn => btn.setButtonText('取消').onClick(() => this.close()))
			.addButton(btn =>
				btn.setButtonText('确定删除').setCta().onClick(() => {
					this.opts.onConfirm();
					this.close();
				})
			);
	}
}
