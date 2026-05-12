import { z } from "zod";

import { recordFeedback } from "@/features/submit-feedback/server";
import { parseJsonBody } from "@/shared/api/server";

const FeedbackBodySchema = z.object({
  traceId: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, FeedbackBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    await recordFeedback(parsed.data);
  } catch (err) {
    console.error("[feedback] flush failed:", err);
    return new Response("score export failed", { status: 502 });
  }

  return new Response(null, { status: 204 });
}
