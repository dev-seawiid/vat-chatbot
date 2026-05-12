"use client";

import { useEffect, useState } from "react";

/**
 * 미디어 쿼리 훅. 클라이언트에서 마운트되는 컴포넌트(overlay 등)에서 첫 페인트
 * 플래시를 피하기 위해 lazy initializer로 초기값을 동기 계산한다.
 * SSR 렌더 컴포넌트에서 쓸 경우 서버 false ↔ 클라 true mismatch 가능.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
