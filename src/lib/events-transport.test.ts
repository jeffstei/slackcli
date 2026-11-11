import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createBrowserEventTransport, eventFetch, validateEventSocketUrl } from './events-transport.ts';
import type { BrowserAuthConfig } from '../types/index.ts';

describe('browser event destinations', () => {
  it('permits only TLS Slack gateways, including validated reconnect tickets', () => {
    expect(() => validateEventSocketUrl('wss://wss-primary.slack.com/?token=private')).not.toThrow();
    for (const url of [
      'ws://wss-primary.slack.com/', 'wss://wss-primary.slack.com.evil.example/',
      'wss://evil.example/', 'wss://user@wss-primary.slack.com/',
      'wss://wss-primary.slack.com:444/', 'not a URL',
    ]) expect(() => validateEventSocketUrl(url)).toThrow();
  });

  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: string[] = [];
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  const profile: BrowserAuthConfig = {
    auth_type: 'browser', workspace_id: 'T123', workspace_name: 'acme', user_id: 'U123',
    workspace_url: 'https://acme.slack.com', xoxc_token: 'synthetic-token', xoxd_token: 'synthetic-cookie',
  };

  it('drives the actual library handshake and message path through injected offline transport', async () => {
    const sockets: FakeSocket[] = [];
    const received: unknown[] = [];
    let ready = 0;
    let gaps = 0;
    const failures: unknown[] = [];
    const transport = createBrowserEventTransport(profile, {
      ready(id) { expect(id).toBe('U123'); ready++; },
      frame(value) { received.push(value); },
      disconnected() { gaps++; },
      fatal(error) { failures.push(error); },
    }, new AbortController().signal, {
      fetch: async () => Response.json({ ok: true, team_id: 'T123', user_id: 'U123' }),
      createWebSocket(url, headers) {
        expect(url.startsWith('wss://wss-primary.slack.com/')).toBe(true);
        expect(headers.Cookie).toBe('d=synthetic-cookie');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await transport.start();
    expect(ready).toBe(0);
    sockets[0].emit('open');
    expect(ready).toBe(0);
    sockets[0].emit('message', '{"type":"hello"}');
    expect(ready).toBe(1);
    sockets[0].emit('message', '{"type":"message","channel":"C123","ts":"1712345678.123456","user":"U123","text":"hello"}');
    expect(received).toHaveLength(2);
    sockets[0].emit('unexpected-response', {}, { statusCode: 429, headers: { 'retry-after': '0.001' } });
    expect(gaps).toBe(1);
    await Bun.sleep(20);
    expect(sockets).toHaveLength(2);
    transport.stop();
    expect(sockets[1].readyState).toBe(3);
    expect(failures).toEqual([]);
  });

  it('surfaces expired browser credentials as a terminal typed failure without exposing server text', async () => {
    let failure: unknown;
    const transport = createBrowserEventTransport(profile, {
      ready() {}, frame() {}, disconnected() {}, fatal(error) { failure = error; },
    }, new AbortController().signal, {
      fetch: async () => Response.json({ ok: false, error: 'synthetic-private-error' }),
      createWebSocket() { throw new Error('must not connect'); },
    });
    await transport.start();
    expect(failure).toMatchObject({ code: 'invalid_auth' });
    expect(String(failure)).not.toContain('synthetic-private-error');
    expect(String(failure)).not.toContain('synthetic-token');
    transport.stop();
  });
  it('uses the shared limiter, manual redirects and bounded cancellation', async () => {
    let called = false;
    const fake = (async (_input: unknown, init?: RequestInit) => {
      called = true;
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ ok: true });
    });
    const request = eventFetch('https://acme.slack.com', new AbortController().signal, fake);
    await request('https://acme.slack.com/api/auth.test', { method: 'POST' });
    expect(called).toBe(true);
    called = false;
    await expect(request('https://evil.example/api/auth.test')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(called).toBe(false);
  });
  it('refuses redirects without exposing token-bearing URLs or Location', async () => {
    const request = eventFetch('https://acme.slack.com', new AbortController().signal,
      async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/?token=private' } }));
    try {
      await request('https://app.slack.com/auth?app=client&response_type=json');
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'permission_denied' });
      expect(String(error)).not.toContain('private');
    }
  });
});
