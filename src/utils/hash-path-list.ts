/**
 * 对有序路径列表做轻量指纹（长度 + FNV-1a），避免结构 key 里 JSON.stringify 全路径数组。
 * 同步、无分配大字符串；碰撞概率对「是否同一结果集」判断足够低。
 */
export function hashPathList(paths: readonly string[]): string {
	let h = 2166136261;
	for (let i = 0; i < paths.length; i++) {
		const p = paths[i]!;
		for (let j = 0; j < p.length; j++) {
			h ^= p.charCodeAt(j);
			h = Math.imul(h, 16777619);
		}
		/* 分隔，避免 "ab"+"c" 与 "a"+"bc" 混淆 */
		h ^= 0x1f;
		h = Math.imul(h, 16777619);
	}
	return `${paths.length}:${(h >>> 0).toString(36)}`;
}
