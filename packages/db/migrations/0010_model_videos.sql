CREATE TABLE "model_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_image_url" text NOT NULL,
	"mode" text DEFAULT 'talk' NOT NULL,
	"script" text,
	"audio_url" text,
	"voice" text,
	"language" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "try_on_status" DEFAULT 'pending' NOT NULL,
	"result_video_url" text,
	"duration_sec" numeric(8, 2),
	"credits" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "model_videos" ADD CONSTRAINT "model_videos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_videos" ADD CONSTRAINT "model_videos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_videos_workspace_id_created_at_index" ON "model_videos" USING btree ("workspace_id","created_at");