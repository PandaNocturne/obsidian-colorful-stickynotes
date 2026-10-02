import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { Component, type App, type Editor as ObsidianEditor, type Plugin, type TFile } from 'obsidian';

/** Obsidian 内部 Markdown 源码编辑器构造函数（经 embedRegistry 提取）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObsidianMarkdownEditorCtor = new (...args: any[]) => any;

/**
 * 从 Obsidian 内部 `embedRegistry` 提取可嵌入的 Markdown 编辑器类（与 Kanban 插件相同手法）。
 * 需在 `onload` 且布局可用后调用。
 */
export function resolveObsidianMarkdownEditorClass(app: App): ObsidianMarkdownEditorCtor | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const embedRegistry = (app as any).embedRegistry;
		if (!embedRegistry?.embedByExtension?.md) return null;
		const containerEl = document.createElement('div');
		const md = embedRegistry.embedByExtension.md({ app, containerEl, state: {} }, null, '');
		md.load();
		md.editable = true;
		md.showEditor();
		if (!md.editMode) {
			md.unload();
			return null;
		}
		const Ctor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode))
			.constructor as ObsidianMarkdownEditorCtor;
		md.unload();
		return typeof Ctor === 'function' ? Ctor : null;
	} catch (e) {
		console.error('[colorful-sticky-notes] resolveObsidianMarkdownEditorClass failed', e);
		return null;
	}
}

function noop(): void {
	/* empty */
}

/** 精简 vault 配置代理：嵌入编辑器不显示行号/折叠。 */
function createEditorAppProxy(app: App): App {
	return new Proxy(app, {
		get(target, prop, receiver) {
			if (prop === 'vault') {
				return new Proxy(target.vault, {
					get(vaultTarget, vaultProp, vaultReceiver) {
						if (vaultProp === 'config') {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const config = (vaultTarget as any).config;
							return new Proxy(config ?? {}, {
								get(cfgTarget, cfgProp, cfgReceiver) {
									if (['showLineNumber', 'foldHeading', 'foldIndent'].includes(String(cfgProp))) {
										return false;
									}
									return Reflect.get(cfgTarget, cfgProp, cfgReceiver);
								}
							});
						}
						return Reflect.get(vaultTarget, vaultProp, vaultReceiver);
					}
				});
			}
			return Reflect.get(target, prop, receiver);
		}
	});
}

/** 在嵌入 CM 中插入换行（不依赖可能未安装类型的 @codemirror/commands）。 */
function insertNewline(cm: EditorView): boolean {
	const sel = cm.state.selection.main;
	cm.dispatch({
		changes: { from: sel.from, to: sel.to, insert: '\n' },
		selection: { anchor: sel.from + 1 },
		userEvent: 'input'
	});
	return true;
}

export interface EmbeddedMarkdownEditorOptions {
	plugin: Plugin;
	app: App;
	hostEl: HTMLElement;
	/** 内部 MarkdownEditor 类（插件 onload 时缓存）。 */
	MarkdownEditor: ObsidianMarkdownEditorCtor;
	/**
	 * 关联文件（链接建议等）。
	 * 快速输入等「无文件」场景务必返回 `null`，否则 Enter/同步会把活动文件内容灌进编辑器或清空。
	 */
	getFile: () => TFile | null;
	placeholder?: string;
	initialValue?: string;
	/** Mod/Ctrl+Enter 提交。 */
	onSubmit: (markdown: string) => void;
	/** Escape。 */
	onEscape?: () => void;
	/** 文档内容变化（含程序 setValue）。 */
	onChange?: (markdown: string) => void;
}

/**
 * 在指定 DOM 宿主中挂载 Obsidian 原生 Markdown 源码编辑器（CM6）。
 * 生命周期由 `plugin.addChild` / `removeChild` 管理。
 */
export class EmbeddedMarkdownEditorHost {
	private editorChild: Component | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private editorInst: any = null;
	private cm: EditorView | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private controller: Record<string, any> | null = null;

	constructor(private readonly opts: EmbeddedMarkdownEditorOptions) {}

	mount(): void {
		this.destroy();
		const {
			plugin,
			app,
			hostEl,
			MarkdownEditor,
			getFile,
			placeholder,
			initialValue,
			onSubmit,
			onEscape,
			onChange
		} = this.opts;
		hostEl.empty();
		const proxiedApp = createEditorAppProxy(app);

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		class Editor extends MarkdownEditor {
			updateBottomPadding(): void {
				/* 嵌入场景不需要底栏留白 */
			}

			buildLocalExtensions(): Extension[] {
				const extensions: Extension[] = super.buildLocalExtensions();
				if (placeholder) extensions.push(placeholderExt(placeholder));
				if (onChange) {
					extensions.push(
						EditorView.updateListener.of(update => {
							if (update.docChanged) onChange(update.state.doc.toString());
						})
					);
				}

				extensions.push(
					Prec.highest(
						EditorView.domEventHandlers({
							focus: (evt: FocusEvent) => {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								const owner = (this as any).owner ?? self.controller;
								const win = (evt.target as Node | null)?.ownerDocument?.defaultView ?? window;
								win.setTimeout(() => {
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									(app.workspace as any).activeEditor = owner;
								});
								return true;
							}
						})
					)
				);

				const handleEnter = (_mod: boolean, _shift: boolean) => (cm: EditorView) => {
					try {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const ed = (this as any).editor as ObsidianEditor | undefined;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const smart = (this as any).app?.vault?.getConfig?.('smartIndentList');
						if (smart && ed && typeof (ed as any).newlineAndIndentContinueMarkdownList === 'function') {
							(ed as any).newlineAndIndentContinueMarkdownList();
							return true;
						}
					} catch {
						/* fall through */
					}
					return insertNewline(cm);
				};

				extensions.push(
					Prec.highest(
						keymap.of([
							{
								key: 'Enter',
								run: handleEnter(false, false),
								shift: handleEnter(false, true),
								preventDefault: true
							},
							{
								key: 'Mod-Enter',
								run: (cm: EditorView) => {
									onSubmit(cm.state.doc.toString());
									return true;
								},
								preventDefault: true
							},
							{
								key: 'Escape',
								run: () => {
									onEscape?.();
									return true;
								},
								preventDefault: true
							}
						])
					)
				);
				return extensions;
			}
		}

		const controller: Record<string, unknown> = {
			app,
			showSearch: noop,
			toggleMode: noop,
			onMarkdownScroll: noop,
			getMode: () => 'source',
			scroll: 0,
			editMode: null as unknown,
			get editor(): ObsidianEditor {
				return self.editorInst?.editor as ObsidianEditor;
			},
			get file(): TFile | null {
				return getFile();
			},
			get path(): string {
				return getFile()?.path ?? '';
			}
		};
		this.controller = controller;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const editor = plugin.addChild(new (Editor as any)(proxiedApp, hostEl, controller));
		controller.editMode = editor;
		this.editorChild = editor;
		this.editorInst = editor;
		this.cm = (editor.cm ?? editor.editor?.cm) as EditorView;
		if (!this.cm) {
			throw new Error('Obsidian MarkdownEditor did not expose a CodeMirror view');
		}
		if (typeof editor.set === 'function') {
			editor.set(initialValue ?? '');
		} else {
			this.setValue(initialValue ?? '');
		}
	}

	getValue(): string {
		if (this.cm) return this.cm.state.doc.toString();
		try {
			return (this.editorInst?.editor?.getValue?.() as string) ?? '';
		} catch {
			return '';
		}
	}

	setValue(value: string): void {
		if (this.editorInst?.set) {
			this.editorInst.set(value);
			return;
		}
		if (this.cm) {
			this.cm.dispatch({
				changes: { from: 0, to: this.cm.state.doc.length, insert: value }
			});
		}
	}

	focus(): void {
		this.cm?.focus();
	}

	destroy(): void {
		if (this.editorChild) {
			try {
				this.opts.plugin.removeChild(this.editorChild);
			} catch {
				/* already detached */
			}
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		if ((this.opts.app.workspace as any).activeEditor === this.controller) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.opts.app.workspace as any).activeEditor = null;
		}
		this.editorChild = null;
		this.editorInst = null;
		this.cm = null;
		this.controller = null;
		this.opts.hostEl.empty();
	}
}
