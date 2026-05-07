CREATE TABLE IF NOT EXISTS "eval_items" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"expected_keywords" text[] NOT NULL,
	"expected_citation_doc" text NOT NULL,
	"category" text NOT NULL,
	"difficulty" text NOT NULL,
	"tax_type" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"embedding_model" text NOT NULL,
	"retrieval_k" integer NOT NULL,
	"prompt_version" text,
	"goldenset_version" text NOT NULL,
	"results" jsonb NOT NULL,
	"summary" jsonb NOT NULL
);
