**Colorful StickyNotes（彩色便笺）** 是一款 [Obsidian](https://obsidian.md) 插件，在库中提供**可浮动的彩色便笺窗口**，每个便笺对应一篇普通 Markdown 笔记，方便随手记、对照阅读或当作轻量「便笺」，而不必打乱主编辑区布局。

### 主要功能

- **浮动便笺窗口** — 小窗口叠在界面上方，内容来自库内笔记（默认目录 `StickyNotes`，可在设置中修改）。
- **多种背景色** — 亮黄、粉、薄荷、天蓝、薰衣草、浅灰等主题，样式通过笔记 frontmatter 记录。
- **便笺列表** — 网格浏览便笺，支持按打开状态、归档、颜色等筛选，排序、置顶、分页与卡片高度/列宽等可调。
- **便笺工作区** — 保存、切换便笺窗口布局（工作区快照），适配不同使用场景。
- **辅助能力** — 贴边自动拉高、拖动时对齐吸附与窗口编组、启动时恢复上次便笺会话、新建文件名模板（支持 Moment 风格与子目录）、可选默认模板笔记等。


## 安装方法

### 通过 BRAT 安装（推荐）

1. 在 Obsidian 社区插件市场安装 **BRAT** 插件。
2. 前往 **设置** → **BRAT**。
3. 点击 **Add Beta plugin**（添加测试插件）。
4. 输入本仓库地址：`https://github.com/PandaNocturne/obsidian-colorful-stickynotes`。
5. 点击 **Add Plugin**。
6. 在 **社区插件** 中启用该插件。

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

## 许可

[MIT](LICENSE)
