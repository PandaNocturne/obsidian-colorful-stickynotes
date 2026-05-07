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

/** 列表/菜单小色块用，与 `.csn-sticky` / 列表卡片底色一致（亮暗主题）。 */
export const STICKY_MENU_SWATCH_HEX: Record<
	StickyColorId,
	{ light: string; dark: string } | null
> = {
	default: null,
	yellow: { light: '#fff8d4', dark: '#3d3820' },
	mint: { light: '#e4fff4', dark: '#1e3d30' },
	pink: { light: '#ffe8f0', dark: '#3d2028' },
	lavender: { light: '#f0e8ff', dark: '#282040' },
	blue: { light: '#e8f4ff', dark: '#1e303d' },
	gray: { light: '#f0f0f0', dark: '#2a2a2a' }
};
