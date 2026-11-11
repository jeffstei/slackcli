import { Command } from 'commander';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';
import { CliError, InvalidInputError } from '../lib/cli-errors.ts';
import { listenEvents, projectEvent } from '../lib/events.ts';
import { fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';

const HELP = {
  group: {
    summary: 'Stream browser-session Slack events',
    description: 'Opt-in unofficial browser-client event transport. No Slack app or app-level token is used.',
    examples: ['slackcli events listen --json --workspace acme'],
  },
  listen: {
    summary: 'Listen for live events as versioned JSONL',
    description: 'Keep a browser-session connection open. Emits protocol v1 JSON Lines, not one JSON document. Consumers must deduplicate and reconcile gaps.',
    examples: ['slackcli events listen --json', 'slackcli events listen --json --workspace acme'],
    json: 'JSONL: { protocol, version, workspace_id, stream_id, sequence, received_at, kind, ... }. See docs/user-guide/events.md.',
    jsonLines: true,
    browserOnly: true,
    fields: 'the event message',
    notes: [
      'Unofficial and opt-in: the browser protocol may change without notice. This is not official Socket Mode.',
      '--json is required. --fields projects message content only; envelope and message identity remain present.',
      'SIGINT/SIGTERM stop the listener. Expired sessions require reauthentication and a listener restart.',
    ],
  },
} satisfies Record<string, CommandHelp>;

function writeLine(record: unknown, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => done(new CliError('network', 'Event output cancelled.'));
    const timer = setTimeout(() => done(new CliError('network', 'Event output stalled; reconcile after reconnecting.')), 15_000);
    let settled = false;
    function done(error?: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(new CliError('network', 'Event output closed or stalled; reconcile after reconnecting.'));
      else resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
    process.stdout.write(JSON.stringify(record) + '\n', done);
  });
}

export function createEventsCommand(): Command {
  const events = describeCommand(new Command('events'), HELP.group);
  describeCommand(events.command('listen'), HELP.listen)
    .option('--workspace <id|name>', 'Stored browser workspace/profile to use')
    .option('--json', 'Output protocol v1 JSON Lines', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (options: { workspace?: string; json?: boolean; fields?: string }) => {
      const controller = new AbortController();
      let outputFailed = false;
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const pipeError = () => { outputFailed = true; controller.abort(); };
      process.stdout.on('error', pipeError);
      try {
        const fields = fieldsOption(options);
        if (!options.json) throw new InvalidInputError('events listen requires --json for its versioned JSONL protocol.');
        await listenEvents({
          workspace: options.workspace, signal: controller.signal,
          write: async (record) => writeLine(projectEvent(record, fields), controller.signal),
        });
        if (outputFailed) throw new CliError('network', 'Event output closed; reconcile after reconnecting.');
      } catch (error) {
        if (!controller.signal.aborted || outputFailed) failCommand(error, { json: options.json, context: 'Event listener failed' });
      } finally {
        controller.abort();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        process.stdout.removeListener('error', pipeError);
      }
    });
  return events;
}
