import { ApiError, NetworkError } from "./errors";

// 프로젝트 전역 fetch 단일 지점. 호출처가 fetch를 직접 쓰지 않도록 강제하여 에러 분류와
// content-type 처리를 한 곳에 모은다. zod 응답 검증(parse)은 호출 fetcher 측 책임.

type SearchParams = Record<string, string | number | boolean | undefined | null>;

type GetOptions = {
  searchParams?: SearchParams;
  signal?: AbortSignal;
};

type PostOptions = {
  json?: unknown;
  signal?: AbortSignal;
};

async function request(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    throw new NetworkError(cause);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body);
  }

  // 204/빈 본문은 null로 정규화 — 호출 fetcher 시그니처에서 void로 다룰 수 있다.
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildUrl(url: string, searchParams?: SearchParams): string {
  if (!searchParams) return url;
  const entries = Object.entries(searchParams).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return url;
  const qs = new URLSearchParams(
    entries.map(([k, v]) => [k, String(v)]),
  ).toString();
  return `${url}?${qs}`;
}

export const http = {
  get(url: string, options: GetOptions = {}): Promise<unknown> {
    return request(buildUrl(url, options.searchParams), {
      method: "GET",
      signal: options.signal,
    });
  },
  post(url: string, options: PostOptions = {}): Promise<unknown> {
    const hasBody = options.json !== undefined;
    return request(url, {
      method: "POST",
      headers: hasBody ? { "content-type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(options.json) : undefined,
      signal: options.signal,
    });
  },
};
