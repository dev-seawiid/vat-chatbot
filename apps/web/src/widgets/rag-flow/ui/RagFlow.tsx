"use client";

import { forwardRef, useRef } from "react";

import { cn } from "@/shared/lib/utils";
import { AnimatedBeam } from "@/shared/ui/animated-beam";

const BEAM_BASE = {
  duration: 4,
  pathColor: "rgba(255,255,255,0.06)",
  gradientStartColor: "#ffe600",
  gradientStopColor: "#fff7b0",
} as const;

export function RagFlow() {
  const containerRef = useRef<HTMLDivElement>(null);
  const src1Ref = useRef<HTMLDivElement>(null);
  const src2Ref = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const ans1Ref = useRef<HTMLDivElement>(null);
  const ans2Ref = useRef<HTMLDivElement>(null);
  const ans3Ref = useRef<HTMLDivElement>(null);
  const ans4Ref = useRef<HTMLDivElement>(null);

  return (
    <section className="relative isolate w-full overflow-hidden border-t border-white/[0.06] py-24 sm:py-28">
      <div className="mx-auto w-full max-w-[1100px] px-6">
        <header className="mb-12 sm:mb-14">
          <div className="mb-3 flex items-center gap-2">
            <span aria-hidden className="h-px w-6 bg-yellow/60" />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-muted">
              How it works
            </span>
          </div>
          <h2 className="font-sans text-[clamp(22px,3vw,32px)] font-medium leading-[1.15] tracking-[-0.02em] text-fg">
            Source → RAG → Ground Truth.
            <br />
            <span className="text-fg-soft">사용된 데이터 출처.</span>
          </h2>
        </header>

        <div
          ref={containerRef}
          className="relative isolate grid grid-cols-1 items-center gap-y-10 md:grid-cols-[1fr_auto_1fr] md:gap-x-16 lg:gap-x-24"
        >
          <div className="relative z-10 flex flex-col items-center gap-4 md:items-start">
            <ColumnLabel>Sources</ColumnLabel>
            <div className="flex w-full max-w-[280px] flex-col gap-6 md:gap-10">
              <div className="w-[78%] self-start md:w-full">
                <SourceCard
                  ref={src1Ref}
                  title="부가가치세법"
                  sub="법률 · 시행령 · 시행규칙"
                  codes={["법률 21065 · 시행령 36133", "시행규칙 09호"]}
                  date="최신 시행 2026.04.01"
                />
              </div>
              <div className="w-[78%] self-end md:w-full md:self-start">
                <SourceCard
                  ref={src2Ref}
                  title="국세기본법"
                  sub="법률 · 시행령 · 시행규칙"
                  codes={["법률 21212 · 시행령 36125", "시행규칙 18호"]}
                  date="최신 시행 2026.03.20"
                />
              </div>
            </div>
          </div>

          <div className="relative z-10 flex justify-center">
            <CoreNode ref={coreRef} />
          </div>

          <div className="relative z-10 flex flex-col items-center gap-4 md:items-end">
            <ColumnLabel className="md:self-end">Ground Truth</ColumnLabel>
            <div className="flex w-full max-w-[300px] flex-col gap-4 md:gap-6">
              <div className="w-[74%] self-start md:w-full md:self-end">
                <AnswerCard
                  ref={ans1Ref}
                  kind="pdf"
                  title="25.2기 사례 PDF"
                  sub="간이과세자 / 일반과세자"
                />
              </div>
              <div className="w-[74%] self-end md:w-full md:self-end">
                <AnswerCard
                  ref={ans2Ref}
                  kind="pdf"
                  title="25.2기 신고안내 매뉴얼"
                  sub="PDF"
                />
              </div>
              <div className="w-[74%] self-start md:w-full md:self-end">
                <AnswerCard
                  ref={ans3Ref}
                  kind="web"
                  title="국세청 콜센터 Q&A"
                  sub="call.nts.go.kr"
                />
              </div>
              <div className="w-[74%] self-end md:w-full md:self-end">
                <AnswerCard
                  ref={ans4Ref}
                  kind="web"
                  title="국세청 홈페이지 자료"
                  sub="nts.go.kr"
                />
              </div>
            </div>
          </div>

          <AnimatedBeam
            {...BEAM_BASE}
            className="z-0"
            containerRef={containerRef}
            fromRef={src1Ref}
            toRef={coreRef}
            curvature={-75}
            delay={0}
          />
          <AnimatedBeam
            {...BEAM_BASE}
            className="z-0"
            containerRef={containerRef}
            fromRef={src2Ref}
            toRef={coreRef}
            curvature={75}
            delay={0.4}
          />
          <AnimatedBeam
            {...BEAM_BASE}
            className="z-0"
            containerRef={containerRef}
            fromRef={coreRef}
            toRef={ans1Ref}
            curvature={-90}
            delay={1.0}
          />
          <AnimatedBeam
            {...BEAM_BASE}
            className="z-0"
            containerRef={containerRef}
            fromRef={coreRef}
            toRef={ans2Ref}
            curvature={-30}
            delay={1.25}
          />
          <AnimatedBeam
            {...BEAM_BASE}
            className="z-0"
            containerRef={containerRef}
            fromRef={coreRef}
            toRef={ans3Ref}
            curvature={30}
            delay={1.5}
          />
          <AnimatedBeam
            {...BEAM_BASE}
            className="z-0"
            containerRef={containerRef}
            fromRef={coreRef}
            toRef={ans4Ref}
            curvature={90}
            delay={1.75}
          />
        </div>
      </div>
    </section>
  );
}

function ColumnLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] uppercase tracking-[0.22em] text-fg-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

const SourceCard = forwardRef<
  HTMLDivElement,
  { title: string; sub: string; codes: readonly string[]; date: string }
>(function SourceCard({ title, sub, codes, date }, ref) {
  return (
    <div
      ref={ref}
      className="group relative z-10 flex w-full items-start gap-3 rounded-sm border border-white/10 bg-bg-2 p-4 backdrop-blur-sm transition-colors duration-200 hover:border-yellow/40"
    >
      <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xs border border-white/10 bg-bg font-mono text-[9px] tracking-wider text-yellow">
        PDF
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-muted">
          {sub}
        </div>
        <div className="mt-1.5 hidden space-y-0.5 font-mono text-[9px] leading-[1.45] tracking-[0.06em] text-fg-muted/75 md:block">
          {codes.map((line) => (
            <div key={line}>{line}</div>
          ))}
          <div>{date}</div>
        </div>
      </div>
    </div>
  );
});

const AnswerCard = forwardRef<
  HTMLDivElement,
  { kind: "pdf" | "web"; title: string; sub: string }
>(function AnswerCard({ kind, title, sub }, ref) {
  return (
    <div
      ref={ref}
      className="group relative z-10 flex w-full items-start gap-3 rounded-sm border border-white/10 bg-bg-2 p-4 transition-colors duration-200 hover:border-yellow/40"
    >
      <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xs border border-white/10 bg-bg font-mono text-[9px] tracking-wider text-yellow">
        {kind === "pdf" ? "PDF" : "WEB"}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-muted">
          {sub}
        </div>
      </div>
    </div>
  );
});

const CoreNode = forwardRef<HTMLDivElement>(function CoreNode(_, ref) {
  return (
    <div className="relative z-10">
      <span
        aria-hidden
        className="absolute inset-[-18px] rounded-full bg-yellow/10 blur-2xl"
      />
      <span
        aria-hidden
        className="absolute inset-[-6px] rounded-full border border-dashed border-yellow/40 [animation:spin_10s_linear_infinite]"
      />
      <div
        ref={ref}
        className="relative flex h-20 w-20 items-center justify-center rounded-full border border-yellow/60 bg-bg shadow-[0_0_0_1px_var(--yellow),0_0_28px_-4px_var(--yellow-glow)]"
      >
        <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.2em] text-yellow">
          RAG
        </span>
      </div>
    </div>
  );
});
