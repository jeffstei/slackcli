import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WindowsDpapiSecretStore, runDpapi, type DpapiRunner } from './dpapi.ts';
import { RoutingSecretStore, SecretStoreError } from './secret-store.ts';
import { migrateOneWorkspace, secretBackendsFor } from './workspaces.ts';
import type { WorkspacesData } from '../types/index.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'slackcli-dpapi-'));
  directories.push(directory);
  return directory;
}
const fake: DpapiRunner = async (operation, key, value) => operation === 'protect'
  ? Buffer.from(`${key}|${value}`).toString('base64')
  : Buffer.from(value, 'base64').toString().slice(key.length + 1);

describe('Windows protected credential backend', () => {
  it('round-trips through the backend with opaque filenames and no plaintext on disk', async () => {
    const directory = await temporary();
    const store = new WindowsDpapiSecretStore(directory, fake, 'win32');
    expect(await store.get('acme:xoxc')).toBeNull();
    await store.set('acme:xoxc', 'synthetic-credential');
    expect(await store.get('acme:xoxc')).toBe('synthetic-credential');
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.dpapi$/);
    expect(await readFile(join(directory, files[0]), 'utf8')).not.toContain('synthetic-credential');
    await store.delete('acme:xoxc');
    await store.delete('acme:xoxc');
    expect(await store.get('acme:xoxc')).toBeNull();
  });
  it('does not silently fall back when DPAPI is unavailable or access denied', async () => {
    const directory = await temporary();
    await expect(new WindowsDpapiSecretStore(directory, fake, 'linux').set('key', 'synthetic')).rejects.toMatchObject({ reason: 'unavailable' });
    const denied: DpapiRunner = async () => { throw new SecretStoreError('dpapi', 'access_denied', 'Denied'); };
    await expect(new WindowsDpapiSecretStore(directory, denied, 'win32').set('key', 'synthetic')).rejects.toMatchObject({ reason: 'access_denied' });
    expect(await readdir(directory)).toEqual([]);
  });
  it('refuses OneDrive paths, including resolved directory targets', async () => {
    const directory = await temporary();
    const store = new WindowsDpapiSecretStore(join(directory, 'OneDrive - Example', 'secrets'), fake, 'win32');
    await expect(store.set('key', 'synthetic')).rejects.toMatchObject({ reason: 'access_denied' });
    await symlink(join(directory, 'OneDrive - Example', 'secrets'), join(directory, 'safe'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new WindowsDpapiSecretStore(join(directory, 'safe'), fake, 'win32')
      .set('key', 'synthetic')).rejects.toMatchObject({ reason: 'access_denied' });
  });
  it('rejects corrupt protected files instead of treating them as missing', async () => {
    const directory = await temporary();
    const store = new WindowsDpapiSecretStore(directory, fake, 'win32');
    await store.set('key', 'synthetic');
    const [file] = await readdir(directory);
    await writeFile(join(directory, file), 'not:protected');
    await expect(store.get('key')).rejects.toMatchObject({ reason: 'access_denied' });
  });
  it('rejects a runner returning plaintext before writing any file', async () => {
    const directory = await temporary();
    const store = new WindowsDpapiSecretStore(directory, async (_operation, _key, value) => value, 'win32');
    await expect(store.set('key', 'synthetic')).rejects.toMatchObject({ reason: 'access_denied' });
    expect(await readdir(directory)).toEqual([]);
  });
  it('migrates only after verification and routes metadata without inline credentials', async () => {
    const directory = await temporary();
    const store = new WindowsDpapiSecretStore(directory, fake, 'win32');
    const data: WorkspacesData = { workspaces: { acme: {
      auth_type: 'browser', workspace_id: 'T123', workspace_name: 'acme',
      workspace_url: 'https://acme.slack.com', xoxc_token: 'synthetic-token', xoxd_token: 'synthetic-cookie',
    } } };
    await migrateOneWorkspace(data, secretBackendsFor(data, store, store), 'acme', 'dpapi', async () => {});
    expect(JSON.stringify(data)).not.toContain('synthetic-token');
    expect(JSON.stringify(data)).not.toContain('synthetic-cookie');
    const routing = new RoutingSecretStore(data, store, store);
    expect(await routing.get('acme:xoxc')).toBe('synthetic-token');
    expect(await routing.get('acme:xoxd')).toBe('synthetic-cookie');
  });
});

it.skipIf(process.platform !== 'win32')('protects synthetic data with actual CurrentUser DPAPI, never a real credential', async () => {
  const encrypted = await runDpapi('protect', 'test-key', 'synthetic-only');
  expect(encrypted).not.toContain('synthetic-only');
  expect(await runDpapi('unprotect', 'test-key', encrypted)).toBe('synthetic-only');
});
