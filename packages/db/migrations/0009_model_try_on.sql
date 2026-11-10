CREATE TYPE "public"."try_on_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."model_gender" AS ENUM('female', 'male');--> statement-breakpoint
CREATE TABLE "try_on_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"character_id" uuid,
	"model_image_url" text NOT NULL,
	"garment_image_url" text NOT NULL,
	"category" text DEFAULT 'auto' NOT NULL,
	"status" "try_on_status" DEFAULT 'pending' NOT NULL,
	"result_image_url" text,
	"error" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"gender" "model_gender" NOT NULL,
	"image_url" text NOT NULL,
	"image_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_platform_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "try_on_images" ADD CONSTRAINT "try_on_images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "try_on_images" ADD CONSTRAINT "try_on_images_character_id_model_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."model_characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "try_on_images" ADD CONSTRAINT "try_on_images_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_characters" ADD CONSTRAINT "model_characters_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "try_on_images_workspace_id_created_at_index" ON "try_on_images" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "model_characters_active_sort_order_index" ON "model_characters" USING btree ("active","sort_order");