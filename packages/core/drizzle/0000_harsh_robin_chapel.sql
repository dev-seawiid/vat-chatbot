CREATE TABLE IF NOT EXISTS "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"page" integer,
	"section_path" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_chunks_doc_content_hash" UNIQUE("doc_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"version" text,
	"file_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_file_hash_unique" UNIQUE("file_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chunks" ADD CONSTRAINT "chunks_doc_id_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chunks_doc_id" ON "chunks" USING btree ("doc_id");