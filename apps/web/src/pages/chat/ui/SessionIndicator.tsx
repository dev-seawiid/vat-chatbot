type SessionIndicatorProps = {
  label: string;
};

export function SessionIndicator({ label }: SessionIndicatorProps) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="block h-[8px] w-[8px] animate-pulse-yellow bg-yellow"
      />
      <span
        className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-soft"
        aria-live="polite"
        aria-atomic="true"
      >
        SESSION · <span className="text-fg">{label}</span>
      </span>
    </div>
  );
}
