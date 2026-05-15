import { tool } from "ai";
import { z } from "zod";

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
    const vat = Math.round(taxable_amount * rate);
    return {
      taxable_amount,
      rate,
      vat,
      total: taxable_amount + vat,
    };
  },
});

// chat.service가 본 schema로 part.input을 safeParse — tool 정의와 검증이 단일 진실.
export const CiteChunkInputSchema = z.object({
  chunkId: z
    .string()
    .describe(
      "system <context>에 [chunkId=...] 라벨로 표기된 chunk 식별자. 그대로 복사.",
    ),
  quote: z
    .string()
    .min(20)
    .max(160)
    .describe(
      "해당 chunk 본문에서 그대로 발췌한 30~120자 문장. 발췌가 chunk 본문에 substring으로 존재해야 검증 통과.",
    ),
});

export type CiteChunkInput = z.infer<typeof CiteChunkInputSchema>;

// 인용 선언 채널 — execute는 ack만, (chunkId, quote) 자체가 페이로드.
// chat.service가 fullStream에서 가로채 quote substring 검증 후 citationStream으로 emit.
export const citeChunk = tool({
  description:
    "답변 도중 retrieved chunk를 인용할 때마다 호출한다. 본문 텍스트에는 [n] 같은 마커를 절대 박지 말 것 — 인용 선언은 오직 본 tool로만 한다. 새 주장을 할 때마다 즉시 호출(끝에 몰아쓰기 금지).",
  inputSchema: CiteChunkInputSchema,
  execute: async () => ({ ok: true }),
});

export const tools = {
  lookup_law_article: lookupLawArticle,
  calc_vat: calcVat,
  cite_chunk: citeChunk,
};
