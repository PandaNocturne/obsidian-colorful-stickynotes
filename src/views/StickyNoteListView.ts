import { ItemView, TFile, TFolder, WorkspaceLeaf, debounce, normalizePath, setIcon } from 'obsidian';

function collectMarkdownUnderFolder(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	for (const c of folder.children) {
		if (c instanceof TFile && c.extension === 'md') out.push(c);
		else if (c instanceof TFolder) out.push(...collectMarkdownUnderFolder(c));
	}
	return out;
}
import type ColorfulStickyNotesPlugin from '../main';
import { VIEW_STICKY_NOTE_LIST } from '../types';

export class StickyNoteListView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ColorfulStickyNotesPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_STICKY_NOTE_LIST;
	}

	getDisplayText(): string {
		return '便笺列表';
	}

	getIcon(): string {
		return 'layout-list';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('csn-list-view');

		const searchWrap = root.createDiv({ cls: 'csn-list-search' });
		const input = searchWrap.createEl('input', {
			type: 'search',
			cls: 'csn-list-search-input',
			attr: { placeholder: '搜索（空格分隔多个关键词）' }
		});

		const listEl = root.createDiv({ cls: 'csn-list-items' });

		const render = debounce(
			() => {
				void this.renderList(listEl, input.value);
			},
			120,
			true
		);

		this.registerDomEvent(input, 'input', render);
		void this.renderList(listEl, '');
	}

	private async renderList(container: HTMLElement, query: string): Promise<void> {
		container.empty();
		const folder = normalizePath(this.plugin.settings.stickyFolder || 'StickyNotes');
		const folderAbs = this.app.vault.getAbstractFileByPath(folder);
		if (!folderAbs) {
			container.createDiv({ text: `文件夹不存在：${folder}`, cls: 'csn-list-empty' });
			return;
		}
		if (!(folderAbs instanceof TFolder)) {
			container.createDiv({ text: `便笺目录不是文件夹：${folder}`, cls: 'csn-list-empty' });
			return;
		}

		const keywords = query
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(k => k.toLowerCase());

		const files = collectMarkdownUnderFolder(folderAbs);
		const filtered =
			keywords.length === 0
				? files
				: files.filter(f => {
						const hay = (f.basename + '\n' + f.path).toLowerCase();
						return keywords.every(k => hay.includes(k));
				  });

		filtered.sort((a, b) => b.stat.mtime - a.stat.mtime);

		if (filtered.length === 0) {
			container.createDiv({ text: '没有匹配的便笺', cls: 'csn-list-empty' });
			return;
		}

		for (const f of filtered) {
			const row = container.createDiv({ cls: 'csn-list-row' });
			const iconEl = row.createSpan({ cls: 'csn-list-row-icon' });
			setIcon(iconEl, 'file-text');
			const text = row.createDiv({ cls: 'csn-list-row-text' });
			text.createDiv({ cls: 'csn-list-row-name', text: f.basename });
			text.createDiv({ cls: 'csn-list-row-path', text: f.path });
			this.registerDomEvent(row, 'click', () => {
				void this.plugin.openStickyForFile(f);
			});
		}
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
