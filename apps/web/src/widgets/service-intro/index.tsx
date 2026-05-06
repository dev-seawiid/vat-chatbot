"use client";

import Link from "next/link";

import { cn } from "@/shared/lib/utils";
import { AuroraText } from "@/shared/ui/aurora-text";
import { DotPattern } from "@/shared/ui/dot-pattern";
import { TextAnimate } from "@/shared/ui/text-animate";

const HERO_DELAY_MS = 80;
const SUB_DELAY_MS = 320;
const CTA_DELAY_MS = 460;

const AURORA_COLORS = ["#ffe600", "#fff7b0", "#ffe600"] as const;

/**
 * 다크 + 옐로우 톤의 미니멀 홈.
 * Hero 헤드라인 + 짧은 서브 + chat 진입 CTA. 향후 콘텐츠 개편 전 단계라 톤만.
 */
export function ServiceIntro() {
  return (
    <main className="relative w-full">
      <HeroSection />
      <Footer />
    </main>
  );
}

function HeroSection() {
  return (
    <section className="relative isolate overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <DotPattern
          width={28}
          height={28}
          cr={1}
          glow
          className="text-yellow/[0.14] mask-fade-edges"
        />
        <div className="absolute inset-0 bg-aurora-yellow" />
      </div>

      <div className="mx-auto flex min-h-[78vh] w-full max-w-[1100px] flex-col justify-center px-6 pt-16 pb-20 sm:pt-20">
        <div
          className="stagger-enter mb-8 flex items-center gap-3"
          style={{ animationDelay: `${HERO_DELAY_MS}ms` }}
        >
          <span
            aria-hidden
            className="animate-pulse-yellow inline-block h-[7px] w-[7px] rounded-full bg-yellow"
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-muted">
            VAT RAG CHATBOT · TOY
          </span>
        </div>

        <h1
          className="stagger-enter relative max-w-[18ch] font-sans font-medium leading-[1.0] tracking-[-0.025em] text-fg"
          style={{
            animationDelay: `${HERO_DELAY_MS + 80}ms`,
            fontSize: "clamp(36px, 5.5vw, 68px)",
          }}
        >
          부가가치세,
          <br />
          근거가 있는{" "}
          <AuroraText colors={[...AURORA_COLORS]} speed={0.9}>
            Answer
          </AuroraText>
          <span className="text-yellow">.</span>
        </h1>

        <div
          className="stagger-enter mt-6 max-w-[58ch]"
          style={{ animationDelay: `${SUB_DELAY_MS}ms` }}
        >
          <TextAnimate
            as="p"
            animation="blurInUp"
            by="word"
            once
            duration={0.4}
            className="text-[14.5px] leading-[1.65] text-fg-soft"
          >
            국세청 공식 자료를 검색해 답변과 함께 인용 [n]을 표시합니다. 근거가
            확인되지 않으면 답하지 않습니다.
          </TextAnimate>
        </div>

        <div
          className="stagger-enter mt-9 flex flex-wrap items-center gap-4"
          style={{ animationDelay: `${CTA_DELAY_MS}ms` }}
        >
          <Link
            href="/chat"
            className={cn(
              "group inline-flex items-center gap-2",
              "h-12 rounded-sm bg-yellow px-8 text-bg",
              "font-mono text-[12px] font-semibold uppercase tracking-[0.22em]",
              "shadow-[0_0_0_1px_var(--yellow),0_8px_24px_-8px_rgb(255_230_0/0.45)]",
              "transition-[transform,box-shadow] duration-200 ease-out",
              "hover:-translate-y-[1px] hover:shadow-[0_0_0_1px_var(--yellow),0_0_0_4px_rgb(255_230_0/0.18),0_12px_32px_-6px_rgb(255_230_0/0.55)]",
              "active:translate-y-0 active:scale-[0.98]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            )}
          >
            <span>질문하기</span>
            <span
              aria-hidden
              className="inline-block transition-transform duration-200 group-hover:translate-x-1"
            >
              →
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-2 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.20em] text-fg-muted">
          DISCLAIMER · 학습용 토이입니다. 실제 신고 의사결정은 세무 전문가 검토
          필요.
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.20em] text-fg-muted">
          © dev-seawiid · 2026
        </p>
      </div>
    </footer>
  );
}
