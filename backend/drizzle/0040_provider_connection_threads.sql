CREATE TABLE "provider_connection_threads" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"product_thread_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"auth_epoch" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connection_threads_org_id_user_id_product_thread_id_connection_id_auth_epoch_pk" PRIMARY KEY("org_id","user_id","product_thread_id","connection_id","auth_epoch"),
	CONSTRAINT "provider_connection_threads_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_connection_threads_provider_scope" ON "provider_connection_threads" USING btree ("connection_id","auth_epoch","provider_thread_id");
