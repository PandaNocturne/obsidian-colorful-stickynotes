import { normalizePath, setIcon, TFolder, type App, type TFile } from 'obsidian';
import { t } from '../lang/helpers';
import { collectMarkdownUnderFolder } from './collect-markdown-under-folder';
import { StickyTagPickerPanel } from './sticky-tag-picker-panel';
import {
	displayStickyTag,
	getStickyFrontmatterTagsForFile,
	normalizeStickyTag,
	writeStickyTagsToFile
} from './sticky-tags-from-file';

export type StickyTagToolbarHandle = {
	el: HTMLElement;
	refresh: () => void;
	setEnabled: (enabled: boolean) => void;
	destroy: () => void;
	/** 供外部点击空白关闭选择器。 */
	isPickerOpen: () => boolean;
	closePicker: () => void;
	pickerContains: (node: Node) => boolean;
};

/**
 * 在宿主底部挂载 YAML 标签工具栏（芯片 + 仪表盘同款选择器）。
 * @param variant `floating` 悬浮便笺底栏；`card` 列表/仪表盘卡片底栏。
 */
export function mountStickyTagToolbar(
	host: HTMLElement,
	opts: {
		app: App;
		getFile: () => TFile | null;
		enabled: boolean;
		variant: 'floating' | 'card';
		/** 便笺根目录（用于「全部便笺标签」目录）。 */
		stickyFolder?: string;
	}
): StickyTagToolbarHandle {
	const el = host.createDiv({
		cls: `csn-sticky-tag-toolbar csn-sticky-tag-toolbar--${opts.variant}`,
		attr: { 'aria-label': t('STICKY_TAG_TOOLBAR_ARIA') }
	});
	const chipsEl = el.createDiv({ cls: 'csn-sticky-tag-toolbar-chips' });
	const addWrap = el.createDiv({ cls: 'csn-sticky-tag-toolbar-add-wrap' });
	const addBtn = addWrap.createEl('button', {
		type: 'button',
		cls: 'clickable-icon csn-sticky-tag-toolbar-add',
		attr: {
			'aria-label': t('STICKY_TAG_ADD_ARIA'),
			title: t('STICKY_TAG_ADD_ARIA'),
			'aria-expanded': 'false',
			'aria-haspopup': 'true'
		}
	});
	setIcon(addBtn, 'plus');

	const listStickyFiles = (): TFile[] => {
		const folder = normalizePath(opts.stickyFolder || 'StickyNotes');
		const folderAbs = opts.app.vault.getAbstractFileByPath(folder);
		if (!folderAbs || !(folderAbs instanceof TFolder)) return [];
		return collectMarkdownUnderFolder(folderAbs);
	};

	const picker = new StickyTagPickerPanel({
		app: opts.app,
		host: addWrap,
		anchorEl: addWrap,
		ariaLabel: t('DASH_COMPOSER_TAG_PANEL_ARIA'),
		placement: 'above',
		getSelectedTags: () => {
			const file = opts.getFile();
			return file ? getStickyFrontmatterTagsForFile(opts.app, file) : [];
		},
		onToggleTag: async raw => {
			const file = opts.getFile();
			if (!file) return;
			const tag = normalizeStickyTag(raw);
			if (!tag) return;
			const cur = getStickyFrontmatterTagsForFile(opts.app, file);
			const has = cur.includes(tag);
			const next = has ? cur.filter(x => x !== tag) : [...cur, tag];
			await writeStickyTagsToFile(opts.app, file, next);
			refreshChips();
			picker.refreshIfOpen();
		},
		onRequestClose: () => {
			picker.close();
			setPickerOpenUi(false);
		},
		listStickyFiles
	});

	let enabled = opts.enabled;
	let destroyed = false;

	const setPickerOpenUi = (open: boolean): void => {
		addBtn.setAttr('aria-expanded', open ? 'true' : 'false');
		addBtn.toggleClass('is-active', open);
		el.toggleClass('is-picker-open', open);
	};

	const openPicker = (): void => {
		if (!opts.getFile()) return;
		picker.open({ group: 'current' });
		setPickerOpenUi(true);
	};

	const togglePicker = (): void => {
		if (!opts.getFile()) return;
		picker.toggle({ group: 'current' });
		setPickerOpenUi(picker.isOpen());
	};

	const syncVisibility = (): void => {
		el.toggleClass('is-hidden', !enabled);
		host.toggleClass('csn-has-sticky-tag-toolbar', enabled);
		if (!enabled) {
			picker.close();
			setPickerOpenUi(false);
		}
	};

	const refreshChips = (): void => {
		if (destroyed) return;
		syncVisibility();
		chipsEl.empty();
		if (!enabled) return;
		const file = opts.getFile();
		if (!file) return;
		const tags = getStickyFrontmatterTagsForFile(opts.app, file);
		for (const tag of tags) {
			const label = displayStickyTag(tag);
			const href = tag.startsWith('#') ? tag : `#${tag}`;
			/* Obsidian 原生 a.tag：X 放在标签内，背景色覆盖整颗芯片（含 Colored Tags） */
			const link = chipsEl.createEl('a', {
				cls: 'tag csn-sticky-tag-item',
				attr: {
					href,
					target: '_blank',
					rel: 'noopener',
					'aria-label': href,
					'data-csn-tag': tag
				}
			});
			link.createSpan({ cls: 'csn-sticky-tag-label', text: href });
			const remove = link.createSpan({
				cls: 'csn-sticky-tag-chip-x',
				attr: {
					role: 'button',
					tabindex: '0',
					'aria-label': t('STICKY_TAG_CHIP_REMOVE_ARIA', { tag: label }),
					title: t('STICKY_TAG_CHIP_REMOVE_ARIA', { tag: label })
				}
			});
			setIcon(remove, 'x');
			const stop = (evt: Event) => evt.stopPropagation();
			link.addEventListener('pointerdown', stop);
			link.addEventListener('dblclick', evt => {
				evt.preventDefault();
				evt.stopPropagation();
			});
			/* 点击标签打开选择器；删除仅由 X 触发 */
			link.addEventListener('click', evt => {
				evt.preventDefault();
				evt.stopPropagation();
				if (evt.target instanceof Element && evt.target.closest('.csn-sticky-tag-chip-x')) {
					return;
				}
				openPicker();
			});
			remove.addEventListener('click', evt => {
				evt.preventDefault();
				evt.stopPropagation();
				const f = opts.getFile();
				if (!f) return;
				const next = getStickyFrontmatterTagsForFile(opts.app, f).filter(x => x !== tag);
				void writeStickyTagsToFile(opts.app, f, next).then(() => {
					refreshChips();
					picker.refreshIfOpen();
				});
			});
			remove.addEventListener('pointerdown', stop);
			remove.addEventListener('keydown', evt => {
				if (evt.key !== 'Enter' && evt.key !== ' ') return;
				evt.preventDefault();
				evt.stopPropagation();
				remove.click();
			});
			remove.addEventListener('dblclick', evt => {
				evt.preventDefault();
				evt.stopPropagation();
			});
		}
	};

	addBtn.addEventListener('click', evt => {
		evt.preventDefault();
		evt.stopPropagation();
		togglePicker();
	});
	addBtn.addEventListener('pointerdown', evt => evt.stopPropagation());
	addBtn.addEventListener('dblclick', evt => {
		evt.preventDefault();
		evt.stopPropagation();
	});
	el.addEventListener('pointerdown', evt => evt.stopPropagation());
	el.addEventListener('dblclick', evt => {
		evt.preventDefault();
		evt.stopPropagation();
	});

	const onDocPointer = (evt: PointerEvent): void => {
		if (!picker.isOpen()) return;
		const tEl = evt.target;
		if (!(tEl instanceof Node)) return;
		/* 面板内不关；遮罩由自身 handler 关闭；工具栏 +/芯片保持可点 */
		if (picker.contains(tEl) || addBtn.contains(tEl) || chipsEl.contains(tEl)) return;
		picker.close();
		setPickerOpenUi(false);
	};
	const doc = host.ownerDocument;
	doc.addEventListener('pointerdown', onDocPointer, true);

	syncVisibility();
	refreshChips();

	return {
		el,
		refresh: () => {
			refreshChips();
			picker.refreshIfOpen();
		},
		setEnabled: next => {
			enabled = next;
			refreshChips();
		},
		destroy: () => {
			destroyed = true;
			host.ownerDocument.removeEventListener('pointerdown', onDocPointer, true);
			picker.destroy();
			host.removeClass('csn-has-sticky-tag-toolbar');
			el.remove();
		},
		isPickerOpen: () => picker.isOpen(),
		closePicker: () => {
			picker.close();
			setPickerOpenUi(false);
		},
		pickerContains: node => picker.contains(node)
	};
}
