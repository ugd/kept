/**
 * Scan's ways in, through the real route tree: a `/l/<code>` link opens what it's on in
 * place of itself (and marks it seen), "Pick up" in a thing's menu fills the carrying tray whose
 * chip then sits in every page header, and a box's menu starts its box check.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { capturePaths } from '@/api/capture/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { PASS, reply } from '@/api/mock/kit';
import { pageStore } from '@/pwa/page-store';
import { findHeading, pathOf, renderApp } from '../app';

const T = INV_IDS.thing;

describe('scan entry points', () => {
  it('adds several photos to one label and moves on only after Scan next label', async () => {
    let attempts = 0;
    const { user, mock, router } = await renderApp('/', {
      setup(mock) {
        mock.on('POST', inventoryPaths.attachments, () =>
          ++attempts === 2 ? reply(503, { code: 'internal', error: 'Try again' }) : PASS,
        );
      },
    });
    await user.click(await screen.findByRole('link', { name: 'Scan and photograph' }));
    expect(await findHeading('Scan and photograph')).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ photos: 1 });

    const typeCode = async (code: string, name: string) => {
      await user.click(screen.getByRole('button', { name: 'Type the code' }));
      const form = within(await screen.findByRole('dialog', { name: 'Type the code' }));
      await user.type(form.getByRole('textbox', { name: 'Code on the label' }), code);
      await user.click(form.getByRole('button', { name: 'Find' }));
      expect(await findHeading(name)).toBeInTheDocument();
    };
    const pickPhotos = async (...numbers: number[]) => {
      await screen.findByRole('button', { name: 'Gallery' });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])');
      if (!input) throw new Error('Missing photo picker');
      const files = numbers.map(
        (n) =>
          new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, n])], `photo-${n}.jpg`, {
            type: 'image/jpeg',
          }),
      );
      await user.upload(input, files);
    };
    const writes = () =>
      mock.calls.filter(
        ({ method, path }) => method === 'POST' && path === inventoryPaths.attachments,
      );

    await typeCode('B0X3QF', 'Cable box');
    await pickPhotos(1, 2, 3);
    expect(await screen.findByText('1 photo added')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Cable box' })).toBeInTheDocument();
    await screen.findByText(/The server is busy making previews/);
    expect(writes()).toHaveLength(2);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await user.click(retry);
    expect(await screen.findByText('3 photos added')).toBeInTheDocument();
    expect(writes()).toHaveLength(4);
    expect(writes()[1]?.headers['idempotency-key']).toBeTruthy();
    expect(writes()[2]?.headers['idempotency-key']).toBe(writes()[1]?.headers['idempotency-key']);
    expect(writes()[2]?.body).toEqual(writes()[1]?.body);
    for (const write of writes()) {
      expect(write.body).toMatchObject({ role: 'photo', subject: { thingId: T.cableBox } });
    }
    expect(screen.getByRole('heading', { name: 'Cable box' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Scan next label' }));
    await typeCode('R00M4K', 'Office');
    await pickPhotos(4);
    expect(await screen.findByText('1 photo added')).toBeInTheDocument();
    expect(writes()).toHaveLength(5);
    expect(writes()[4]?.body).toMatchObject({
      role: 'photo',
      subject: { placeId: INV_IDS.place.office },
    });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(pathOf(router)).toBe('/'));
  });

  it('lets an unmatched QR choose a record and a blank label be assigned from the photo screen', async () => {
    const { user, mock } = await renderApp('/scan?photos=1');
    const typeCode = async (code: string) => {
      await user.click(await screen.findByRole('button', { name: 'Type the code' }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Type the code' }));
      await user.type(dialog.getByRole('textbox', { name: 'Code on the label' }), code);
      await user.click(dialog.getByRole('button', { name: 'Find' }));
    };
    await typeCode('ZZZ111');
    expect(await screen.findByText('Not in your Kept')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose a thing or place' }));
    const chooser = within(await screen.findByRole('dialog', { name: 'Choose a thing or place' }));
    await user.type(chooser.getByRole('searchbox', { name: 'Search by code or name' }), 'Office');
    await user.click(await chooser.findByRole('button', { name: /^Office/ }));
    expect(await findHeading('Office')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Scan next label' }));

    await typeCode('B7NK4X');
    expect(await findHeading('Claim this label')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Attach to an existing thing/ }));
    await user.type(await screen.findByRole('searchbox', { name: 'Search' }), 'Cable box');
    await user.click(await screen.findByRole('button', { name: /^Cable box/ }));
    expect(await findHeading('Cable box')).toBeInTheDocument();
    expect(mock.lastCall('POST', capturePaths.codeClaim('B7NK4X'))?.body).toEqual({
      thingId: T.cableBox,
    });
    expect(await screen.findByRole('button', { name: 'Gallery' })).toBeEnabled();
  });

  it('creates a box for an unmatched QR and attaches photos without leaving the scanner', async () => {
    const { user, mock, router } = await renderApp('/scan?photos=1');
    await user.click(await screen.findByRole('button', { name: 'Type the code' }));
    const manual = within(await screen.findByRole('dialog', { name: 'Type the code' }));
    await user.type(manual.getByRole('textbox', { name: 'Code on the label' }), 'ZZZ111');
    await user.click(manual.getByRole('button', { name: 'Find' }));
    await user.click(await screen.findByRole('button', { name: 'Choose a thing or place' }));
    await user.click(await screen.findByRole('button', { name: 'Add a box' }));
    const form = within(await screen.findByRole('dialog', { name: 'Add a box' }));
    await waitFor(() =>
      expect(form.getByRole('combobox', { name: 'Type' })).toHaveValue('Box / bin'),
    );
    await user.type(form.getByRole('textbox', { name: 'Name' }), 'New storage box');
    const place = form.getByRole('combobox', { name: 'Where it is' });
    await waitFor(() => expect(place).toBeEnabled());
    await user.type(place, 'Unplaced');
    await user.click(await screen.findByRole('option', { name: 'Unplaced' }));
    await user.click(form.getByRole('button', { name: 'Add' }));

    expect(await findHeading('New storage box')).toBeInTheDocument();
    expect(pathOf(router)).toBe('/scan');
    await screen.findByRole('button', { name: 'Gallery' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])');
    if (!input) throw new Error('Missing photo picker');
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'box.jpg', {
      type: 'image/jpeg',
    });
    await user.upload(input, file);
    expect(await screen.findByText('1 photo added')).toBeInTheDocument();
    const create = mock.lastCall('POST', inventoryPaths.things)?.body as { id: string };
    expect(create).toMatchObject({ name: 'New storage box', id: expect.any(String) });
    expect(mock.lastCall('POST', inventoryPaths.attachments)?.body).toMatchObject({
      subject: { thingId: create.id },
      role: 'photo',
    });
  });

  it('/l/<code> opens the box it is on, leading with its photos, and marks it seen', async () => {
    const { router, mock } = await renderApp('/l/b0x3qf');
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${T.cableBox}`));
    expect(router.state.location.search).toMatchObject({ view: 'photos' });
    await waitFor(() =>
      expect(mock.lastCall('POST', `/api/v1/things/${T.cableBox}/seen`)).toBeTruthy(),
    );
    // Back goes where the person came from, not to the label page again.
    expect(router.history.canGoBack()).toBe(false);
  });

  it('/l/<code> opens a thing that is not a box plainly, without view=photos', async () => {
    const { router } = await renderApp('/l/7kq4mz');
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${T.hdmiCable}`));
    expect(router.state.location.search).not.toHaveProperty('view');
  });

  it('"Pick up" fills the tray, and "Carrying 1" opens it from any header', async () => {
    await pageStore().setTray([]);
    const { user, router } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pick up' }));
    expect(await screen.findByText('Picked up Samsung TV, 55″')).toBeInTheDocument();
    const chip = await screen.findByRole('link', { name: 'Carrying 1' });
    expect(await pageStore().tray()).toEqual([T.tv]);
    await user.click(chip);
    await waitFor(() => expect(pathOf(router)).toBe('/scan'));
    expect(router.state.location.search).toEqual({ tray: 1 });
    await pageStore().setTray([]);
  });

  it('a box offers Box check, which opens its checklist', async () => {
    const { user, router } = await renderApp(`/t/${T.cableBox}`);
    await findHeading('Cable box');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Box check' }));
    await waitFor(() => expect(pathOf(router)).toBe(`/box-check/${T.cableBox}`));
    expect(await screen.findByText('Box check, in progress')).toBeInTheDocument();
  });
});
