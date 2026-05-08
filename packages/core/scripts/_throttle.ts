export const THROTTLE_MS = 21000;

export function withThrottle<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  minIntervalMs: number,
): (...args: A) => Promise<R> {
  let last = 0;
  return async (...args) => {
    const wait = Math.max(0, minIntervalMs - (Date.now() - last));
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    last = Date.now();
    return fn(...args);
  };
}
