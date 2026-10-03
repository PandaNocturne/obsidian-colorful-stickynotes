**Colorful Sticky Notes** · [English](#english) · [中文](#中文)

# English

**Colorful Sticky Notes** is an [Obsidian](https://obsidian.md) plugin that opens **draggable, stackable sticker-style windows** over your vault. Each sticky is backed by a Obsidian note (default folder `StickyNotes`, configurable).

Sticky dashboard — Quick Access, calendar, workspace tree, filters, and composer:

![Sticky dashboard](<assets/dashboard%20view.jpg>)

Sticky list — sidebar grid with filters, sorting, and pagination:

![Sticky list](<assets/colorful%20stickynote.jpg>)

Workspace panel — manage groups, search/locate, and Ungrouped filter:

![Workspace panel](<assets/workspace%20panel.jpg>)

## Features

- **Floating sticky windows** — Small windows above the UI; content comes from vault notes.
- **Background colors** — Palettes such as yellow, pink, mint, blue, lavender, and gray (stored in note frontmatter).
- **YAML tag toolbar** — Native Obsidian tags on floating stickies, list cards, and dashboard cards (Colored Tags compatible), with separate show/hide toggles.
- **Sticky list** — Sidebar grid with filters (open state, archive, color, workspace), sorting, pinning, pagination, and adjustable card size/columns.
- **Sticky dashboard** — Main-tab overview with Quick Access areas, calendar heatmap, workspace tree, tag/workspace/date filters, and an embedded composer.
- **Sticky workspaces** — Save and switch window layouts; manage groups, trash, search/locate in the workspace panel (including Ungrouped filter).
- **Extras** — Edge snap / auto-resize, drag snapping and grouping, restore session on startup, filename templates (Moment-style + subfolders), optional default template note. Settings are organized into tabs.

## Canvas integration

From the **sticky list**, drag one or more stickies via the **drag handle** onto **Canvas** to create nodes. Batch drops follow spacing and “max per row” from settings.

- Plain drag → **file cards** (vault link)
- **Ctrl** drag → embed content as text cards (**⌘** on macOS)
- **Shift** drag → embed content and move original to trash (use with care)

Optional behavior lives under **Canvas link** in settings (default node size, auto-fit height, color sync, zoom-to-selection, drag hints, etc.).

<video controls src="assets/canvas%20demo.mp4" title="Canvas integration"></video>

## Installation

**Community Plugins (recommended)**

1. Settings → **Community plugins** → turn off Safe mode if needed.
2. **Browse** → search for **Colorful StickyNotes**.
3. Install, then enable the plugin.

**Via BRAT (beta)**

1. Install **BRAT** from Community Plugins.
2. Settings → **BRAT** → **Add Beta plugin**.
3. Repo URL: `https://github.com/PandaNocturne/obsidian-colorful-stickynotes`.
4. Add the plugin, then enable it under Community Plugins.

**Manual**

1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/PandaNocturne/obsidian-colorful-stickynotes/releases).
2. Create `.obsidian/plugins/colorful-stickynotes` in your vault and copy the files in.
3. Restart Obsidian and enable the plugin.

## Development

1. Clone this repo.
2. `npm install`
3. `npm run build`

## Credits

Inspired in part by:

- [**obsidian-card-note**](https://github.com/cycsd/obsidian-card-note) — card-style notes and floating UI ideas
- [**obsidian-hover-editor**](https://github.com/nothingislost/obsidian-hover-editor) — floating editor and window behavior
- [**obsidian-kanban**](https://github.com/mgmeyers/obsidian-kanban) — embedded Markdown editing

## License

[MIT](LICENSE)

# 中文

**Colorful StickyNotes（彩色便笺）** 是面向 [Obsidian](https://obsidian.md) 的插件：在库内打开**可拖拽、可叠放的彩色便笺窗口**，每个便笺背后都是一篇 Obsidian 笔记。默认目录为 `StickyNotes`，可在设置中修改。

便笺仪表盘 — 快速访问、日历、工作区树、筛选与输入区：

![便笺仪表盘](<assets/dashboard%20view.jpg>)

便笺列表 — 侧边栏网格，支持筛选、排序与分页：

![便笺列表](<assets/colorful%20stickynote.jpg>)

工作区管理面板 — 分组管理、搜索定位与未分组筛选：

![工作区管理面板](<assets/workspace%20panel.jpg>)

## 主要功能

- **浮动便笺窗口** — 小窗口叠在界面上方，内容来自库内笔记（默认目录 `StickyNotes`，可在设置中修改）。
- **多种背景色** — 亮黄、粉、薄荷、天蓝、薰衣草、浅灰等主题，样式通过笔记 frontmatter 记录。
- **YAML 标签栏** — 悬浮窗、列表卡片、仪表盘卡片支持 Obsidian 原生标签（可被 Colored Tags 识别），三处显示开关相互独立。
- **便笺列表** — 侧边栏网格浏览，支持打开状态、归档、颜色、工作区等筛选，以及排序、置顶、分页与卡片尺寸调节。
- **便笺仪表盘** — 主标签页总览：快速访问、日历热力、工作区树、标签/工作区/日期筛选与嵌入输入区。
- **便笺工作区** — 保存与切换窗口布局；管理面板支持分组、回收站、搜索定位，以及「未分组」筛选。
- **辅助能力** — 贴边自动拉高、对齐吸附与编组、启动恢复会话、文件名模板（Moment 风格与子目录）、可选默认模板等。插件设置按分区以标签页展示。

## Canvas 联动

在 **便笺列表** 中按住卡片**拖拽手柄**，可将一张或多张便笺拖到 Obsidian **Canvas** 上松手，在落点创建节点；多张时按设置中的间距与「每行最多」排成网格。

拖入 Canvas 时的操作：

- 直接拖拽 → **文件卡片**（库内引用）
- 按住 **Ctrl** 拖拽 → 嵌入文本内容（macOS 为 **⌘**）
- 按住 **Shift** 拖拽 → 嵌入内容并删除原文件（移入回收站，请谨慎使用）

可选能力在设置 **「Canvas 联动」** 中调整：新建节点默认宽高、拖入后自动贴合高度、节点颜色与便笺颜色同步、拖入后缩放画布以框选新建节点、拖拽时显示按键说明等。

<video controls src="assets/canvas%20demo.mp4" title="Canvas 联动"></video>

## 安装方法

### 通过官方插件市场安装（推荐）

1. 打开 **设置** → **第三方插件**，按需关闭安全模式。
2. 点击 **浏览**，搜索 **Colorful StickyNotes**（彩色便笺）。
3. 安装后在第三方插件列表中启用。

### 通过 BRAT 安装

1. 在 Obsidian 社区插件市场安装 **BRAT** 插件。
2. 前往 **设置** → **BRAT**。
3. 点击 **Add Beta plugin**（添加测试插件）。
4. 输入本仓库地址：`https://github.com/PandaNocturne/obsidian-colorful-stickynotes`。
5. 点击 **Add Plugin**。
6. 在 **第三方插件** 中启用该插件。

### 手动安装

1. 在 [Releases](https://github.com/PandaNocturne/obsidian-colorful-stickynotes/releases) 页面下载最新的 `main.js`、`manifest.json`、`styles.css`。
2. 在你的库的 `.obsidian/plugins/` 目录下创建一个名为 `colorful-stickynotes` 的文件夹。
3. 将下载的文件放入该文件夹。
4. 重启 Obsidian 并在设置中启用。

## 开发

如果你想自行构建插件：

1. 克隆此仓库。
2. 运行 `npm install` 安装依赖。
3. 运行 `npm run build` 进行编译。

## 致谢

本插件在设计与实现上参考、借鉴了以下社区作品，在此致谢：

- [**obsidian-card-note**](https://github.com/cycsd/obsidian-card-note) — 卡片化笔记与浮层交互方面的思路
- [**obsidian-hover-editor**](https://github.com/nothingislost/obsidian-hover-editor) — 浮动编辑器与窗口行为的实现参考
- [**obsidian-kanban**](https://github.com/mgmeyers/obsidian-kanban) — 嵌入 Markdown 编辑的实现参考

## 许可

[MIT](LICENSE)
