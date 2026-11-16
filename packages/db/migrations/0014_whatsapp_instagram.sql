ALTER TABLE "agents" ADD COLUMN "channel_type" "channel_type" DEFAULT 'facebook_page' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- WhatsApp numbers and Instagram accounts per plan. Starter gets one of each, and
-- room for three bots: one each for Facebook, WhatsApp and Instagram.
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('whatsappNumbers', 0, 'instagramAccounts', 0) WHERE "key" = 'trial';--> statement-breakpoint
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('whatsappNumbers', 1, 'instagramAccounts', 1, 'agents', greatest(coalesce(("limits"->>'agents')::int, 1), 3)) WHERE "key" = 'starter';--> statement-breakpoint
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('whatsappNumbers', 3, 'instagramAccounts', 3, 'agents', greatest(coalesce(("limits"->>'agents')::int, 1), 3)) WHERE "key" = 'growth';--> statement-breakpoint
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('whatsappNumbers', 10, 'instagramAccounts', 10, 'agents', greatest(coalesce(("limits"->>'agents')::int, 1), 3)) WHERE "key" = 'pro';
