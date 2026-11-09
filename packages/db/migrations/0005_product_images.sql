ALTER TABLE "products" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Existing products keep their photo as the main one.
UPDATE "products" SET "images" = jsonb_build_array(jsonb_build_object('url', "image_url", 'color', '')) WHERE "image_url" IS NOT NULL AND "image_url" <> '';
