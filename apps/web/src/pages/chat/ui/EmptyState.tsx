"use client";

import { ExamplePromptList } from "@/features/send-message";
import { AuroraText } from "@/shared/ui/aurora-text";
import { TextAnimate } from "@/shared/ui/text-animate";

// data/eval/golden.json 토픽 4건(기초·매입·영세-면세·가산세)을 chips용 캐주얼체로 다듬음.
const EXAMPLE_PROMPTS = [
  "간이과세자는 부가세를 몇 번 신고하나요?",
  "신용카드 결제도 매입세액 공제 되나요?",
  "면세와 영세율, 매입세액에서 뭐가 달라요?",
  "부가세 무신고 가산세는 얼마예요?",
] as const;

const STAGGER_DELAY = "120ms";
const AURORA_COLORS = ["#ffe600", "#fff7b0", "#ffe600"];

type EmptyStateProps = {
  onSelectPrompt: (text: string) => void;
};

export function EmptyState({ onSelectPrompt }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-10 pt-10">
      <div
        className="stagger-enter w-full"
        style={{ animationDelay: STAGGER_DELAY }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-soft">
          QUICK START
        </span>
        <h2 className="mt-3 max-w-[20ch] text-[clamp(26px,3.5vw,40px)] font-medium leading-[1.1] tracking-[-0.02em] text-fg">
          무엇이{" "}
          <AuroraText colors={AURORA_COLORS} speed={0.9}>
            궁금
          </AuroraText>
          하신가요
          <span className="text-yellow">?</span>
        </h2>
        <TextAnimate
          as="p"
          animation="blurInUp"
          by="word"
          delay={0.25}
          className="mt-3 max-w-[44ch] text-[13.5px] leading-[1.6] text-fg-soft"
        >
          국세청 공식 자료를 검색해 답변과 함께 인용 [n]을 표시합니다. 아래
          예시를 누르거나 직접 질문을 입력해 보세요.
        </TextAnimate>
      </div>

      <ExamplePromptList prompts={EXAMPLE_PROMPTS} onSelect={onSelectPrompt} />
    </div>
  );
}
