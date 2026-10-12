/**
 * The install dialog for a `.pplugin` file: "Install anyway" is never one keystroke.
 *
 * Found on the RTX box (2026-10-13, second app instance): with focus in the
 * dialog body, Enter clicked "Install anyway" for an unknown publisher's
 * package — Modal's Enter fallback took the danger button of a DialogFooter
 * that has no primary.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { ModalHost } from '@layout/overlays/ModalHost';
import { useModalStore } from '@stores/modalStore';
import type { NativePluginPackagePreview } from '@/types/motionEditor';
import { confirmPackageInstall, type PackageChoice } from './InstallPackageDialog';

const preview = (trust: NativePluginPackagePreview['trust']): NativePluginPackagePreview => ({
  token: 't', fileName: 'x.pplugin', id: 'com.acme.glow', name: 'Glow', version: '1.0.0', vendor: 'Acme', sdk: '1.0',
  effects: [{ matchName: 'com.acme.glow', name: 'Glow', category: 'Acme' }], platforms: ['windows'], runsHere: true,
  trust, publisher: 'Acme', entitlement: null, installedVersion: null, problem: null, storeUnreachable: false,
});

afterEach(() => act(() => useModalStore.getState().closeAll()));

async function open(trust: NativePluginPackagePreview['trust']): Promise<{ choice: () => PackageChoice | undefined }> {
  render(<ModalHost />);
  let choice: PackageChoice | undefined;
  await act(async () => { void confirmPackageInstall(preview(trust)).then((c) => { choice = c; }); });
  return { choice: () => choice };
}

it('Enter in the body of an unknown publisher\'s dialog installs nothing; "Install anyway" does', async () => {
  const d = await open('unknown');
  const body = screen.getByText(/Signed, but not by a publisher/);
  await act(async () => { fireEvent.keyDown(body, { key: 'Enter' }); });
  expect(d.choice()).toBeUndefined();
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install anyway' })); });
  expect(d.choice()).toBe('anyway');
});

it('Enter installs a package from a known publisher', async () => {
  const d = await open('store-verified');
  await act(async () => { fireEvent.keyDown(screen.getByText(/Signed with the key this plugin is published with/), { key: 'Enter' }); });
  expect(d.choice()).toBe('install');
});
