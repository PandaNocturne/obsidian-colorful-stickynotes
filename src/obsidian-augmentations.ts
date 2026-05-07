import type { Menu } from 'obsidian';

declare module 'obsidian' {
	interface MenuItem {
		/**
		 * 绑定右侧级联子菜单（与核心「更多选项」等菜单一致）。
		 * 官方 typings 未收录，由应用运行时提供。
		 */
		setSubmenu(): Menu;
	}
}

export {};
