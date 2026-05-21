export const THROTTLE_MS = 21000;

export function withThrottle<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  minIntervalMs: number,
): (...args: A) => Promise<R> {
  let last = 0;
  return async (...args) => {
    const wait = Math.max(0, minIntervalMs - (Date.now() - last));
    if (wait > 0) {
      // 긴 대기를 가시화 — 콘솔 침묵을 "멈춤"으로 오인하지 않게.
      console.log(`  throttle: waiting ${(wait / 1000).toFixed(1)}s...`);
      await new Promise<void>((r) => setTimeout(r, wait));
    }
    last = Date.now();
    return fn(...args);
  };
}
