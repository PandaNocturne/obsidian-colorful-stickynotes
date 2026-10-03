/** 有限并发执行，结果顺序与输入一致。 */
export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (items.length === 0) return [];
	const results = new Array<R>(items.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await fn(items[i]!, i);
		}
	};
	const n = Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return results;
}
