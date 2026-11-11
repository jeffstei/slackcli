import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SecretStoreError, type SecretStore } from './secret-store.ts';

type Operation = 'protect' | 'unprotect';
export type DpapiRunner = (operation: Operation, key: string, value: string) => Promise<string>;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $entropy = [Text.Encoding]::UTF8.GetBytes($p.key)
  if ($p.operation -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($p.value)
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Convert]::ToBase64String($result))
  } elseif ($p.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($p.value), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Text.Encoding]::UTF8.GetString($result))
  } else { exit 1 }
} catch { exit 1 }
`;

export const runDpapi: DpapiRunner = (operation, key, value) => new Promise((resolve, reject) => {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) {
    reject(new SecretStoreError('dpapi', 'unavailable', 'Windows DPAPI is unavailable.'));
    return;
  }
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Script arguments are constant. All credential material travels over an anonymous stdin pipe.
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  let output = '';
  let settled = false;
  const finish = (error?: SecretStoreError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(output);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(new SecretStoreError('dpapi', 'unavailable', 'Windows DPAPI operation timed out.'));
  }, 15_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    if (output.length > 64 * 1024) {
      child.kill();
      finish(new SecretStoreError('dpapi', 'access_denied', 'Windows DPAPI returned an invalid result.'));
    }
  });
  child.on('error', () => finish(new SecretStoreError('dpapi', 'unavailable', 'Windows DPAPI could not start.')));
  child.stdin.on('error', () => finish(new SecretStoreError('dpapi', 'unavailable', 'Windows DPAPI input failed.')));
  child.on('close', (code) => finish(code === 0 && output
    ? undefined : new SecretStoreError('dpapi', 'access_denied', 'Windows DPAPI could not protect or unlock this credential.')));
  child.stdin.end(JSON.stringify({ operation, key, value }));
});

export class WindowsDpapiSecretStore implements SecretStore {
  readonly backend = 'dpapi';
  constructor(
    private readonly directory: string = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'SlackCLI', 'secrets') : '',
    private readonly runner: DpapiRunner = runDpapi,
    private readonly platform: string = process.platform,
  ) {}

  private async path(key: string): Promise<string> {
    if (this.platform !== 'win32' || !this.directory || !isAbsolute(this.directory)) {
      throw new SecretStoreError('dpapi', 'unavailable', 'DPAPI requires Windows and an absolute LOCALAPPDATA directory.');
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(this.directory);
    if (/(?:^|[\\/])OneDrive(?: - [^\\/]+)?(?:[\\/]|$)/i.test(directory)) {
      throw new SecretStoreError('dpapi', 'access_denied', 'Credential ciphertext must not be stored on OneDrive.');
    }
    return join(directory, `${createHash('sha256').update(key).digest('hex')}.dpapi`);
  }

  async get(key: string): Promise<string | null> {
    const path = await this.path(key);
    let ciphertext: string;
    try { ciphertext = await readFile(path, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new SecretStoreError('dpapi', 'access_denied', 'Could not read the protected credential.');
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext) || ciphertext.length > 64 * 1024) {
      throw new SecretStoreError('dpapi', 'access_denied', 'Protected credential is corrupt.');
    }
    return this.runner('unprotect', key, ciphertext);
  }

  async set(key: string, value: string): Promise<void> {
    const path = await this.path(key);
    const ciphertext = await this.runner('protect', key, value);
    if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext) || ciphertext === value) {
      throw new SecretStoreError('dpapi', 'access_denied', 'Windows DPAPI returned invalid ciphertext.');
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, ciphertext, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(key: string): Promise<void> {
    await rm(await this.path(key), { force: true });
  }
}
