const STORAGE_KEY = "vat:cid";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function newId(): string {
  return crypto.randomUUID();
}

export function getOrCreateId(): string {
  if (!isBrowser()) return newId();
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const created = newId();
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}

export function reset(): string {
  const created = newId();
  if (isBrowser()) window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}
