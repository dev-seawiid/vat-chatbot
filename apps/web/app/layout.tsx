import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { OverlayProvider } from "overlay-kit";

import { Toaster } from "@/shared/ui/sonner";
import { SiteHeader } from "@/widgets/site-header";

// Pretendard Variable — 한글+라틴 본문, dynamic subset (한글 사용량만 로드)
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";

// Display — Instrument Serif italic. 라틴 강조어("대답", "ASK") 전용.
const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
});

// Mono — JetBrains Mono. 라벨/메타/카운터/CTA caps.
const jet = JetBrains_Mono({
  variable: "--font-jet",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "부가세 신고 가이드 RAG 챗봇",
  description: "국세청 공식 자료 기반 RAG 챗봇 (학습용 토이)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`dark ${instrument.variable} ${jet.variable} h-full antialiased`}
    >
      <body className="relative flex min-h-full flex-col bg-bg text-fg">
        <OverlayProvider>
          <SiteHeader />
          {children}
          <Toaster />
        </OverlayProvider>
      </body>
    </html>
  );
}
