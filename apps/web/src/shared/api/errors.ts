// 3계층 에러 분류 — 호출처가 재시도/UI 처리를 갈라낼 수 있도록 한다.
// 스키마 불일치(ApiResponseValidationError)는 zod 검증 도입(D5) 이후 추가.

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`http ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("network failure");
    this.name = "NetworkError";
    this.cause = cause;
  }
}
