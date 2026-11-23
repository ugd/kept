-- Custom SQL migration file, put your code below! --
-- Members read the roll formats. Owners and admins manage the connection through a session.
-- Only the system door can read the sealed credential, after the route checks location access.
ALTER TABLE public.label_print_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.label_print_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.label_print_connections FOR ALL TO kept_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_select ON public.label_print_connections FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.label_print_connections FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_update ON public.label_print_connections FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids())
         AND (SELECT kept.current_token_id()) IS NULL)
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_delete ON public.label_print_connections FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids())
         AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
REVOKE ALL ON public.label_print_connections FROM kept_app, kept_system;
--> statement-breakpoint
GRANT SELECT (location_id, base_url, formats, key_version),
  UPDATE (base_url, formats, config_ciphertext, key_version), INSERT, DELETE
  ON public.label_print_connections TO kept_app;
--> statement-breakpoint
CREATE FUNCTION kept.label_print_config(p_location uuid)
RETURNS TABLE (formats jsonb, config_ciphertext jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.formats, c.config_ciphertext
  FROM public.label_print_connections c WHERE c.location_id = p_location
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.label_print_config(uuid) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.label_print_config(uuid) TO kept_system;
