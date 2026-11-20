CREATE TABLE "media_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_usage" ADD CONSTRAINT "media_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_usage_workspace_id_kind_created_at_index" ON "media_usage" USING btree ("workspace_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_usage_source_id_index" ON "media_usage" USING btree ("source_id");--> statement-breakpoint
-- Images and videos already made this month count towards it.
INSERT INTO "media_usage" ("workspace_id", "kind", "amount", "source_id", "created_at")
SELECT "workspace_id", 'image', 1, "id", "created_at" FROM "try_on_images"
WHERE "status" <> 'failed' AND "created_at" >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';--> statement-breakpoint
INSERT INTO "media_usage" ("workspace_id", "kind", "amount", "source_id", "created_at")
SELECT "workspace_id", 'video', coalesce(ceil("duration_sec")::int, ("options"->>'seconds')::int, 10), "id", "created_at" FROM "model_videos"
WHERE "status" <> 'failed' AND "created_at" >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';--> statement-breakpoint
-- AI images and seconds of AI video per month. The free trial and Starter get
-- 4 images and 10 seconds of video (two 5 second videos, or one of 10).
-- Growth and Pro set no cap; AI credits still apply. Editable in the admin panel.
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('imagesPerMonth', 4, 'videoSecondsPerMonth', 10) WHERE "key" IN ('trial', 'starter');
