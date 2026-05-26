import { tool } from "@langchain/core/tools";
import { z } from "zod";

// answer agent용 — 답 본문에 박는 숫자를 만드는 계산 도구만. chunk 검색 도구는 격리.
// 검색은 rag-graph의 결정론적 노드(search_direct·claim_searches)가 직접 retrieve+rerank 호출.

const DateAddInput = z.object({
  base_date: z
    .string()
    .describe("기준 날짜. ISO 8601 형식 YYYY-MM-DD. 예: '2025-12-31'."),
  days: z
    .number()
    .int()
    .describe("기준 날짜에 더할 일수. 음수도 허용. 예: 25, -10."),
});

const VatCalcInput = z.object({
  taxable_amount: z.number().describe("공급가액(원)."),
  rate: z
    .number()
    .min(0)
    .max(1)
    .describe("세율. 일반과세 0.1, 영세율 0, 간이과세는 업종별 부가율 적용 후 0.1."),
});

export function createAnswerTools() {
  // date_after: 조문이 "끝난 후 25일 이내" 같이 상대 표현일 때 절대 날짜로 환산.
  // 도구가 계산을 deterministic하게 처리 → 모델 산수 환각 차단. UTC 기반.
  const dateAfter = tool(
    async (input: { base_date: string; days: number }) => {
      const base = new Date(`${input.base_date}T00:00:00Z`);
      if (Number.isNaN(base.getTime())) {
        return `error: base_date 형식 오류. ISO 8601 YYYY-MM-DD 필요. 받은 값: ${input.base_date}`;
      }
      const result = new Date(base.getTime() + input.days * 86400000);
      return result.toISOString().slice(0, 10);
    },
    {
      name: "date_after",
      description:
        "기준 날짜에 일수를 더해 절대 날짜를 반환. 법령 텍스트가 '과세기간이 끝난 후 25일 이내' 같이 상대 표현일 때 사용자가 묻는 구체 연도에 맞춰 변환 (예: base_date='2025-12-31' + days=25 → '2026-01-25'). 답변에 절대 날짜가 필요할 때만 호출.",
      schema: DateAddInput,
    },
  );

  // vat_calc: 부가세액 = 공급가액 × 세율. 산수 도구로 분리해 모델이 자체 계산해서 틀리는 사고 차단.
  const vatCalc = tool(
    async (input: { taxable_amount: number; rate: number }) => {
      const vat = Math.round(input.taxable_amount * input.rate);
      return JSON.stringify({
        taxable_amount: input.taxable_amount,
        rate: input.rate,
        vat,
        total: input.taxable_amount + vat,
      });
    },
    {
      name: "vat_calc",
      description:
        "공급가액과 세율로 부가세액을 계산. 답변에 부가세액 숫자가 필요하면 본 도구를 사용. 직접 산수 금지.",
      schema: VatCalcInput,
    },
  );

  return [dateAfter, vatCalc];
}
