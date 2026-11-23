import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { capturePaths } from '@/api/capture/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';

const path = `/settings/location/${IDS.home}/label-print-server`;

it('saves, tests and disconnects a print server from location settings', async () => {
  const { user, mock } = await renderApp(path);
  await findHeading('Print server');
  expect(screen.getByRole('link', { name: 'Print server' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const url = await screen.findByRole('textbox', { name: 'Print server URL' });
  expect(screen.getByRole('textbox', { name: 'Roll width (mm)' })).toHaveValue('50');
  expect(screen.getByRole('textbox', { name: 'Label height (mm)' })).toHaveValue('30');
  expect(screen.getByRole('textbox', { name: 'Printable width (mm)' })).toHaveValue('48');
  await user.type(url, 'https://print.example.com');
  await user.type(screen.getByLabelText('API token'), 'test-only-label-print-key');
  await user.click(screen.getByRole('button', { name: 'Add format' }));
  const [first, second] = screen.getAllByRole('textbox', { name: 'Label height (mm)' });
  await user.clear(second as HTMLElement);
  await user.type(second as HTMLElement, '40');
  expect(first).toHaveValue('30');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Print server settings saved');
  expect(mock.lastCall('PUT', capturePaths.labelPrintSettings(IDS.home))?.body).toMatchObject({
    url: 'https://print.example.com',
    formats: [{ widthMm: 50, heightMm: 30, printableWidthMm: 48, dotsPerMm: 8 }, { heightMm: 40 }],
  });
  expect(screen.getByLabelText('API token')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await screen.findByText('Print server is reachable');
  expect(mock.lastCall('POST', capturePaths.labelPrintCheck(IDS.home))).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Disconnect' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }),
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull());
});

it('keeps the print server settings available only to the location owner and admins', async () => {
  const state = ownerScenario();
  const home = state.locations.find((location) => location.id === IDS.home);
  if (home) home.role = 'member';
  await renderApp(path, { state });
  expect(await screen.findByText('Only the owner and admins change this')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Print server' })).toBeNull();
});
