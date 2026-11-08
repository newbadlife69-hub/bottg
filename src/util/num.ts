/** Piecewise-linear interpolation through [x, y] points (x ascending), clamped at the ends. */
export function pl(x: number, pts: [number, number][]): number {
  if (!Number.isFinite(x)) return pts[0][1];
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0 || 1)) * (y1 - y0);
  }
  return pts[pts.length - 1][1];
}

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function usdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `$${v.toFixed(0)}`;
}

export function signedUsd(v: number, digits = 2): string {
  const s = v < 0 ? '−' : '+';
  return `${s}$${Math.abs(v).toFixed(digits)}`;
}
