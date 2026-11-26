/**
 * Scan's ways in, through the real route tree: a `/l/<code>` link opens what it's on in
 * place of itself (and marks it seen), "Pick up" in a thing's menu fills the carrying tray whose
 * chip then sits in every page header, and a box's menu starts its box check.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { PASS, reply } from '@/api/mock/kit';
import { pageStore } from '@/pwa/page-store';
import { findHeading, pathOf, renderApp } from '../app';

const T = INV_IDS.thing;

describe('scan entry points', () => {
  it('adds photos to successive labels from Home and retries a failed attachment with the same key', async () => {
    let attempts = 0;
    const { user, mock, router } = await renderApp('/', {
      setup(mock) {
        mock.on('POST', inventoryPaths.attachments, () =>
          ++attempts === 1 ? reply(503, { code: 'internal', error: 'Try again' }) : PASS,
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
    const pickPhoto = async () => {
      await screen.findByRole('button', { name: 'Gallery' });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])');
      if (!input) throw new Error('Missing photo picker');
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      await user.upload(input, new File([bytes], 'photo.jpg', { type: 'image/jpeg' }));
    };
    const writes = () =>
      mock.calls.filter(
        ({ method, path }) => method === 'POST' && path === inventoryPaths.attachments,
      );

    await typeCode('B0X3QF', 'Cable box');
    await pickPhoto();
    expect(await screen.findByRole('img', { name: 'Cable box' })).toBeInTheDocument();
    await screen.findByText(/The server is busy making previews/);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await user.click(retry);
    expect(await screen.findByText('Photo added. Scan the next label.')).toBeInTheDocument();
    expect(writes()).toHaveLength(2);
    expect(writes()[0]?.headers['idempotency-key']).toBeTruthy();
    expect(writes()[1]?.headers['idempotency-key']).toBe(writes()[0]?.headers['idempotency-key']);
    expect(writes()[1]?.body).toEqual(writes()[0]?.body);
    expect(writes()[1]?.body).toMatchObject({ role: 'photo', subject: { thingId: T.cableBox } });

    await typeCode('R00M4K', 'Office');
    await pickPhoto();
    expect(await screen.findByText('Photo added. Scan the next label.')).toBeInTheDocument();
    expect(writes()).toHaveLength(3);
    expect(writes()[2]?.body).toMatchObject({
      role: 'photo',
      subject: { placeId: INV_IDS.place.office },
    });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(pathOf(router)).toBe('/'));
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
