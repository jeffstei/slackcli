import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as events from '../lib/events.ts';
import { createEventsCommand } from './events.ts';

describe('events listen command', () => {
  let stdout: string;
  let stderr: string;
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    exitCode = process.exitCode ?? 0;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: (error?: Error) => void) => {
      stdout += text;
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
      stderr += text;
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'error').mockImplementation((...values: unknown[]) => { stderr += values.join(' ') + '\n'; });
  });

  afterEach(() => { mock.restore(); process.exitCode = exitCode; });

  it('requires explicit JSONL before opening a transport', async () => {
    const listen = spyOn(events, 'listenEvents').mockResolvedValue();
    await createEventsCommand().parseAsync(['listen'], { from: 'user' });
    expect(listen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('--json');
  });

  it('writes separate records and preserves identity under projection', async () => {
    spyOn(events, 'listenEvents').mockImplementation(async (options) => {
      expect(options.workspace).toBe('acme');
      const base = {
        protocol: events.EVENT_PROTOCOL, version: events.EVENT_PROTOCOL_VERSION,
        workspace_id: 'T123', stream_id: 'fixture', sequence: 1,
        received_at: '2026-01-01T00:00:00.000Z',
      } as const;
      await options.write({ ...base, kind: 'ready', user_id: 'U123', generation: 1 });
      await options.write({
        ...base, sequence: 2, kind: 'message', event_id: 'fixture', channel_id: 'C123',
        operation: 'create', message: { ts: '1712345678.123456', text: 'hello', user: 'U123', subtype: 'hidden' },
      });
    });
    await createEventsCommand().parseAsync(['listen', '--json', '--workspace', 'acme', '--fields', 'text'], { from: 'user' });
    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1].message).toEqual({ ts: '1712345678.123456', text: 'hello', user: 'U123' });
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('reports a closed stdout as failure rather than clean cancellation', async () => {
    const before = process.stdout.listenerCount('error');
    spyOn(events, 'listenEvents').mockImplementation(async (options) => {
      const added = process.stdout.listeners('error').slice(before);
      for (const listener of added) listener(new Error('synthetic pipe closure'));
      expect(options.signal.aborted).toBe(true);
    });
    await createEventsCommand().parseAsync(['listen', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr).error.code).toBe('network');
    expect(process.stdout.listenerCount('error')).toBe(before);
  });

  it('removes signal handlers after clean cancellation', async () => {
    const before = process.listenerCount('SIGTERM');
    spyOn(events, 'listenEvents').mockImplementation(async (options) => {
      const added = process.listeners('SIGTERM').slice(before);
      for (const listener of added) listener('SIGTERM');
      expect(options.signal.aborted).toBe(true);
    });
    await createEventsCommand().parseAsync(['listen', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
