import type { Metadata } from "next";

import { fontVariables } from "@/app/config/fonts";
import { AppProviders } from "@/app/providers/AppProviders";
import { SiteHeader } from "@/widgets/site-header";

// Pretendard Variable — 한글+라틴 본문, dynamic subset (한글 사용량만 로드)
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "@/app/styles/global.css";

export const metadata: Metadata = {
  title: "부가가치세 법령 상담 챗봇",
  description: "국세청 공식 자료 기반 부가가치세 법령 상담 챗봇 (학습용 토이)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`dark ${fontVariables} h-full antialiased`}
    >
      <body className="relative flex min-h-full flex-col bg-bg text-fg">
        <AppProviders>
          <SiteHeader />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
