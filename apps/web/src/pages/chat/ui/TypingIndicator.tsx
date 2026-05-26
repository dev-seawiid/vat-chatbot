export function TypingIndicator() {
  return (
    <div
      role="status"
      aria-label="응답 작성 중"
      className="blur-in border-l-2 border-white/10 py-1 pl-5"
    >
      <header className="mb-2">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-fg-soft">
          AI · ASSISTANT
        </span>
      </header>
      <div className="flex h-[1.7em] items-center gap-[6px]" aria-hidden>
        <Dot delay="0ms" />
        <Dot delay="180ms" />
        <Dot delay="360ms" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="block h-[6px] w-[6px] animate-typing-dot bg-yellow/70"
      style={{ animationDelay: delay }}
    />
  );
}
