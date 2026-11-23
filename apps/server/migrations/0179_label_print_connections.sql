CREATE TABLE "label_print_connections" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"formats" jsonb NOT NULL,
	"config_ciphertext" jsonb NOT NULL,
	"key_version" integer NOT NULL,
	CONSTRAINT "label_print_connections_url_chk" CHECK (char_length("label_print_connections"."base_url") BETWEEN 1 AND 500),
	CONSTRAINT "label_print_connections_formats_chk" CHECK (jsonb_typeof("label_print_connections"."formats") = 'array'),
	CONSTRAINT "label_print_connections_key_version_chk" CHECK ("label_print_connections"."key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "label_print_connections" ADD CONSTRAINT "label_print_connections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;