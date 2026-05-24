import { App, FuzzySuggestModal, normalizePath, TFile, TFolder } from 'obsidian';
import { t } from '../lang/helpers';
import { collectMarkdownUnderFolder } from '../utils/collect-markdown-under-folder';

export class MarkdownFilePickerModal extends FuzzySuggestModal<TFile> {
	private readonly files: TFile[];
	private readonly onChoose: (path: string) => void;

	constructor(app: App, folderPath: string, onChoose: (path: string) => void) {
		super(app);
		this.onChoose = onChoose;
		const folder = app.vault.getFolderByPath(normalizePath(folderPath));
		this.files =
			folder instanceof TFolder
				? collectMarkdownUnderFolder(folder).sort((a, b) => a.path.localeCompare(b.path))
				: [];
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
