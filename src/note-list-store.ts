import type { Plugin } from 'obsidian';
import { normalizePath } from 'obsidian';
import type { ColorfulStickyNotesSettings } from './settings';
import type {
	NoteListArchiveFilter,
	NoteListFloatOpenFilter,
	NoteListSort,
	StickyColorId
} from './types';

/** `{manifest.id}-note-list.json`，与其它插件数据文件名区分。 */
function noteListPrefixedPath(plugin: Plugin): string {
	return normalizePath(`${plugin.manifest.dir}/${plugin.manifest.id}-note-list.json`);
}

function noteListLegacyPath(plugin: Plugin): string {
	return normalizePath(`${plugin.manifest.dir}/note-list.json`);
}

/** 将旧的 `note-list.json` 复制为新文件名并删除旧文件（仅当新文件尚不存在时）。 */
async function migrateLegacyNoteListFile(plugin: Plugin): Promise<void> {
	const next = noteListPrefixedPath(plugin);
	const prev = noteListLegacyPath(plugin);
	if (await plugin.app.vault.adapter.exists(next)) return;
	if (!(await plugin.app.vault.adapter.exists(prev))) return;
	try {
		const rawText = await plugin.app.vault.adapter.read(prev);
		await plugin.app.vault.adapter.write(next, rawText);
		await plugin.app.vault.adapter.remove(prev);
	} catch {
		/* 迁移失败则保留旧文件，下次加载再试 */
	}
}

const VALID_SORT: readonly NoteListSort[] = [
	'ctime-desc',
	'ctime-asc',
	'mtime-desc',
	'mtime-asc',
	'basename-asc',
	'basename-desc'
];

const VALID_FLOAT: readonly NoteListFloatOpenFilter[] = ['all', 'open', 'closed'];

const VALID_ARCHIVE: readonly NoteListArchiveFilter[] = ['all', 'unarchived', 'archived'];

const VALID_COLORS: readonly StickyColorId[] = [
	'default',
	'yellow',
	'pink',
	'mint',
	'blue',
	'lavender',
	'gray'
];

/** 写入 `data.json` 时需剔除的键（便笺列表状态改存 `note-list.json`）。 */
export const NOTE_LIST_DATA_JSON_KEYS = [
	'noteListPinnedPaths',
	'noteListSort',
	'noteListColorFilters',
	'noteListFloatOpenFilter',
	'noteListArchiveFilter'
] as const;

export type NoteListDataJsonKey = (typeof NOTE_LIST_DATA_JSON_KEYS)[number];

/** 磁盘上的便笺列表状态（与设置里的字段名一致，便于读写）。 */
export interface NoteListPersistedFile {
	version: 1;
	noteListPinnedPaths: string[];
	noteListSort: NoteListSort;
	noteListColorFilters: StickyColorId[];
	noteListFloatOpenFilter: NoteListFloatOpenFilter;
	noteListArchiveFilter: NoteListArchiveFilter;
}

export function normalizeNoteListPinnedPathsStorage(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of value) {
		if (typeof x !== 'string' || !x.trim()) continue;
		const p = normalizePath(x);
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

export function normalizeNoteListColorFilters(value: unknown): StickyColorId[] {
	if (!Array.isArray(value)) return [];
	const out: StickyColorId[] = [];
	const seen = new Set<string>();
	for (const x of value) {
		if (typeof x !== 'string' || !VALID_COLORS.includes(x as StickyColorId)) continue;
		if (seen.has(x)) continue;
		seen.add(x);
		out.push(x as StickyColorId);
	}
	return out;
}

export function samePinnedPathsOrder(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (normalizePath(a[i]!) !== normalizePath(b[i]!)) return false;
	}
	return true;
}

export function pruneNoteListPinnedPathsAfterDelete(
	pinned: readonly string[],
	deletedPath: string,
	isFolder: boolean
): string[] {
	const del = normalizePath(deletedPath);
	const prefix = `${del}/`;
	const kept = pinned.filter(p => {
		const n = normalizePath(p);
		if (n === del) return false;
		if (isFolder && n.startsWith(prefix)) return false;
		return true;
	});
	return normalizeNoteListPinnedPathsStorage(kept);
}

export function extractNoteListPersisted(settings: ColorfulStickyNotesSettings): NoteListPersistedFile {
	return {
		version: 1,
		noteListPinnedPaths: normalizeNoteListPinnedPathsStorage(settings.noteListPinnedPaths),
		noteListSort: settings.noteListSort,
		noteListColorFilters: normalizeNoteListColorFilters(settings.noteListColorFilters),
		noteListFloatOpenFilter: settings.noteListFloatOpenFilter,
		noteListArchiveFilter: settings.noteListArchiveFilter
	};
}

export function applyNoteListPersisted(
	settings: ColorfulStickyNotesSettings,
	data: NoteListPersistedFile
): void {
	const normalized = normalizeNoteListFile(data);
	settings.noteListPinnedPaths = normalized.noteListPinnedPaths;
	settings.noteListSort = normalized.noteListSort;
	settings.noteListColorFilters = normalized.noteListColorFilters;
	settings.noteListFloatOpenFilter = normalized.noteListFloatOpenFilter;
	settings.noteListArchiveFilter = normalized.noteListArchiveFilter;
}

function normalizeNoteListFile(raw: Partial<NoteListPersistedFile>): NoteListPersistedFile {
	let sort = raw.noteListSort;
	if (typeof sort !== 'string' || !VALID_SORT.includes(sort as NoteListSort)) {
		sort = 'ctime-desc';
	}
	let floatOpen = raw.noteListFloatOpenFilter;
	if (typeof floatOpen !== 'string' || !VALID_FLOAT.includes(floatOpen as NoteListFloatOpenFilter)) {
		floatOpen = 'all';
	}
	let archive = raw.noteListArchiveFilter;
	if (typeof archive !== 'string' || !VALID_ARCHIVE.includes(archive as NoteListArchiveFilter)) {
		archive = 'all';
	}
	return {
		version: 1,
		noteListPinnedPaths: normalizeNoteListPinnedPathsStorage(raw.noteListPinnedPaths),
		noteListSort: sort as NoteListSort,
		noteListColorFilters: normalizeNoteListColorFilters(raw.noteListColorFilters),
		noteListFloatOpenFilter: floatOpen as NoteListFloatOpenFilter,
		noteListArchiveFilter: archive as NoteListArchiveFilter
	};
}

export async function loadNoteListPersistedFile(plugin: Plugin): Promise<NoteListPersistedFile | null> {
	await migrateLegacyNoteListFile(plugin);
	const path = noteListPrefixedPath(plugin);
	const exists = await plugin.app.vault.adapter.exists(path);
	if (!exists) return null;
	try {
		const rawText = await plugin.app.vault.adapter.read(path);
		const parsed = JSON.parse(rawText) as Partial<NoteListPersistedFile>;
		if (!parsed || typeof parsed !== 'object') return null;
		return normalizeNoteListFile(parsed);
	} catch {
		return null;
	}
}

export async function saveNoteListPersistedFile(
	plugin: Plugin,
	data: NoteListPersistedFile
): Promise<void> {
	await migrateLegacyNoteListFile(plugin);
	const path = noteListPrefixedPath(plugin);
	const normalized = normalizeNoteListFile(data);
	await plugin.app.vault.adapter.write(path, JSON.stringify(normalized, null, 2));
}

export function rawPluginDataHasNoteListKeys(raw: Record<string, unknown>): boolean {
	return NOTE_LIST_DATA_JSON_KEYS.some(k => Object.prototype.hasOwnProperty.call(raw, k));
}
