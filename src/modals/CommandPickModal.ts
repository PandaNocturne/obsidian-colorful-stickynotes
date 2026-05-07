import { App, FuzzySuggestModal } from 'obsidian';
import { getAppCommands } from '../obsidian-commands';

export interface CommandEntry {
	id: string;
	name: string;
}

export class CommandPickModal extends FuzzySuggestModal<CommandEntry> {
	private readonly all: CommandEntry[];
	private readonly onPicked: (cmd: CommandEntry) => void;

	constructor(app: App, onPicked: (cmd: CommandEntry) => void) {
		super(app);
		this.onPicked = onPicked;
		this.all = getAppCommands(app).listCommands().map((c: { id: string; name: string }) => ({
			id: c.id,
			name: c.name
		}));
		this.setPlaceholder('搜索命令…');
	}

	getItems(): CommandEntry[] {
		return this.all;
	}

	getItemText(item: CommandEntry): string {
		return `${item.name} (${item.id})`;
	}

	onChooseItem(item: CommandEntry): void {
		this.onPicked(item);
	}
}
