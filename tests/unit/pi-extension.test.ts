import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pluginNeedsUpdate } from '../../src/main/agent-plugin-file';
import { isValidPiSessionId } from '../../src/shared/pi-session';

/**
 * Issue #231 — the SHIPPED extension, not a copy of its logic.
 *
 * resources/pi-extension/wmux.js is installed verbatim into
 * ~/.pi/agent/extensions/, so the file itself is the contract. Loaded here for
 * the same reason the OpenCode plugin is (#187): that bug was one token
 * (`process.execPath`) and no test of a paraphrase would have caught it.
 */
const calls: Array<{ file: string; argv: string[]; opts: any; cb: any }> = [];
/** Set when a test wants to decide for itself when the CLI call finishes. */
let holdCallbacks = false;

vi.mock('node:child_process', () => ({
  execFile: (file: string, argv: string[], opts: any, cb: any) => {
    calls.push({ file, argv, opts, cb });
    if (!holdCallbacks && typeof cb === 'function') cb(null, '', '');
  },
}));

const EXTENSION = path.resolve(__dirname, '../../resources/pi-extension/wmux.js');
const OPENCODE_PLUGIN = path.resolve(__dirname, '../../resources/opencode-plugin/wmux.js');

const load = () => import(/* @vite-ignore */ EXTENSION);

const SURFACE = 'surf-1';
const CLI = 'C:\\wmux\\resources\\cli\\wmux.js';

/** Every wmux CLI invocation the extension made, as flat argv minus the script. */
const verbs = () => calls.map((c) => c.argv.slice(1));

type Handler = (event: any, ctx?: any) => any;

/** A stand-in for pi's ExtensionAPI that records what the extension subscribes to. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: { on: (name: string, fn: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } },
    handlers,
    fire: async (name: string, event: any = {}, ctx: any = {}) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
    has: (name: string) => handlers.has(name),
  };
}

async function extensionWith(env: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    WMUX: '1',
    WMUX_SURFACE_ID: SURFACE,
    WMUX_CLI: CLI,
    WMUX_NODE: process.execPath,
    ...env,
  });
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const factory = (await load()).default;
  const pi = fakePi();
  factory(pi.api);
  return pi;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  calls.length = 0;
  holdCallbacks = false;
});

afterEach(() => {
  for (const key of ['WMUX', 'WMUX_SURFACE_ID', 'WMUX_CLI', 'WMUX_NODE', 'WMUX_NODE_ELECTRON', 'PI_IMAGE_PROTOCOL']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.useRealTimers();
});

describe('#231 pi extension: activation', () => {
  it('is completely inert outside wmux', async () => {
    // pi loads global extensions for every session on the machine, including
    // ones started from a plain terminal. Registering handlers there would
    // spawn a CLI process per event for a wmux that is not running.
    const pi = await extensionWith({ WMUX: '0', PI_IMAGE_PROTOCOL: undefined });
    expect(pi.handlers.size).toBe(0);
    expect(calls).toEqual([]);
    expect(process.env.PI_IMAGE_PROTOCOL).toBeUndefined();
  });

  it('is inert with no surface id', async () => {
    const pi = await extensionWith({ WMUX_SURFACE_ID: undefined });
    expect(pi.handlers.size).toBe(0);
  });

  it('enables iTerm2 images during extension loading inside wmux', async () => {
    await extensionWith({ PI_IMAGE_PROTOCOL: undefined });
    expect(process.env.PI_IMAGE_PROTOCOL).toBe('iterm2');
    expect(calls).toEqual([]);
  });

  it.each(['none', 'kitty', 'auto', 'iterm2'])('preserves the explicit image protocol %s', async (protocol) => {
    await extensionWith({ PI_IMAGE_PROTOCOL: protocol });
    expect(process.env.PI_IMAGE_PROTOCOL).toBe(protocol);
  });

  it.each([1, 2, 3])('updates installed extension version %s through the version marker', (version) => {
    const source = fs.readFileSync(EXTENSION, 'utf8');
    expect(source).toMatch(/^\/\/ wmux-plugin-version: 4\r?\n/);
    expect(pluginNeedsUpdate(source, `// wmux-plugin-version: ${version}\nold source`)).toBe(true);
  });

  it('runs the CLI through WMUX_NODE, never the host binary (#187)', async () => {
    // pi also ships as a compiled single-executable binary, where
    // process.execPath is `pi` and handing it a .js file prints pi's help and
    // exits 1 — silently, which is how #187 survived a whole release line.
    const pi = await extensionWith();
    await pi.fire('agent_start');
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].argv[0]).toBe(CLI);
  });

  it('declares ELECTRON_RUN_AS_NODE when the runtime is wmux itself', async () => {
    const pi = await extensionWith({ WMUX_NODE_ELECTRON: '1' });
    await pi.fire('agent_start');
    expect(calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('#231 pi extension: run state', () => {
  it('states depth absolutely rather than incrementing a refcount', async () => {
    // The whole reason this is `--run-depth` and not `--run-start`/`--run-end`.
    // pi's own docs: agent_end "fires when that run ends, but Pi may still
    // auto-retry, auto-compact and retry, or continue with queued follow-up
    // messages" — so one settle can follow several starts. A refcount would
    // never return to zero and the pane would be pinned on "working", which is
    // the exact bug #231 reports, reintroduced one layer down.
    const pi = await extensionWith();
    await pi.fire('agent_start');
    await pi.fire('agent_start');
    await pi.fire('agent_start');
    await pi.fire('agent_settled');

    const depths = verbs().filter((v) => v.includes('--run-depth'));
    expect(depths.every((v) => v[0] === 'report-agent')).toBe(true);
    expect(depths[depths.length - 1].slice(-2)).toEqual(['--run-depth', '0']);
    expect(verbs().some((v) => v.includes('--run-start') || v.includes('--run-end'))).toBe(false);
  });

  it('does not call the pane idle on agent_end', async () => {
    // agent_end is deliberately not handled: pi may still retry or drain queued
    // follow-ups after it, so reporting idle there flickers the sidebar through
    // "done" in the middle of work that is still running.
    const pi = await extensionWith();
    expect(pi.has('agent_end')).toBe(false);
  });

  it('starts a restored session from a stated idle', async () => {
    // Both halves matter, and the unblock is the one a rebind needs: pi tears
    // the old extension instance down and stands a new one up around /new,
    // /resume, /fork and /reload, so this is the first chance the new instance
    // has to say the pane is no longer parked on anyone.
    const pi = await extensionWith();
    await pi.fire('session_start', { reason: 'resume' });
    expect(verbs()).toEqual([
      ['report-agent', '--surface', SURFACE, '--unblocked'],
      ['report-agent', '--surface', SURFACE, '--run-depth', '0'],
    ]);
  });
});

describe('#231 pi extension: parked on a human', () => {
  it('blocks on ui_prompt_start and unblocks on ui_prompt_end', async () => {
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'confirm', title: 'Overwrite config?' });
    expect(verbs()).toContainEqual([
      'report-agent', '--surface', SURFACE, '--blocked', 'Overwrite config?',
    ]);
    calls.length = 0;
    await pi.fire('ui_prompt_end', { kind: 'confirm' });
    expect(verbs()).toEqual([['report-agent', '--surface', SURFACE, '--unblocked']]);
  });

  it('falls back to the prompt kind when there is no title', async () => {
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'select' });
    expect(verbs()[0].slice(-1)).toEqual(['Waiting for your select']);
  });

  it('declares no choices it cannot know', async () => {
    // wmux's back-channel relays bytes the AGENT named; pi's ui_prompt_start
    // carries a kind and a title but never the options, so a choice invented
    // here would be a button that sends the wrong key.
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'select', title: 'Pick one' });
    expect(verbs().some((v) => v.includes('--choices'))).toBe(false);
  });

  it('clears unconditionally, without an instance-local blocked flag', async () => {
    // pi rebinds extensions across /new, /resume, /fork and /reload, so the
    // instance asked to clear a block is not always the one that declared it.
    // A flag guarding the clear would inherit `false` by being new and no-op,
    // stranding the pane on "Needs you" — the one failure that makes every
    // other pane's indicator untrustworthy too. This asserts the clear fires
    // from an instance that never saw the corresponding start.
    const pi = await extensionWith();
    await pi.fire('ui_prompt_end', { kind: 'confirm' });
    expect(verbs()).toEqual([['report-agent', '--surface', SURFACE, '--unblocked']]);
  });

  it('does not unblock on events that are not session or run boundaries', async () => {
    const pi = await extensionWith();
    await pi.fire('turn_end');
    await pi.fire('tool_execution_start', { toolName: 'bash' });
    await pi.fire('tool_execution_end', { toolName: 'bash' });
    expect(verbs().some((v) => v.includes('--unblocked'))).toBe(false);
  });

  it('self-heals through agent_start if an end is ever lost', async () => {
    // A new run cannot begin unless the human came back. It cannot fire
    // spuriously mid-prompt either: a prompt raised during a run is strictly
    // inside that run's already-emitted agent_start.
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'input', title: 'Name?' });
    calls.length = 0;
    await pi.fire('agent_start');
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
  });

  it('does not treat tool activity as an answer (#189)', async () => {
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'confirm', title: 'Run it?' });
    calls.length = 0;
    await pi.fire('tool_execution_start', { toolName: 'bash' });
    await pi.fire('tool_execution_end', { toolName: 'bash' });
    expect(verbs().some((v) => v.includes('--unblocked'))).toBe(false);
  });
});

describe('#231 pi extension: activity and metadata', () => {
  it('throttles activity pings so a parallel tool batch is one spawn', async () => {
    const pi = await extensionWith();
    await pi.fire('tool_execution_start', { toolName: 'read' });
    await pi.fire('tool_execution_start', { toolName: 'read' });
    await pi.fire('tool_execution_start', { toolName: 'grep' });
    expect(verbs().filter((v) => v[0] === 'agent-activity')).toEqual([
      ['agent-activity', '--surface', SURFACE, '--active', '--tool', 'read'],
    ]);
  });

  it('refreshes the diff view only for tools that can have changed the tree', async () => {
    const pi = await extensionWith();
    for (const toolName of ['read', 'ls', 'grep', 'find']) {
      await pi.fire('tool_execution_end', { toolName });
    }
    expect(verbs().some((v) => v[0] === 'hook')).toBe(false);

    await pi.fire('tool_execution_end', { toolName: 'edit' });
    expect(verbs()).toContainEqual(['hook', '--event', 'PostToolUse', '--tool', 'edit']);
  });

  it('treats an unknown tool as possibly mutating', async () => {
    // A denylist is right here: an unknown tool is most likely a user-registered
    // one doing who-knows-what, and a spurious refresh costs a coalesced git
    // call while a missed one leaves the panel stale.
    const pi = await extensionWith();
    await pi.fire('tool_execution_end', { toolName: 'deploy_to_prod' });
    expect(verbs()).toContainEqual(['hook', '--event', 'PostToolUse', '--tool', 'deploy_to_prod']);
  });

  it('reports model and context usage', async () => {
    const pi = await extensionWith();
    await pi.fire('turn_end', {}, {
      model: { provider: 'anthropic', id: 'claude-opus-5' },
      getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21.4 }),
    });
    const meta = verbs().find((v) => v[0] === 'report-metadata');
    expect(meta).toEqual([
      'report-metadata', '--surface', SURFACE,
      '--model', 'anthropic/claude-opus-5',
      '--tokens', '42000',
      '--context-pct', '21',
      '--ttl', '600000',
    ]);
  });

  it('omits what pi does not know rather than overwriting it with a placeholder', async () => {
    // tokens and percent are independently nullable in pi — they go null right
    // after a compaction, before the next response re-establishes them. An
    // omitted flag leaves the previous value standing, which beats replacing a
    // real number with a guess.
    const pi = await extensionWith();
    await pi.fire('turn_end', {}, {
      model: { provider: 'openai', id: 'gpt-x' },
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    });
    const meta = verbs().find((v) => v[0] === 'report-metadata');
    expect(meta).toEqual([
      'report-metadata', '--surface', SURFACE, '--model', 'openai/gpt-x', '--ttl', '600000',
    ]);
  });

  it('sends nothing at all when there is nothing to say', async () => {
    const pi = await extensionWith();
    await pi.fire('turn_end', {}, { getContextUsage: () => undefined });
    expect(verbs().some((v) => v[0] === 'report-metadata')).toBe(false);
  });

  it('survives a ctx that throws', async () => {
    const pi = await extensionWith();
    await expect(pi.fire('turn_end', {}, {
      model: { id: 'local' },
      getContextUsage: () => { throw new Error('no session'); },
    })).resolves.toBeUndefined();
    expect(verbs().find((v) => v[0] === 'report-metadata')).toEqual([
      'report-metadata', '--surface', SURFACE, '--model', 'local', '--ttl', '600000',
    ]);
  });
});

describe('#231 pi extension: shutdown', () => {
  it('releases the pane and waits for the call to land', async () => {
    // pi awaits session_shutdown handlers and then exits. Without the wait the
    // process can be gone before the spawn lands, leaving a pane declared
    // "working" with nothing alive left to correct it.
    holdCallbacks = true;
    const pi = await extensionWith();
    let settled = false;
    const pending = pi.fire('session_shutdown', { reason: 'quit' }).then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(verbs()).toEqual([['release-agent', '--provider', 'pi', '--session', '', '--surface', SURFACE]]);

    calls[0].cb(null, '', '');
    await pending;
    expect(settled).toBe(true);
  });

  it('gives up rather than hanging pi\'s exit on a wedged wmux', async () => {
    holdCallbacks = true;
    vi.useFakeTimers();
    const pi = await extensionWith();
    const pending = pi.fire('session_shutdown', { reason: 'quit' });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('pi extension: conversation lifetime', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-extension-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const ctx = (id: string, file?: string) => ({ sessionManager: {
    getSessionId: () => id, getSessionFile: () => file,
  } });
  const persisted = (id: string) => {
    const file = path.join(tmp, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id }));
    return ctx(id, file);
  };
  const sessions = () => verbs().filter(v => v[0] === 'report-session');

  it('reports a persisted session with provider pi, deduping repeated lifecycle events', async () => {
    const pi = await extensionWith({ PI_IMAGE_PROTOCOL: undefined });
    const current = persisted('custom_session.1');
    for (const event of ['session_start', 'agent_start', 'message_start', 'turn_end', 'agent_settled']) {
      await pi.fire(event, {}, current);
    }
    expect(sessions()).toEqual([['report-session', 'custom_session.1', '--provider', 'pi', '--surface', SURFACE]]);
    expect(process.env.PI_IMAGE_PROTOCOL).toBe('iterm2');
    expect(calls.every(c => !c.opts.shell && !c.file.endsWith('.cmd'))).toBe(true);
  });

  it('does not capture unborn/ephemeral IDs but retries after the user message is persisted', async () => {
    const pi = await extensionWith();
    const file = path.join(tmp, 'unborn.jsonl');
    const current = ctx('unborn', file);
    await pi.fire('session_start', { reason: 'new' }, current);
    await pi.fire('agent_start', {}, current);
    expect(sessions().map(v => v[1])).toEqual(['']);
    expect(verbs().some(v => v.includes('--run-depth'))).toBe(true);
    // pi persists the user message after message_end. The assistant's following
    // message_start can then report a durable conversation without a token timer.
    fs.writeFileSync(file, '{}');
    await pi.fire('message_start', { message: { role: 'assistant' } }, current);
    await pi.fire('turn_end', {}, current);
    expect(sessions().map(v => v[1])).toEqual(['', 'unborn']);
    await pi.fire('session_start', { reason: 'new' }, ctx('ephemeral'));
    expect(sessions().map(v => v[1])).toEqual(['', 'unborn', '']);
  });

  it('rebinds A -> B -> A rather than remembering every ID ever seen', async () => {
    const pi = await extensionWith();
    const a = persisted('session-A'); const b = persisted('session-B');
    await pi.fire('session_start', {}, a);
    await pi.fire('session_start', {}, b);
    await pi.fire('session_start', {}, a);
    expect(sessions().map(v => v[1])).toEqual(['session-A', 'session-B', 'session-A']);
  });

  it.each(['new', 'resume', 'fork', 'reload'])('does not release on %s shutdown and new runtime binds its current session', async reason => {
    const old = await extensionWith();
    const a = persisted('session-A');
    await old.fire('session_start', {}, a);
    await old.fire('session_shutdown', { reason }, a);
    const next = await extensionWith();
    await next.fire('session_start', { reason }, reason === 'reload' ? a : ctx('unborn'));
    expect(verbs().some(v => v[0] === 'release-agent')).toBe(false);
    expect(sessions().map(v => v[1])).toEqual(['session-A', reason === 'reload' ? 'session-A' : '']);
  });

  it('serializes slow reports before session switches and quit release', async () => {
    holdCallbacks = true;
    const pi = await extensionWith();
    const a = persisted('session-A'); const b = persisted('session-B');
    await pi.fire('message_start', {}, a);
    await pi.fire('message_start', {}, b);
    expect(sessions().map(v => v[1])).toEqual(['session-A']);
    let settled = false;
    const pending = pi.fire('session_shutdown', { reason: 'quit' }, b).then(() => { settled = true; });
    calls[0].cb(null, '{"accepted":true}', '');
    expect(sessions().map(v => v[1])).toEqual(['session-A', 'session-B']);
    calls[1].cb(null, '{"accepted":true}', '');
    expect(verbs()[2]).toEqual(['release-agent', '--provider', 'pi', '--session', 'session-B', '--surface', SURFACE]);
    expect(settled).toBe(false);
    calls[2].cb(null, '{"released":true}', '');
    await pending;
    expect(settled).toBe(true);
  });

  it.each([new Error('spawn failed'), null])('retries failed or rejected report rather than permanently deduping it', async error => {
    holdCallbacks = true;
    const pi = await extensionWith(); const a = persisted('session-A');
    await pi.fire('message_start', {}, a);
    calls[0].cb(error, '{"accepted":false}', '');
    await pi.fire('message_start', {}, a);
    expect(sessions().map(v => v[1])).toEqual(['session-A', 'session-A']);
    calls[1].cb(null, '{"accepted":true}', '');
  });

  it('a timed-out shutdown ignores late callbacks and never sends queued stale reports', async () => {
    holdCallbacks = true;
    vi.useFakeTimers();
    const pi = await extensionWith();
    await pi.fire('session_start', {}, persisted('session-A'));
    const pending = pi.fire('session_shutdown', { reason: 'reload' });
    await vi.advanceTimersByTimeAsync(2100);
    await pending;
    const count = calls.length;
    for (const call of calls) call.cb(null, '{"accepted":true}', '');
    await pi.fire('message_start', {}, persisted('session-B'));
    expect(calls.length).toBe(count);
  });

  it.each(['unsafe&calc', 'a.jsonl', 'A.JsOnL'])('refuses unsafe or path-interpreted custom ID %s', async id => {
    const pi = await extensionWith();
    await pi.fire('session_start', {}, persisted(id));
    expect(sessions().map(v => v[1])).toEqual(['']);
  });

  it('uses the same ID boundary as main/renderer, including trailing shell newlines', async () => {
    const file = path.join(tmp, 'session.jsonl');
    fs.writeFileSync(file, '{}');
    for (const id of ['a', 'A_b.C-1', 'a'.repeat(128), 'a'.repeat(129), '-a', 'a.',
      'x.jsonl', 'X.JSONL', 'a\n', 'a\r', 'a\u2028', 'a\u2029', 'a&calc', 'a b', 'a/b', 'a%PATH%']) {
      calls.length = 0;
      const pi = await extensionWith();
      await pi.fire('message_start', {}, ctx(id, file));
      expect(sessions()[0][1], JSON.stringify(id)).toBe(isValidPiSessionId(id) ? id : '');
    }
  });

  it('still releases the reported ID if its transcript is deleted before deliberate quit', async () => {
    const pi = await extensionWith();
    const current = persisted('session-A');
    await pi.fire('message_start', {}, current);
    fs.unlinkSync(current.sessionManager.getSessionFile()!);
    await pi.fire('session_shutdown', { reason: 'quit' }, current);
    expect(verbs().at(-1)).toEqual(['release-agent', '--provider', 'pi', '--session', 'session-A', '--surface', SURFACE]);
  });

});

describe('#231 pi extension: the copied runtime resolver', () => {
  it('agrees with the OpenCode plugin it was copied from', async () => {
    // Both files are installed verbatim as a SINGLE file into another program's
    // config directory, so there is nowhere shared to import from and the
    // duplication is forced. A duplicate with no enforcement is a time bomb
    // (#137, #168) — so it is pinned here instead.
    const piResolve = (await load()).default.__wmuxInternals.resolveNodeRuntime;
    const ocResolve = (await import(/* @vite-ignore */ OPENCODE_PLUGIN))
      .WmuxPlugin.__wmuxInternals.resolveNodeRuntime;

    const cases: Array<[Record<string, string>, string, NodeJS.Platform]> = [
      [{ WMUX_NODE: process.execPath }, '/opt/pi/pi', 'linux'],
      [{ WMUX_NODE: process.execPath, WMUX_NODE_ELECTRON: '1' }, '/opt/pi/pi', 'linux'],
      [{ WMUX_NODE: '/definitely/not/here/node' }, process.execPath, 'linux'],
      [{}, '/usr/local/bin/pi', 'linux'],
      [{}, 'C:\\pi\\pi.exe', 'win32'],
    ];
    for (const [env, execPath, platform] of cases) {
      const exists = (p: string) => p === process.execPath;
      expect(piResolve(env, execPath, platform, exists))
        .toEqual(ocResolve(env, execPath, platform, exists));
    }
  });
});
