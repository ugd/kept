import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { PrintServerSettings } from '@/components/labels/print-server-settings';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';

export const Route = createFileRoute('/_app/settings/location/$id/label-print-server')({
  component: PrintServerPage,
  errorComponent: SettingsRouteError,
});

function PrintServerPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="label-print-server" title={() => t`Print server`}>
      {() => <PrintServerSettings locationId={id} />}
    </LocationSettingsPage>
  );
}
