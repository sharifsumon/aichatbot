ALTER TABLE "media_usage" ADD COLUMN "extra" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_usage" ADD COLUMN "extra_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Starter: 20 AI images and 50 seconds of AI video a month (five 10-second videos).
-- At 10 credits an image and 15 a second that is 950 of its 2,000 credits, so at
-- least 1,050 stay for replies. More images or video need a top-up.
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('imagesPerMonth', 20, 'videoSecondsPerMonth', 50) WHERE "key" = 'starter';
