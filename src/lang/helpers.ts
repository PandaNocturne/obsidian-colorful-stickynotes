import { en, type MessageKey } from './locale/en';
import { zhCn } from './locale/zh-cn';

const localePacks: Record<string, Partial<Record<MessageKey, string>>> = {
	en,
	'zh-cn': zhCn
};

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
	return localePacks[resolveLocaleId(getMomentLocaleCode())] ?? en;
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
