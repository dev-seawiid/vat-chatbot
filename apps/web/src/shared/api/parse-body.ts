import "server-only";

import type { ZodType } from "zod";

// route handler의 입력 파싱은 두 단계: req.json 자체가 깨질 수 있고, 형태가 schema와 어긋
// 날 수 있다. 둘 다 동일하게 400으로 떨어지지만 메시지를 구분해 디버깅 단서를 남긴다.
// 결과는 discriminated union — 호출처가 `if (!parsed.ok) return parsed.response`로 narrow.

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: badRequest("invalid json") };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: badRequest("invalid request body") };
  }
  return { ok: true, data: parsed.data };
}

export function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}
