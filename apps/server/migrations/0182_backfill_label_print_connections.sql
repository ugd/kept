-- An official 1.14.8 database has already applied the purchase-line fix, so Drizzle
-- skips the earlier fork migrations. Install the print schema on that upgrade path.
-- Databases that already have this table keep their saved print connections.
DO $migration$
BEGIN
  IF to_regclass('public.label_print_connections') IS NULL THEN
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
    ALTER TABLE "label_print_connections" ADD CONSTRAINT "label_print_connections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE public.label_print_connections ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.label_print_connections FORCE ROW LEVEL SECURITY;
    CREATE POLICY owner_all ON public.label_print_connections FOR ALL TO kept_owner
      USING (true) WITH CHECK (true);
    CREATE POLICY app_select ON public.label_print_connections FOR SELECT TO kept_app
      USING (location_id IN (SELECT kept.visible_location_ids()));
    CREATE POLICY app_insert ON public.label_print_connections FOR INSERT TO kept_app
      WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
                  AND (SELECT kept.current_token_id()) IS NULL);
    CREATE POLICY app_update ON public.label_print_connections FOR UPDATE TO kept_app
      USING (location_id IN (SELECT kept.admin_location_ids())
             AND (SELECT kept.current_token_id()) IS NULL)
      WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
                  AND (SELECT kept.current_token_id()) IS NULL);
    CREATE POLICY app_delete ON public.label_print_connections FOR DELETE TO kept_app
      USING (location_id IN (SELECT kept.admin_location_ids())
             AND (SELECT kept.current_token_id()) IS NULL);
    REVOKE ALL ON public.label_print_connections FROM kept_app, kept_system;
    GRANT SELECT (location_id, base_url, formats, key_version),
      UPDATE (base_url, formats, config_ciphertext, key_version), INSERT, DELETE
      ON public.label_print_connections TO kept_app;
    CREATE FUNCTION kept.label_print_config(p_location uuid)
    RETURNS TABLE (formats jsonb, config_ciphertext jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $config$
      SELECT c.formats, c.config_ciphertext
      FROM public.label_print_connections c WHERE c.location_id = p_location
    $config$;
    REVOKE EXECUTE ON FUNCTION kept.label_print_config(uuid) FROM PUBLIC, kept_app, kept_system;
    GRANT EXECUTE ON FUNCTION kept.label_print_config(uuid) TO kept_system;
  END IF;
END;
$migration$;
