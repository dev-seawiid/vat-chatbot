import {
  startActiveObservation,
  updateActiveObservation,
  type LangfuseGenerationAttributes,
  type LangfuseSpanAttributes,
} from "@langfuse/tracing";

// core 유일의 @langfuse/tracing 진입점. trace*는 함수 wrap(decorator), 응답 파싱 후의 dynamic
// attribute만 setEmbeddingUsage. SpanProcessor 미부팅 process는 OTEL no-op로 자동 무동작.
// type별 helper 분리는 SDK overload(asType별 attribute 스키마)를 `as` 단언 없이 흡수하기 위함.

type TraceMeta<Args extends unknown[], R, A> = {
  name: string;
  attrs?: (args: Args) => A;
  output?: (result: R) => unknown;
};

export function traceEmbedding<Args extends unknown[], R>(
  meta: TraceMeta<Args, R, LangfuseGenerationAttributes>,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return (...args) =>
    startActiveObservation(
      meta.name,
      async () => {
        if (meta.attrs)
          updateActiveObservation(meta.attrs(args), { asType: "embedding" });
        const result = await fn(...args);
        updateActiveObservation(
          { output: meta.output ? meta.output(result) : result },
          { asType: "embedding" },
        );
        return result;
      },
      { asType: "embedding" },
    );
}

export function traceRetriever<Args extends unknown[], R>(
  meta: TraceMeta<Args, R, LangfuseSpanAttributes>,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return (...args) =>
    startActiveObservation(
      meta.name,
      async () => {
        if (meta.attrs)
          updateActiveObservation(meta.attrs(args), { asType: "retriever" });
        const result = await fn(...args);
        updateActiveObservation(
          { output: meta.output ? meta.output(result) : result },
          { asType: "retriever" },
        );
        return result;
      },
      { asType: "retriever" },
    );
}

export function traceSpan<Args extends unknown[], R>(
  meta: TraceMeta<Args, R, LangfuseSpanAttributes>,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return (...args) =>
    startActiveObservation(
      meta.name,
      async () => {
        if (meta.attrs) updateActiveObservation(meta.attrs(args));
        const result = await fn(...args);
        updateActiveObservation({
          output: meta.output ? meta.output(result) : result,
        });
        return result;
      },
      { asType: "span" },
    );
}

export function setEmbeddingUsage(input: number): void {
  updateActiveObservation(
    { usageDetails: { input, total: input } },
    { asType: "embedding" },
  );
}

