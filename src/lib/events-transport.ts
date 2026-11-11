import { GabrielCore, GabrielError, silentLogger, type WebSocketFactory } from 'gabriel-slack';
import WebSocket from 'ws';
import type { WorkspaceConfig } from '../types/index.ts';
import { slackWorkspaceOrigin } from './browser-auth.ts';
import { CliError, InvalidInputError, UnsupportedAuthTypeError } from './cli-errors.ts';
import { SlackAuthError, authErrorProfile } from './auth-errors.ts';
import { slackRateLimiter } from './rate-limiter.ts';
import { MAX_EVENT_BYTES, type EventTransport, type TransportCallbacks } from './events.ts';

/** Reconnect tickets are server input, not permission to send cookies anywhere. */
export function validateEventSocketUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new InvalidInputError('Invalid Slack event gateway.'); }
  if (url.protocol !== 'wss:' || !/^wss-(?:primary|backup)\.slack\.com$/.test(url.hostname)
    || url.username || url.password || url.port || url.hash) {
    throw new InvalidInputError('Refused a non-Slack event gateway.');
  }
}

type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function eventFetch(
  origin: string, signal: AbortSignal, realFetch: FetchRequest = fetch,
): typeof fetch {
  const request: FetchRequest = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const exchange = url.origin === 'https://app.slack.com' && url.pathname === '/auth';
    const verify = url.origin === origin && url.pathname === '/api/auth.test';
    if ((!exchange && !verify) || url.username || url.password || url.hash) {
      throw new CliError('permission_denied', 'Refused a credential-bearing event request to an unexpected destination.');
    }
    return slackRateLimiter.run(async () => {
      let response: Response;
      try {
        response = await realFetch(input, {
          ...init, redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
        });
      } catch {
        throw new CliError('network', 'Slack event authentication request failed.');
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new CliError('permission_denied', 'Refused a Slack event authentication redirect.');
      }
      return response;
    });
  };
  return Object.assign(request, { preconnect: fetch.preconnect });
}

export function createBrowserEventTransport(
  config: WorkspaceConfig, callbacks: TransportCallbacks, signal: AbortSignal,
  dependencies: { fetch?: FetchRequest; createWebSocket?: WebSocketFactory } = {},
): EventTransport {
  if (config.auth_type !== 'browser') throw new UnsupportedAuthTypeError('Event streaming requires browser authentication.');
  const origin = slackWorkspaceOrigin(config.workspace_url);
  if (!origin) throw new InvalidInputError('Event streaming requires a valid HTTPS Slack workspace origin.');
  let core: GabrielCore | undefined;
  let stopped = false;
  const sockets = new Set<WebSocket>();
  const removers: Array<() => void> = [];
  const fail = (error: unknown) => {
    if (stopped) return;
    const mapped = error instanceof CliError || error instanceof SlackAuthError ? error
      : error instanceof GabrielError && error.code === 'AUTH_DEAD'
        ? new SlackAuthError('invalid_auth', authErrorProfile(config))
        : new CliError('network', 'Slack browser event transport failed; restart and reconcile the gap.');
    callbacks.fatal(mapped);
  };
  const createWebSocket: WebSocketFactory = (url, headers) => {
    try { validateEventSocketUrl(url); } catch (error) { fail(error); throw error; }
    if (dependencies.createWebSocket) return dependencies.createWebSocket(url, headers);
    const socket = new WebSocket(url, {
      headers, followRedirects: false, perMessageDeflate: false,
      maxPayload: MAX_EVENT_BYTES, handshakeTimeout: 15_000,
    });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new CliError('network', 'Invalid Slack event frame.');
        }
      } catch {
        fail(new CliError('network', 'Slack sent an invalid event frame; reconcile the gap.'));
      }
    });
    return socket;
  };
  return {
    async start() {
      if (signal.aborted || stopped) return;
      core = new GabrielCore({
        auth: {
          cookieD: config.xoxd_token, token: config.xoxc_token,
          workspace: new URL(origin).hostname.split('.')[0],
          allowedTeams: [config.workspace_id],
        },
        endpoints: { workspaceApiBase: `${origin}/` },
        fetch: eventFetch(origin, signal, dependencies.fetch),
        createWebSocket,
        // Even partially redacted credentials and raw server errors are not our log policy.
        logger: silentLogger,
      });
      removers.push(
        core.onHello(({ epoch }) => {
          if (stopped || !core) return;
          if (core.session.teamId !== config.workspace_id
            || (config.user_id && core.session.userId !== config.user_id)) {
            fail(new CliError('auth_failed', 'Event authentication resolved a different workspace or user.'));
            return;
          }
          callbacks.ready(core.session.userId);
          core.ws.markReady(false, epoch);
        }),
        core.onRawFrame((frame) => { if (!stopped) callbacks.frame(frame); }),
        core.ws.on('reconnecting', () => { if (!stopped) callbacks.disconnected(); }),
        core.ws.on('state', (state) => {
          if (state === 'AUTH_DEAD') fail(new SlackAuthError('invalid_auth', authErrorProfile(config)));
        }),
      );
      try { await core.connect(); } catch (error) { fail(error); }
      if (signal.aborted) this.stop();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const remove of removers) remove();
      core?.disconnect();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
    },
  };
}
