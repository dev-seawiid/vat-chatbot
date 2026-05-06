import Link from "next/link";

import { Button } from "@/shared/ui/button";

const NAV_LINKS = [{ href: "/", label: "홈" }] as const;

/**
 * 다크 터미널 톤 사이트 헤더.
 * 좌: 옐로우 [VAT] 모노그램 + 펄스 도트 + 워드마크.
 * 우: mono caps nav + ASK CTA (옐로우 풀필, 화살표 nudge).
 * sticky + glass-strong + 헤어라인 + fade-up 진입.
 */
export function SiteHeader() {
  return (
    <header className="animate-fade-up sticky top-0 z-40 border-b border-white/10 glass-strong">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
        <Link
          href="/"
          className="group flex min-w-0 items-center gap-2.5 sm:gap-3"
        >
          <span
            aria-hidden
            className="relative flex h-8 w-8 shrink-0 items-center justify-center bg-yellow font-mono text-[11px] font-semibold uppercase tracking-[0.10em] text-bg transition-transform duration-300 ease-out group-hover:rotate-[-4deg] sm:h-9 sm:w-9"
          >
            VAT
          </span>
          <span
            aria-hidden
            className="animate-pulse-yellow hidden h-[6px] w-[6px] shrink-0 rounded-full bg-yellow sm:inline-block"
          />
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-fg sm:text-[14px]">
              <span className="sm:hidden">VAT RAG</span>
              <span className="hidden sm:inline">
                부가세 신고 가이드 RAG 챗봇
              </span>
            </span>
            <span className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.2em] text-fg-muted sm:text-[10px] sm:tracking-[0.22em]">
              VAT RAG CHATBOT · TOY
            </span>
          </span>
        </Link>

        <nav className="flex shrink-0 items-center gap-4 sm:gap-7">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hidden font-mono text-[11px] font-medium uppercase tracking-[0.20em] text-fg-soft transition-colors hover:text-fg sm:inline-block"
            >
              {link.label}
            </Link>
          ))}
          <Button asChild size="sm" variant="primary">
            <Link href="/chat" className="group">
              <span>질문하기</span>
              <span
                aria-hidden
                className="ml-1 inline-block translate-x-0 transition-transform duration-200 group-hover:translate-x-1"
              >
                →
              </span>
            </Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
