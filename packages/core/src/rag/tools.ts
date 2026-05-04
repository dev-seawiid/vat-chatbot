import { tool } from "ai";
import { z } from "zod";

// spec §3.3 tool 정의 — W3에서는 stub. 실제 구현은:
//  - lookup_law_article: 국가법령정보센터 OpenAPI 어댑터(W3 후반/W4)
//  - calc_vat: decimal.js로 정밀 계산(스펙 명시) — 지금은 native number로 충분
// stub 단계의 목적은 tool-call 라운드트립이 streamText에서 실제로 일어나는지 확인하는 것.

export const lookupLawArticle = tool({
  description:
    "부가가치세법 등 세법 조문 원문을 조회한다. 답변에 법 조문을 인용해야 할 때만 사용한다.",
  inputSchema: z.object({
    article_no: z
      .string()
      .describe("조문 번호. 예: '제15조', '제15조의2', '시행령 제32조'"),
  }),
  execute: async ({ article_no }) => {
    return {
      ok: false,
      error: `lookup_law_article은 아직 stub입니다(요청: ${article_no}). 국가법령정보센터 어댑터 도입 후 동작.`,
    };
  },
});

export const calcVat = tool({
  description:
    "공급가액(taxable_amount)과 세율(rate, 0~1)로 부가세액을 계산한다. 직접 산수 대신 반드시 이 도구를 사용한다.",
  inputSchema: z.object({
    taxable_amount: z.number().describe("공급가액(원)"),
    rate: z
      .number()
      .min(0)
      .max(1)
      .describe("세율. 일반과세 0.1, 영세율 0, 간이과세 업종별 부가율 적용 후 0.1"),
  }),
  execute: async ({ taxable_amount, rate }) => {
    // v2: decimal.js로 교체 — toy 단계에서는 native number로 충분(VAT 10% 곱셈 정밀 손실 무시 가능).
    const vat = Math.round(taxable_amount * rate);
    return {
      taxable_amount,
      rate,
      vat,
      total: taxable_amount + vat,
    };
  },
});

export const tools = {
  lookup_law_article: lookupLawArticle,
  calc_vat: calcVat,
};
