import type { App } from 'obsidian';

/** Runtime Obsidian API — typings may omit `commands`. */
export type AppCommands = {
	listCommands(): { id: string; name: string }[];
	executeCommandById(id: string): boolean;
};

export function getAppCommands(app: App): AppCommands {
	return (app as App & { commands: AppCommands }).commands;
}
