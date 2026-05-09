import { App, FuzzySuggestModal, TFile } from 'obsidian';
import { t } from '../lang/helpers';

export class MarkdownFilePickerModal extends FuzzySuggestModal<TFile> {
	private readonly files: TFile[];
	private readonly onChoose: (path: string) => void;

	constructor(app: App, onChoose: (path: string) => void) {
		super(app);
		this.onChoose = onChoose;
		this.files = app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
		this.setPlaceholder(t('SETTINGS_CHOOSE_TEMPLATE_NOTE'));
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item.path);
	}
}
