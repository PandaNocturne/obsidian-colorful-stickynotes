import type { StickyColorId } from '../types';

/** 与便笺设置面板底部色条顺序、标签一致。 */
export const SHEET_COLOR_ORDER: { id: StickyColorId; label: string }[] = [
	{ id: 'yellow', label: '亮黄' },
	{ id: 'mint', label: '薄荷' },
	{ id: 'pink', label: '粉红' },
	{ id: 'lavender', label: '淡紫' },
	{ id: 'blue', label: '天蓝' },
	{ id: 'gray', label: '浅灰' },
	{ id: 'default', label: '默认' }
];
