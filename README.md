中文说明：[README.zh-CN.md](README.zh-CN.md)

**Colorful Sticky Notes** is an [Obsidian](https://obsidian.md) plugin that opens **draggable, stackable sticker-style windows** over your vault. Each sticky is backed by a normal Markdown note (default folder `StickyNotes`, configurable).

### Features

- **Floating sticky windows** — Small windows above the UI; content comes from vault notes.
- **Background colors** — Palettes such as yellow, pink, mint, blue, lavender, and gray (stored in note frontmatter).
- **Sticky list** — Grid view with filters (open state, archive, color), sorting, pinning, pagination, and adjustable card size/columns.
- **Sticky workspaces** — Save and switch window layouts (snapshots) for different setups.
- **Extras** — Edge snap / auto-resize, drag snapping and grouping, restore session on startup, filename templates (Moment-style + subfolders), optional default template note.

### Canvas integration

From the **sticky list**, drag one or more stickies via the **drag handle** onto **Canvas** to create nodes. Batch drops follow spacing and “max per row” from settings.

- Plain drag → embed content
- **Ctrl** drag → link to file (**⌘** on macOS)
- **Shift** drag → embed and move original to trash (use with care)

Optional behavior lives under **Canvas link** in settings (default node size, auto-fit height, color sync, zoom-to-selection, drag hints, etc.).

### Installation

**Via BRAT (beta)**

1. Install **BRAT** from Community Plugins.
2. Settings → **BRAT** → **Add Beta plugin**.
3. Repo URL: `https://github.com/PandaNocturne/obsidian-colorful-stickynotes`.
4. Add the plugin, then enable it under Community Plugins.

**Manual**

1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/PandaNocturne/obsidian-colorful-stickynotes/releases).
2. Create `.obsidian/plugins/colorful-stickynotes` in your vault and copy the files in.
3. Restart Obsidian and enable the plugin.

### Development

1. Clone this repo.
2. `npm install`
3. `npm run build`

### Credits

Inspired in part by [**obsidian-card-note**](https://github.com/cycsd/obsidian-card-note) and [**obsidian-hover-editor**](https://github.com/nothingislost/obsidian-hover-editor).

### License

[MIT](LICENSE)
