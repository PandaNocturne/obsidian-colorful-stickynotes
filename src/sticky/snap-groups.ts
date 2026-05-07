import type { FloatingBounds } from '../types';

export const SNAP_THRESHOLD = 14;

export interface SnapPartner {
	id: string;
	bounds: FloatingBounds;
}

/** Returns snapped bounds for `subject` against neighbors (mutates position to align edges). */
export function snapBounds(subject: FloatingBounds, others: SnapPartner[], selfId: string): FloatingBounds {
	let { left, top, width, height } = subject;
	const right = left + width;
	const bottom = top + height;

	for (const o of others) {
		if (o.id === selfId) continue;
		const b = o.bounds;
		const br = b.left + b.width;
		const bb = b.top + b.height;

		// Vertical adjacency: align left edge to neighbor's right
		if (Math.abs(left - br) <= SNAP_THRESHOLD && verticalOverlapRatio(top, height, b.top, b.height) > 0.25) {
			left = br;
		}
		// Right edge to neighbor's left
		if (Math.abs(right - b.left) <= SNAP_THRESHOLD && verticalOverlapRatio(top, height, b.top, b.height) > 0.25) {
			left = b.left - width;
		}
		// Horizontal adjacency: top to bottom
		if (Math.abs(top - bb) <= SNAP_THRESHOLD && horizontalOverlapRatio(left, width, b.left, b.width) > 0.25) {
			top = bb;
		}
		if (Math.abs(bottom - b.top) <= SNAP_THRESHOLD && horizontalOverlapRatio(left, width, b.left, b.width) > 0.25) {
			top = b.top - height;
		}
	}

	return { left, top, width, height };
}

function verticalOverlapRatio(aTop: number, aH: number, bTop: number, bH: number): number {
	const a1 = aTop;
	const a2 = aTop + aH;
	const b1 = bTop;
	const b2 = bTop + bH;
	const hi = Math.min(a2, b2) - Math.max(a1, b1);
	if (hi <= 0) return 0;
	return hi / Math.min(aH, bH);
}

function horizontalOverlapRatio(aLeft: number, aW: number, bLeft: number, bW: number): number {
	const a1 = aLeft;
	const a2 = aLeft + aW;
	const b1 = bLeft;
	const b2 = bLeft + bW;
	const hi = Math.min(a2, b2) - Math.max(a1, b1);
	if (hi <= 0) return 0;
	return hi / Math.min(aW, bW);
}

/** When two rects are snapped on a vertical seam, return suggested shared width. */
export function matchWidthsIfVerticalPair(a: FloatingBounds, b: FloatingBounds): { a: number; b: number } {
	const ar = a.left + a.width;
	const seamA = Math.abs(ar - b.left) <= SNAP_THRESHOLD || Math.abs(a.left - (b.left + b.width)) <= SNAP_THRESHOLD;
	if (seamA && verticalOverlapRatio(a.top, a.height, b.top, b.height) > 0.2) {
		const w = Math.max(a.width, b.width);
		return { a: w, b: w };
	}
	return { a: a.width, b: b.width };
}
