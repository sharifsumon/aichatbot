CREATE TYPE "public"."auth_provider" AS ENUM('facebook', 'google', 'credentials');--> statement-breakpoint
CREATE TYPE "public"."business_type" AS ENUM('ecommerce', 'services', 'other');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('en', 'bn');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'agent');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('trial', 'active', 'past_due', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('setup', 'live', 'paused');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('connected', 'token_expired', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('facebook_page', 'instagram', 'whatsapp', 'widget', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."comment_reply_mode" AS ENUM('off', 'public', 'private', 'public_and_private');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('file', 'text', 'qa', 'website', 'sheet');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."conversation_mode" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."message_delivery" AS ENUM('received', 'pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('message', 'comment', 'comment_reply', 'private_reply');--> statement-breakpoint
CREATE TYPE "public"."message_sender" AS ENUM('customer', 'ai', 'staff', 'support', 'system');--> statement-breakpoint
CREATE TYPE "public"."checkout_step" AS ENUM('awaiting_address', 'awaiting_payment_method', 'awaiting_transaction_id', 'complete');--> statement-breakpoint
CREATE TYPE "public"."delivery_zone" AS ENUM('inside_dhaka', 'outside_dhaka');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('ai', 'staff');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('confirmed', 'shipped', 'delivered', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cod', 'bkash', 'nagad');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'cod_due', 'pending_verification', 'paid', 'rejected', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'draft', 'archived');--> statement-breakpoint
CREATE TYPE "public"."credit_grant_reason" AS ENUM('plan', 'topup', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('super_admin', 'support', 'finance');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"password_hash" text,
	"locale" "locale" DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"business_type" "business_type" DEFAULT 'ecommerce' NOT NULL,
	"status" "workspace_status" DEFAULT 'trial' NOT NULL,
	"suspended_reason" text,
	"plan_id" uuid,
	"trial_ends_at" timestamp with time zone,
	"onboarding_completed_at" timestamp with time zone,
	"locale" "locale" DEFAULT 'bn' NOT NULL,
	"billing_country" text DEFAULT 'BD' NOT NULL,
	"currency" text DEFAULT 'BDT' NOT NULL,
	"delivery_charge_inside_dhaka" numeric(10, 2) DEFAULT '60' NOT NULL,
	"delivery_charge_outside_dhaka" numeric(10, 2) DEFAULT '120' NOT NULL,
	"bkash_number" text,
	"nagad_number" text,
	"cod_enabled" boolean DEFAULT true NOT NULL,
	"next_order_number" integer DEFAULT 1001 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"system_instruction" text DEFAULT '' NOT NULL,
	"tone" text DEFAULT 'friendly' NOT NULL,
	"languages" text[] DEFAULT '{"bn","en"}' NOT NULL,
	"handoff_enabled" boolean DEFAULT true NOT NULL,
	"handoff_rules" jsonb DEFAULT '{"minConfidence":0.5,"onComplaint":true,"onHumanRequest":true,"keywords":[]}'::jsonb NOT NULL,
	"comment_reply_mode" "comment_reply_mode" DEFAULT 'public_and_private' NOT NULL,
	"status" "agent_status" DEFAULT 'setup' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"type" "channel_type" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"access_token_encrypted" text,
	"status" "channel_status" DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"type" "knowledge_source_type" NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"file_key" text,
	"file_size_bytes" integer,
	"content" text,
	"status" "knowledge_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"mode" "conversation_mode" DEFAULT 'ai' NOT NULL,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"handoff_reason" text,
	"flagged" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_customer_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text,
	"phone" text,
	"address" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_channel_id" uuid,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" DEFAULT 'message' NOT NULL,
	"sender" "message_sender" NOT NULL,
	"sender_user_id" uuid,
	"text" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"delivery" "message_delivery" NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"title" text NOT NULL,
	"code" text NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"conversation_id" uuid,
	"source" "order_source" NOT NULL,
	"status" "order_status" DEFAULT 'confirmed' NOT NULL,
	"checkout_step" "checkout_step" DEFAULT 'awaiting_address' NOT NULL,
	"customer_name" text,
	"phone" text,
	"address" text,
	"delivery_zone" "delivery_zone",
	"subtotal" numeric(12, 2) NOT NULL,
	"delivery_charge" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"payment_method" "payment_method",
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_transaction_id" text,
	"payment_sender_number" text,
	"payment_verified_by_user_id" uuid,
	"payment_verified_at" timestamp with time zone,
	"courier" text,
	"consignment_id" text,
	"tracking_url" text,
	"notes" text,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"price" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"code" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"image_url" text,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"workspace_id" uuid,
	"target_type" text,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reason" "credit_grant_reason" NOT NULL,
	"credits" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by_platform_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"workspace_id" uuid,
	"plan_id" uuid,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_workspaceId_planId_unique" UNIQUE NULLS NOT DISTINCT("key","workspace_id","plan_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"price_bdt" numeric(10, 2) NOT NULL,
	"price_usd" numeric(10, 2) NOT NULL,
	"trial_days" integer,
	"limits" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "platform_role" NOT NULL,
	"totp_secret_encrypted" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"gateway" text,
	"gateway_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"ai_replies" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"failed_calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_verified_by_user_id_users_id_fk" FOREIGN KEY ("payment_verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_granted_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("granted_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_workspace_id_created_at_index" ON "activities" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_provider_account_id_index" ON "auth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "agents_workspace_id_index" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_type_external_id_index" ON "channels" USING btree ("type","external_id");--> statement-breakpoint
CREATE INDEX "channels_workspace_id_index" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_workspace_id_index" ON "knowledge_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_sources_workspace_id_index" ON "knowledge_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_id_customer_id_index" ON "conversations" USING btree ("channel_id","customer_id");--> statement-breakpoint
CREATE INDEX "conversations_workspace_id_last_message_at_index" ON "conversations" USING btree ("workspace_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_identities_channel_id_external_id_index" ON "customer_identities" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "customers_workspace_id_phone_index" ON "customers" USING btree ("workspace_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_workspace_id_customer_id_index" ON "leads" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE INDEX "leads_workspace_id_status_index" ON "leads" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_id_external_id_index" ON "messages" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_index" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_workspace_id_created_at_index" ON "messages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_id_index" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_workspace_id_number_index" ON "orders" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "orders_workspace_id_status_created_at_index" ON "orders" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "orders_workspace_id_payment_status_index" ON "orders" USING btree ("workspace_id","payment_status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_workspace_id_payment_method_payment_transaction_id_index" ON "orders" USING btree ("workspace_id","payment_method","payment_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_id_color_size_index" ON "product_variants" USING btree ("product_id","color","size");--> statement-breakpoint
CREATE INDEX "product_variants_workspace_id_index" ON "product_variants" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_workspace_id_code_index" ON "products" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_index" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_workspace_id_created_at_index" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_grants_workspace_id_expires_at_index" ON "credit_grants" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "subscriptions_workspace_id_index" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_workspace_id_day_model_index" ON "usage_records" USING btree ("workspace_id","day","model");--> statement-breakpoint
CREATE INDEX "usage_records_day_index" ON "usage_records" USING btree ("day");