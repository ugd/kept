import { can } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { PlusIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useLocationName } from '@/lib/labels';
import type { ScanTarget } from './resolve';

export function PhotoTargetPicker({
  onPick,
  onCreate,
}: {
  onPick: (target: ScanTarget) => void;
  onCreate: (locationId: string, box: boolean) => void;
}) {
  const { t } = useLingui();
  const explain = useErrorText();
  const locationName = useLocationName();
  const locations = useLocations();
  const [text, setText] = useState('');
  const q = text.trim();
  const writable = new Map(
    (locations.data ?? [])
      .filter((row) => can(row.role, 'attachments.add'))
      .map((row) => [row.id, row]),
  );
  const editable = [...writable.values()].filter(({ role }) => can(role, 'things.edit'));
  const addTo = editable.find(({ kind }) => kind !== 'personal') ?? editable[0];
  const params = { q, locationId: [...writable.keys()], limit: 20 };
  const results = useQuery({
    queryKey: inventoryKeys.search(params),
    queryFn: () => inventoryApi.search(params),
    enabled: !!q && writable.size > 0,
  });
  const items = [
    ...(results.data?.things.items ?? []).map((item) => ({ ...item, kind: 'thing' as const })),
    ...(results.data?.places ?? []).map((item) => ({ ...item, kind: 'place' as const })),
  ].filter(({ locationId }) => writable.has(locationId));

  return (
    <div className="grid gap-3">
      <TextField
        label={t`Search by code or name`}
        type="search"
        value={text}
        onChange={setText}
        maxLength={120}
        autoFocus
      />
      {locations.error || results.error ? (
        <Notice tone="danger">{explain(locations.error ?? results.error)}</Notice>
      ) : results.isFetching || locations.isPending ? (
        <p role="status" className="m-0 text-small text-ink-2">
          <Trans>Searching…</Trans>
        </p>
      ) : q && !items.length ? (
        <p role="status" className="m-0 text-small text-ink-2">
          <Trans>Nothing here matches.</Trans>
        </p>
      ) : null}
      {items.length ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {items.map(({ id, kind, name, locationId }) => {
            const location = writable.get(locationId);
            return (
              <li key={`${kind}:${id}`}>
                <Button
                  variant="secondary"
                  className="min-h-11 w-full flex-wrap justify-between gap-x-3 gap-y-1 text-start"
                  onPress={() => onPick({ id, kind, locationId })}
                >
                  <bdi className="min-w-0 [overflow-wrap:anywhere]">{name ?? t`Unnamed`}</bdi>
                  {location ? (
                    <bdi className="text-small font-normal text-ink-2">
                      {locationName(location)}
                    </bdi>
                  ) : null}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {addTo ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            className="min-h-11"
            onPress={() => onCreate(addTo.id, false)}
          >
            <PlusIcon className="size-4" />
            <Trans>Add a thing</Trans>
          </Button>
          <Button variant="secondary" className="min-h-11" onPress={() => onCreate(addTo.id, true)}>
            <PlusIcon className="size-4" />
            <Trans>Add a box</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
