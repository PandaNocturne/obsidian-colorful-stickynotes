import type { MessageKey } from '../lang/locale/en';
import type { StickyColorId } from '../types';

/** 与便笺设置面板底部色条顺序、标签一致（文案经 `t(labelKey)`）。 */
export const SHEET_COLOR_ORDER: { id: StickyColorId; labelKey: MessageKey }[] = [
	{ id: 'yellow', labelKey: 'COLOR_YELLOW' },
	{ id: 'mint', labelKey: 'COLOR_MINT' },
	{ id: 'pink', labelKey: 'COLOR_PINK' },
	{ id: 'lavender', labelKey: 'COLOR_LAVENDER' },
	{ id: 'blue', labelKey: 'COLOR_BLUE' },
	{ id: 'gray', labelKey: 'COLOR_GRAY' },
	{ id: 'default', labelKey: 'COLOR_DEFAULT' }
];
