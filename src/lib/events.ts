import { createHash, randomUUID } from 'node:crypto';
import { getLogger } from '@logtape/logtape';
import type { WorkspaceConfig } from '../types/index.ts';
import { CliError, InvalidInputError, NotFoundError, UnsupportedAuthTypeError } from './cli-errors.ts';
import { getWorkspaceEntry } from './workspaces.ts';
import { applyFields, type FieldPaths } from './json-fields.ts';

export const EVENT_PROTOCOL = 'slackcli.events';
export const EVENT_PROTOCOL_VERSION = 1;
export const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 4 * MAX_EVENT_BYTES;
const logger = getLogger(['slackcli', 'events']);

export interface StreamMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  client_msg_id?: string;
  subtype?: string;
}

export interface MessageEvent {
  kind: 'message';
  event_id: string;
  channel_id: string;
  operation: 'create' | 'edit' | 'delete';
  message: StreamMessage;
}

export type EventPayload = MessageEvent
  | { kind: 'ready'; user_id: string; generation: number }
  | { kind: 'gap'; reason: string; generation: number; since: string | null }
  | { kind: 'status'; state: string };

export type EventRecord = EventPayload & {
  protocol: typeof EVENT_PROTOCOL;
  version: typeof EVENT_PROTOCOL_VERSION;
  workspace_id: string;
  stream_id: string;
  sequence: number;
  received_at: string;
};

export function projectEvent(record: EventRecord, fields?: FieldPaths): EventRecord {
  if (record.kind !== 'message' || !fields) return record;
  const projected = applyFields('events listen', record, fields);
  const content = object(projected.message) ? projected.message : {};
  return {
    ...record,
    message: {
      ...content, ts: record.message.ts, user: record.message.user,
      thread_ts: record.message.thread_ts, client_msg_id: record.message.client_msg_id,
    },
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{10,}\.\d{6}$/.test(value);
}

/** Project only stable message fields, never an arbitrary credential-bearing frame. */
export function normalizeMessage(frame: unknown): MessageEvent | null {
  if (!object(frame) || frame.type !== 'message') return null;
  if (typeof frame.channel !== 'string' || !/^[CDG][A-Z0-9]+$/.test(frame.channel)) {
    throw new CliError('network', 'Slack sent a message without a valid channel identity.');
  }
  const operation = frame.subtype === 'message_changed' || frame.subtype === 'message_replied' ? 'edit'
    : frame.subtype === 'message_deleted' ? 'delete' : 'create';
  const source = operation === 'edit' ? frame.message : frame;
  if (!object(source)) throw new CliError('network', 'Slack sent an invalid message operation.');
  const ts = operation === 'delete' ? frame.deleted_ts : source.ts;
  if (!timestamp(ts)) throw new CliError('network', 'Slack sent an invalid message timestamp.');
  const message: StreamMessage = { ts };
  for (const key of ['user', 'text', 'thread_ts', 'client_msg_id', 'subtype'] as const) {
    if (typeof source[key] === 'string') message[key] = source[key];
  }
  if (message.thread_ts !== undefined && !timestamp(message.thread_ts)) {
    throw new CliError('network', 'Slack sent an invalid thread timestamp.');
  }
  // Edits have their own revision identity; create identity survives live/history overlap.
  const revision = operation === 'edit'
    ? (object(source.edited) && timestamp(source.edited.ts) ? source.edited.ts : frame.event_ts)
    : operation === 'delete' ? frame.event_ts : undefined;
  const identity = JSON.stringify([frame.channel, ts, operation, revision ?? null, operation === 'edit' ? message.text : null]);
  return {
    kind: 'message', operation, channel_id: frame.channel, message,
    event_id: createHash('sha256').update(identity).digest('hex'),
  };
}

export interface EventTransport {
  start(): Promise<void>;
  stop(): void;
}

export interface TransportCallbacks {
  ready(userId: string): void;
  frame(frame: unknown): void;
  disconnected(): void;
  fatal(error: unknown): void;
}

export type TransportFactory = (
  config: WorkspaceConfig, callbacks: TransportCallbacks, signal: AbortSignal,
) => EventTransport;

export interface ListenOptions {
  workspace?: string;
  signal: AbortSignal;
  write(record: EventRecord): Promise<void>;
  load?: typeof getWorkspaceEntry;
  transport?: TransportFactory;
  now?: () => Date;
}

/** One connection owns the credentials; consumers receive only projected records. */
export async function listenEvents(options: ListenOptions): Promise<void> {
  const load = options.load ?? getWorkspaceEntry;
  const selected = await load(options.workspace ?? process.env.SLACKCLI_WORKSPACE);
  if (!selected) throw new NotFoundError('No stored Slack workspace selected. Authenticate first.');
  if (selected.config.auth_type !== 'browser') {
    throw new UnsupportedAuthTypeError('Event streaming requires a stored browser-session profile.');
  }
  if (process.platform === 'win32' && selected.config.secret_backend !== 'dpapi') {
    throw new CliError('permission_denied', 'Windows event streaming requires DPAPI-protected credentials.',
      'Run "slackcli auth migrate-secrets --to dpapi --profile <profile>" before starting the listener.');
  }
  const workspaceId = selected.config.workspace_id;
  const expectedUser = selected.config.user_id;
  const now = options.now ?? (() => new Date());
  const streamId = randomUUID();
  let sequence = 0;
  let generation = 0;
  let lastReceived: string | null = null;
  let queuedBytes = 0;
  let queuedRecords = 0;
  let stopped = false;
  let transport: EventTransport | undefined;
  let queue = Promise.resolve();
  const controller = new AbortController();
  let complete!: () => void;
  let fail!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  // Attach before transport callbacks can fail synchronously.
  void finished.catch(() => {});
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    transport?.stop();
  };
  const fatal = (error: unknown) => { stop(); fail(error); };
  const enqueue = (payload: EventPayload) => {
    if (stopped) return;
    const record: EventRecord = {
      ...payload, protocol: EVENT_PROTOCOL, version: EVENT_PROTOCOL_VERSION,
      workspace_id: workspaceId, stream_id: streamId, sequence: ++sequence,
      received_at: now().toISOString(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (bytes > MAX_EVENT_BYTES || queuedBytes + bytes > MAX_QUEUED_BYTES || queuedRecords >= 256) {
      fatal(new CliError('network', 'Event output exceeded its bounded buffer; reconnect and reconcile the gap.'));
      return;
    }
    queuedBytes += bytes;
    queuedRecords++;
    queue = queue.then(async () => {
      await options.write(record);
      queuedBytes -= bytes;
      queuedRecords--;
    }).catch(fatal);
  };
  const abort = () => { stop(); complete(); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal.aborted) return;
    const factory = options.transport ?? (await import('./events-transport.ts')).createBrowserEventTransport;
    transport = factory(selected.config, {
      ready(userId) {
        if (stopped) return;
        if (!/^[UW][A-Z0-9]+$/.test(userId) || (expectedUser && userId !== expectedUser)) {
          fatal(new CliError('auth_failed', 'The event stream identity differs from the selected profile.'));
          return;
        }
        generation++;
        enqueue({ kind: 'gap', reason: generation === 1 ? 'startup' : 'reconnect', generation, since: lastReceived });
        enqueue({ kind: 'ready', user_id: userId, generation });
        logger.info('Event transport ready for {workspace_id}, generation {generation}', { workspace_id: workspaceId, generation });
      },
      frame(frame) {
        if (stopped) return;
        try {
          const message = normalizeMessage(frame);
          if (!message) return;
          if (generation === 0) throw new CliError('network', 'Slack sent a message before readiness.');
          enqueue(message);
          lastReceived = now().toISOString();
        } catch (error) { fatal(error); }
      },
      disconnected() {
        enqueue({ kind: 'gap', reason: 'disconnect', generation, since: lastReceived });
        enqueue({ kind: 'status', state: 'reconnecting' });
      },
      fatal,
    }, controller.signal);
    await transport.start();
    await finished;
    await queue;
  } finally {
    stop();
    options.signal.removeEventListener('abort', abort);
  }
}

export function validateClientMessageId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidInputError('--client-message-id must be a UUID.');
  }
  return value;
}
