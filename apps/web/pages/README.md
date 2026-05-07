# pages (intentionally empty)

이 폴더는 의도적으로 비워둔다. App Router(`/app`)를 단일 라우터로 사용하지만,
FSD 가이드(https://feature-sliced.design/docs/guides/tech/with-nextjs)는 Next.js의
fallback 동작과 src 내부 FSD `pages` 레이어 충돌 회피를 위해 루트 `pages/`를 빈 채로
유지할 것을 권장한다. 절대 `pages/_app.tsx` 등 라우팅 파일을 추가하지 말 것.
