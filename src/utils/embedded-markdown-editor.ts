import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import {
	Component,
	type App,
	type Editor as ObsidianEditor,
	type MarkdownFileInfo,
	type Plugin,
	type TFile,
	type Vault
} from 'obsidian';

/** 嵌入 Markdown 编辑器实例上可选的列表续写能力（Obsidian 私有方法）。 */
interface EditorWithListContinue extends ObsidianEditor {
	cm?: EditorView;
	newlineAndIndentContinueMarkdownList?: () => void;
}

/** Obsidian 内部 Markdown 源码编辑器实例（经 embedRegistry 提取）。 */
export interface ObsidianMarkdownEditorInstance extends Component {
	app: App;
	cm?: EditorView;
	editor?: EditorWithListContinue;
	owner?: MarkdownFileInfo | null;
	set?(value: string): void;
	buildLocalExtensions(): Extension[];
	updateBottomPadding?(): void;
}

/** Obsidian 内部 Markdown 源码编辑器构造函数（经 embedRegistry 提取）。 */
export type ObsidianMarkdownEditorCtor = new (
	app: App,
	containerEl: HTMLElement,
	owner: MarkdownFileInfo
) => ObsidianMarkdownEditorInstance;

/** 嵌入编辑器的 owner / controller（兼容 Workspace.activeEditor）。 */
interface EmbeddedEditorController extends MarkdownFileInfo {
	showSearch: () => void;
	toggleMode: () => void;
	onMarkdownScroll: () => void;
	getMode: () => string;
	scroll: number;
	editMode: ObsidianMarkdownEditorInstance | null;
	get path(): string;
}

interface EmbedByExtension {
	md?: (
		options: { app: App; containerEl: HTMLElement; state: Record<string, unknown> },
		file: TFile | null,
		subpath: string
	) => MarkdownEmbedInstance;
}

interface EmbedRegistry {
	embedByExtension?: EmbedByExtension;
}

interface AppWithEmbedRegistry {
	embedRegistry?: EmbedRegistry;
}

interface MarkdownEmbedInstance {
	load(): void;
	unload(): void;
	editable: boolean;
	showEditor(): void;
	editMode?: object;
}

interface VaultWithPrivateConfig extends Vault {
	config?: Record<string, unknown>;
	getConfig?(key: string): unknown;
}

function asAppWithEmbedRegistry(app: App): AppWithEmbedRegistry {
	return app as unknown as AppWithEmbedRegistry;
}

function asVaultWithPrivateConfig(vault: Vault): VaultWithPrivateConfig {
	return vault as unknown as VaultWithPrivateConfig;
}

function reflectGet(target: object, prop: PropertyKey, receiver: unknown): unknown {
	const value: unknown = Reflect.get(target, prop, receiver);
	return value;
}

/**
 * 从 Obsidian 内部 `embedRegistry` 提取可嵌入的 Markdown 编辑器类（与 Kanban 插件相同手法）。
 * 需在 `onload` 且布局可用后调用。
 */
export function resolveObsidianMarkdownEditorClass(app: App): ObsidianMarkdownEditorCtor | null {
	try {
		const embedRegistry = asAppWithEmbedRegistry(app).embedRegistry;
		if (!embedRegistry?.embedByExtension?.md) return null;
		const containerEl = app.workspace.containerEl.createDiv();
		containerEl.detach();
		const md = embedRegistry.embedByExtension.md({ app, containerEl, state: {} }, null, '');
		md.load();
		md.editable = true;
		md.showEditor();
		if (!md.editMode) {
			md.unload();
			return null;
		}
		const proto = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)) as {
			constructor?: unknown;
		};
		const Ctor = proto.constructor;
		md.unload();
		return typeof Ctor === 'function' ? (Ctor as ObsidianMarkdownEditorCtor) : null;
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
		get(target, prop, receiver): unknown {
			if (prop === 'vault') {
				return new Proxy(target.vault, {
					get(vaultTarget, vaultProp, vaultReceiver): unknown {
						if (vaultProp === 'config') {
							const config = asVaultWithPrivateConfig(vaultTarget).config ?? {};
							return new Proxy(config, {
								get(cfgTarget, cfgProp, cfgReceiver): unknown {
									if (['showLineNumber', 'foldHeading', 'foldIndent'].includes(String(cfgProp))) {
										return false;
									}
									return reflectGet(cfgTarget, cfgProp, cfgReceiver);
								}
							});
						}
						return reflectGet(vaultTarget, vaultProp, vaultReceiver);
					}
				});
			}
			return reflectGet(target, prop, receiver);
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
	/** Escape；未提供时按键仍被吞掉，不做清空/失焦。 */
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
	private editorInst: ObsidianMarkdownEditorInstance | null = null;
	private cm: EditorView | null = null;
	private controller: EmbeddedEditorController | null = null;

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
			onEscape,
			onChange
		} = this.opts;
		hostEl.empty();
		const proxiedApp = createEditorAppProxy(app);

		let editorInst: ObsidianMarkdownEditorInstance | null = null;
		let controller!: EmbeddedEditorController;

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
								const owner = this.owner ?? controller;
								const win = (evt.target as Node | null)?.ownerDocument?.defaultView ?? window;
								win.setTimeout(() => {
									app.workspace.activeEditor = owner;
								});
								return false;
							},
							keydown: (evt: KeyboardEvent) => {
								if (evt.key !== 'Escape') return false;
								evt.preventDefault();
								evt.stopPropagation();
								onEscape?.();
								return true;
							}
						})
					)
				);

				const handleEnter = (_mod: boolean, _shift: boolean) => (cm: EditorView) => {
					try {
						const ed = this.editor;
						const smart = asVaultWithPrivateConfig(this.app.vault).getConfig?.('smartIndentList');
						if (smart && ed && typeof ed.newlineAndIndentContinueMarkdownList === 'function') {
							ed.newlineAndIndentContinueMarkdownList();
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

		controller = {
			app,
			hoverPopover: null,
			showSearch: noop,
			toggleMode: noop,
			onMarkdownScroll: noop,
			getMode: () => 'source',
			scroll: 0,
			editMode: null,
			get editor(): ObsidianEditor | undefined {
				return editorInst?.editor;
			},
			get file(): TFile | null {
				return getFile();
			},
			get path(): string {
				return getFile()?.path ?? '';
			}
		};
		this.controller = controller;

		const editor = plugin.addChild(new Editor(proxiedApp, hostEl, controller));
		controller.editMode = editor;
		editorInst = editor;
		this.editorChild = editor;
		this.editorInst = editor;
		const cm = editor.cm ?? editor.editor?.cm;
		if (!cm) {
			throw new Error('Obsidian MarkdownEditor did not expose a CodeMirror view');
		}
		this.cm = cm;
		if (typeof editor.set === 'function') {
			editor.set(initialValue ?? '');
		} else {
			this.setValue(initialValue ?? '');
		}
	}

	getValue(): string {
		if (this.cm) return this.cm.state.doc.toString();
		try {
			const value = this.editorInst?.editor?.getValue();
			return typeof value === 'string' ? value : '';
		} catch {
			return '';
		}
	}

	setValue(value: string): void {
		if (typeof this.editorInst?.set === 'function') {
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
		if (this.opts.app.workspace.activeEditor === this.controller) {
			this.opts.app.workspace.activeEditor = null;
		}
		this.editorChild = null;
		this.editorInst = null;
		this.cm = null;
		this.controller = null;
		this.opts.hostEl.empty();
	}
}
