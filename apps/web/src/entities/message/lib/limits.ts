// 단일 user query 길이 상한 — 1회 LLM 호출 input 토큰 비용 cap. 클라 입력 한도(컴포저
// maxLength)와 서버 validation 양쪽이 동일 값을 참조해야 UX/보안 정합성이 깨지지 않는다.
export const MAX_MESSAGE_LENGTH = 1000;
