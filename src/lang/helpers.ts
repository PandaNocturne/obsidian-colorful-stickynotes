import { en, type MessageKey } from './locale/en';
import { zhCn } from './locale/zh-cn';

/** 插件界面语言：跟随 Obsidian，或手动指定。 */
export type PluginUiLanguage = 'auto' | 'en' | 'zh-cn';

export const VALID_PLUGIN_UI_LANGUAGE: readonly PluginUiLanguage[] = ['auto', 'en', 'zh-cn'];

const localePacks: Record<string, Partial<Record<MessageKey, string>>> = {
	en,
	'zh-cn': zhCn
};

let uiLanguagePref: PluginUiLanguage = 'auto';

export function setPluginUiLanguage(pref: PluginUiLanguage): void {
	uiLanguagePref = VALID_PLUGIN_UI_LANGUAGE.includes(pref) ? pref : 'auto';
}

export function getPluginUiLanguage(): PluginUiLanguage {
	return uiLanguagePref;
}

/** 与 Obsidian 一致：使用全局 `moment.locale()` 判断界面语言。 */
function getMomentLocaleCode(): string {
	try {
		const m = (window as Window & { moment?: { locale?: () => string } }).moment;
		if (m && typeof m.locale === 'function') {
			const raw = m.locale();
			if (typeof raw === 'string' && raw.length > 0) {
				return raw.toLowerCase().replace(/_/g, '-');
			}
		}
	} catch {
		/* ignore */
	}
	return 'en';
}

function resolveLocaleId(raw: string): keyof typeof localePacks {
	if (raw === 'zh-cn' || raw === 'zh-hans' || raw.startsWith('zh-hans')) return 'zh-cn';
	if (raw === 'zh-tw' || raw === 'zh-hant') return 'zh-cn';
	if (raw === 'zh' || raw.startsWith('zh-')) return 'zh-cn';
	const base = raw.split('-')[0] ?? 'en';
	if (base === 'zh') return 'zh-cn';
	if (raw in localePacks) return raw;
	if (base in localePacks) return base;
	return 'en';
}

function activePack(): Partial<Record<MessageKey, string>> {
	const id = uiLanguagePref === 'auto' ? resolveLocaleId(getMomentLocaleCode()) : uiLanguagePref;
	return localePacks[id] ?? en;
}

function applyVars(template: string, vars?: Record<string, string | number>): string {
	if (!vars) return template;
	let s = template;
	for (const [k, v] of Object.entries(vars)) {
		s = s.split(`{${k}}`).join(String(v));
	}
	return s;
}

/**
 * 取当前语言下的文案；缺省回退到英文 `en`。
 * 支持 `{name}` 形式的占位符（第二个参数传入对象）。
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	const pack = activePack();
	const template = pack[key] ?? en[key];
	return applyVars(template, vars);
}

export type { MessageKey };
