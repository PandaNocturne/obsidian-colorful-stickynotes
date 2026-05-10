import { around } from 'monkey-around';
import { WorkspaceContainer, WorkspaceItem, WorkspaceLeaf, WorkspaceParent, type Plugin } from 'obsidian';

function workspaceParentUp(item: WorkspaceItem): WorkspaceParent | undefined {
	const anyItem = item as unknown as { parent?: WorkspaceParent; parentSplit?: WorkspaceParent };
	return anyItem.parent ?? anyItem.parentSplit;
}

/**
 * 与 obsidian-hover-editor 一致：浮动在工作区 DOM 外的 WorkspaceLeaf 需要正确的 getRoot / getContainer 解析，
 * 否则 Obsidian 的 activeLeaf、命令与快捷键上下文无法落到当前便笺叶上。
 */
export function registerStickyWorkspacePatches(plugin: Plugin): void {
	plugin.register(
		around(WorkspaceLeaf.prototype, {
			getRoot(old: WorkspaceLeaf['getRoot']) {
				return function (this: WorkspaceLeaf) {
					const top = old.call(this);
					return top.getRoot === this.getRoot ? top : top.getRoot();
				};
			}
		})
	);
	plugin.register(
		around(WorkspaceItem.prototype, {
			getContainer(old: WorkspaceItem['getContainer']) {
				return function (this: WorkspaceItem): WorkspaceContainer {
					const upward = workspaceParentUp(this);
					if (!upward || this instanceof WorkspaceContainer) {
						return old.call(this);
					}
					return upward.getContainer();
				};
			}
		})
	);
}
