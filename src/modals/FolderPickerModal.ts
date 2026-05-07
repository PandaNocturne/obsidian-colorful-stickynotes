import { App, FuzzySuggestModal, TFolder } from 'obsidian';

function collectFolders(folder: TFolder, out: TFolder[] = []): TFolder[] {
	out.push(folder);
	for (const c of folder.children) {
		if (c instanceof TFolder) collectFolders(c, out);
	}
	return out;
}

export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	private readonly folders: TFolder[];
	private readonly onChoose: (path: string) => void;

	constructor(app: App, onChoose: (path: string) => void) {
		super(app);
		this.onChoose = onChoose;
		const root = app.vault.getRoot();
		this.folders = collectFolders(root);
		this.setPlaceholder('选择文件夹…');
	}

	getItems(): TFolder[] {
		return this.folders;
	}

	getItemText(item: TFolder): string {
		return item.path;
	}

	onChooseItem(item: TFolder): void {
		this.onChoose(item.path);
	}
}
