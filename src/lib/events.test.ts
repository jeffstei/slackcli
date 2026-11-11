import { describe, expect, it } from 'bun:test';
import { listenEvents, normalizeMessage, projectEvent, validateClientMessageId, type EventRecord, type TransportCallbacks } from './events.ts';
import { parseFields } from './json-fields.ts';
import type { BrowserAuthConfig } from '../types/index.ts';

const config: BrowserAuthConfig = {
  auth_type: 'browser', workspace_id: 'T123', workspace_name: 'acme',
  workspace_url: 'https://acme.slack.com', user_id: 'U123',
  xoxc_token: 'test-token', xoxd_token: 'test-cookie', secret_backend: 'dpapi',
};
const load = async () => ({ key: 'acme', config });
const frame = { type: 'message', channel: 'C123', ts: '1712345678.123456', user: 'U123', text: 'hello' };

describe('stream message projection', () => {
  it('projects content without removing required envelope, message or echo identities', () => {
    const record: EventRecord = {
      ...normalizeMessage({ ...frame, thread_ts: '1712345677.123456', client_msg_id: 'outbound-id' })!,
      protocol: 'slackcli.events', version: 1, workspace_id: 'T123', stream_id: 'stream',
      sequence: 1, received_at: '2026-11-11T00:00:00.000Z',
    };
    const projected = projectEvent(record, parseFields('text'));
    expect(projected).toEqual(record);
    const identityOnly = projectEvent(record, parseFields('nonexistent'));
    expect(identityOnly.kind === 'message' && identityOnly.message.text).toBeUndefined();
    expect(identityOnly.kind === 'message' && identityOnly.message.ts).toBe(frame.ts);
    expect(identityOnly.kind === 'message' && identityOnly.message.client_msg_id).toBe('outbound-id');
  });
  it('keeps stable identity across duplicate delivery and excludes untrusted transport fields', () => {
    const first = normalizeMessage({ ...frame, token: 'secret', url: 'secret', nested: { token: 'secret' } });
    expect(first).toEqual(normalizeMessage(frame));
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(first?.message).toEqual({ ts: frame.ts, user: frame.user, text: frame.text });
  });
  it('keeps thread and client message identities without float conversion', () => {
    const event = normalizeMessage({ ...frame, thread_ts: '1712345677.123456', client_msg_id: 'id' });
    expect(event?.message.thread_ts).toBe('1712345677.123456');
    expect(event?.message.client_msg_id).toBe('id');
  });
  it('distinguishes edits, deletes and reply-count changes from new commands', () => {
    expect(normalizeMessage({
      type: 'message', subtype: 'message_changed', channel: 'C123',
      message: { ...frame, text: 'edited', edited: { ts: '1712345679.123456' } },
    })?.operation).toBe('edit');
    expect(normalizeMessage({ type: 'message', subtype: 'message_replied', channel: 'C123', message: frame })?.operation).toBe('edit');
    expect(normalizeMessage({ type: 'message', subtype: 'message_deleted', channel: 'C123', deleted_ts: frame.ts })?.operation).toBe('delete');
  });
  it('rejects invalid identities without echoing the frame', () => {
    for (const bad of [{ ...frame, channel: 'secret' }, { ...frame, ts: 'secret' }, { ...frame, thread_ts: 'secret' }]) {
      expect(() => normalizeMessage(bad)).toThrow();
      try { normalizeMessage(bad); } catch (error) { expect(String(error)).not.toContain('secret'); }
    }
    expect(normalizeMessage({ type: 'pong' })).toBeNull();
    expect(normalizeMessage(null)).toBeNull();
  });
});

describe('stream session', () => {
  it('matches the reusable actual-producer lifecycle fixture, including pre-ready gaps', async () => {
    const expected: EventRecord[] = (await Bun.file(new URL('./events-v1.fixture.jsonl', import.meta.url)).text())
      .trim().split('\n').map((line) => JSON.parse(line));
    const records: EventRecord[] = [];
    const stop = new AbortController();
    await listenEvents({
      load, signal: stop.signal, now: () => new Date('2026-01-01T00:00:00.000Z'),
      write: async (record) => { records.push(record); if (records.length === 9) stop.abort(); },
      transport: (_config, callbacks) => ({
        async start() {
          callbacks.ready('U123');
          callbacks.frame(frame);
          callbacks.frame(frame);
          callbacks.disconnected();
          callbacks.ready('U123');
          callbacks.frame({ ...frame, ts: '1712345679.123456', text: 'after reconnect' });
        },
        stop() {},
      }),
    });
    const canonical = (record: EventRecord) => ({ ...record, stream_id: 'fixture' });
    expect(records.map(canonical)).toEqual(expected.map(canonical));
    expect(records.map((record) => record.kind)).toEqual([
      'gap', 'ready', 'message', 'message', 'gap', 'status', 'gap', 'ready', 'message',
    ]);
  });

  it('emits startup/reconnect gaps and versioned readiness only after handshake', async () => {
    const records: EventRecord[] = [];
    const stop = new AbortController();
    let callbacks!: TransportCallbacks;
    let stopped = 0;
    const task = listenEvents({
      load, signal: stop.signal, write: async (record) => { records.push(record); },
      transport: (_config, next) => {
        callbacks = next;
        return { async start() {}, stop() { stopped++; } };
      },
    });
    await Bun.sleep(0);
    expect(records).toHaveLength(0);
    callbacks.ready('U123');
    callbacks.frame(frame);
    callbacks.disconnected();
    callbacks.ready('U123');
    await Bun.sleep(0);
    stop.abort();
    await task;
    expect(records.map((record) => record.kind)).toEqual(['gap', 'ready', 'message', 'gap', 'status', 'gap', 'ready']);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(records.map((record) => record.stream_id)).size).toBe(1);
    expect(records.every((record) => record.protocol === 'slackcli.events' && record.version === 1 && record.workspace_id === 'T123')).toBe(true);
    expect(stopped).toBe(1);
    expect(JSON.stringify(records)).not.toContain('test-token');
    expect(JSON.stringify(records)).not.toContain('test-cookie');
  });
  it('refuses standard auth before constructing a socket', async () => {
    await expect(listenEvents({
      signal: new AbortController().signal, write: async () => {},
      load: async () => ({ key: 'acme', config: { auth_type: 'standard', workspace_id: 'T123', workspace_name: 'acme', token: 'test', token_type: 'user' } }),
      transport: () => { throw new Error('must not construct'); },
    })).rejects.toMatchObject({ code: 'unsupported_auth_type' });
  });
  it('rejects mismatched users and always stops the transport', async () => {
    let stopped = false;
    await expect(listenEvents({
      load, signal: new AbortController().signal, write: async () => {},
      transport: (_config, callbacks) => ({
        async start() { callbacks.ready('UOTHER'); },
        stop() { stopped = true; },
      }),
    })).rejects.toMatchObject({ code: 'auth_failed' });
    expect(stopped).toBe(true);
  });
  it('fails bounded output rather than silently dropping events', async () => {
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { release = resolve; });
    const task = listenEvents({
      load, signal: new AbortController().signal, write: async () => writing,
      transport: (_config, callbacks) => ({
        async start() {
          callbacks.ready('U123');
          for (let i = 0; i < 300; i++) callbacks.frame(frame);
        },
        stop() {},
      }),
    });
    await expect(task).rejects.toMatchObject({ code: 'network' });
    release();
  });
  it('propagates output failures and rejects messages before hello', async () => {
    for (const beforeReady of [true, false]) {
      await expect(listenEvents({
        load, signal: new AbortController().signal,
        write: async () => { throw new Error('closed pipe'); },
        transport: (_config, callbacks) => ({
          async start() { if (!beforeReady) callbacks.ready('U123'); callbacks.frame(frame); },
          stop() {},
        }),
      })).rejects.toThrow();
    }
  });
  it('does not open a transport when already cancelled', async () => {
    const stop = new AbortController();
    stop.abort();
    await listenEvents({
      load, signal: stop.signal, write: async () => {},
      transport: () => { throw new Error('must not construct'); },
    });
  });
});

it('validates client UUIDs before writes', () => {
  expect(validateClientMessageId(undefined)).toBeUndefined();
  expect(validateClientMessageId('12345678-1234-4234-8234-123456789012')).toBe('12345678-1234-4234-8234-123456789012');
  expect(() => validateClientMessageId('token')).toThrow('UUID');
});
