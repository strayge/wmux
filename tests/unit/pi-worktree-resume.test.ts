import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
const calls: Array<{ args: string[]; cb: (err: any, stdout: string, stderr: string) => void }> = [];
let hold = false;
let quitting = false;
let cliDelay = 0;
vi.mock('node:child_process', () => ({
  execFile: (_file: string, argv: string[], _opts: any, cb: any) => {
    const args = argv.slice(1);
    calls.push({ args, cb });
    if (!hold) {
      const finish = () => cb(null, JSON.stringify(deliver(args)), '');
      if (cliDelay) setTimeout(finish, cliDelay);
      else finish();
    }
    return { kill: () => {} };
  },
}));
import { getAgentState, resetAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { withClaudeResume, restoredPiCwd, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import type { SurfaceRef, SurfaceId, SplitLeaf, PaneId } from '../../src/shared/types';

const ROOT = path.resolve(__dirname, '../..');
const EXTENSION = path.join(ROOT, 'resources/pi-extension/wmux.js');
const SURFACE = 'surf-pi-worktree' as SurfaceId;
const A = 'session-A';
const B = 'session-B';
const CWD_A = 'C:/worktree A';
const CWD_B = '/home/user/worktree-B';
const SHELL_CWD = 'C:/shell-original';
const main = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
const guard = main.slice(main.indexOf("if ((request.method === 'pane.release_codex_session'"), main.indexOf('// Declared agent state (issue #128)'));
const quittingGuard = new Function('request', 'isQuitting', 'respond', `${guard}\nreturn false;`);
const flag = (args: string[], name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

/** Actual extension argv -> RPC -> main record, using the real quit guard. */
function deliver(args: string[]): any {
  let method: string;
  let params: Record<string, unknown>;
  if (args[0] === 'report-session') {
    method = 'pane.report_agent_session';
    params = { surfaceId: flag(args, '--surface'), provider: flag(args, '--provider'), sessionId: args[1], cwd: flag(args, '--cwd') };
  } else if (args[0] === 'release-agent') {
    method = 'pane.release_pi_session';
    params = { surfaceId: flag(args, '--surface'), sessionId: flag(args, '--session') };
  } else return {};
  let result: unknown;
  if (quittingGuard({ method, params }, quitting, (value: unknown) => { result = value; })) return result;
  expect(handleAgentStateV2(method, params, value => { result = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return result;
}
const leaf = (): SplitLeaf => ({ type: 'leaf', paneId: 'pane-pi' as PaneId, activeSurfaceIndex: 0,
  surfaces: [{ id: SURFACE, type: 'terminal', cwd: SHELL_CWD }] });
const saved = () => stampAgentSessionIds(leaf()).surfaces[0];
function spawn(surface: SurfaceRef, enabled = true, base?: string[], reattaching = false) {
  const commands = reattaching ? base : withClaudeResume({ base, surfaceId: SURFACE,
    claudeSessionId: surface.claudeSessionId, enabled: true,
    piSessionId: surface.piSessionId, piSessionCwd: surface.piSessionCwd, piEnabled: enabled,
  });
  return { commands, cwd: restoredPiCwd({ shellCwd: surface.cwd!, piSessionId: surface.piSessionId,
    piSessionCwd: surface.piSessionCwd, piEnabled: enabled, base, commands, reattaching }) };
}

let tmp: string;
const originalEnv = { ...process.env };
beforeEach(() => {
  resetAgentState(); resetResumedSurfaces(); calls.length = 0; hold = false; quitting = false; cliDelay = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-worktree-'));
  Object.assign(process.env, { WMUX: '1', WMUX_SURFACE_ID: SURFACE,
    WMUX_CLI: path.join(ROOT, 'dist/cli/wmux.js'), WMUX_NODE: process.execPath });
});
afterEach(() => {
  vi.useRealTimers();
  resetAgentState();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of ['WMUX', 'WMUX_SURFACE_ID', 'WMUX_CLI', 'WMUX_NODE']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});
function context(id: string, cwd: string, persisted = true) {
  const file = path.join(tmp, `${id}.jsonl`);
  if (persisted) fs.writeFileSync(file, JSON.stringify({ type: 'session', id, cwd }));
  return { cwd, ui: {} as Record<symbol, unknown>, sessionManager: {
    getSessionId: () => id, getSessionFile: () => persisted ? file : undefined,
  } };
}
async function extension() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  (await import(/* @vite-ignore */ EXTENSION)).default({ on: (name: string, fn: any) => handlers.set(name, fn) });
  return { fire: async (name: string, ctx: any, event: any = {}) => { await handlers.get(name)?.(event, ctx); } };
}

describe('pi worktree recovery: shipped extension -> main pair -> restored PTY cwd', () => {
  it('follows persistent A -> B -> A without rebind and updates same-ID cwd on tool events', async () => {
    const pi = await extension();
    const a = context(A, CWD_A); const b = context(B, CWD_B);
    await pi.fire('session_start', a);
    expect(saved()).toMatchObject({ piSessionId: A, piSessionCwd: CWD_A, cwd: SHELL_CWD });
    await pi.fire('tool_execution_start', b, { toolName: 'read' }); // no session_start or extension rebind
    expect(saved()).toMatchObject({ piSessionId: B, piSessionCwd: CWD_B, cwd: SHELL_CWD });
    expect(spawn(saved(), false).cwd).toBe(SHELL_CWD);
    expect(spawn(saved(), true, undefined, true).cwd).toBe(SHELL_CWD);
    expect(spawn(saved())).toEqual({ commands: [`pi --session ${B}`], cwd: CWD_B });
    await pi.fire('message_start', a);
    expect(saved()).toMatchObject({ piSessionId: A, piSessionCwd: CWD_A });
    a.cwd = 'C:/worktree A moved';
    await pi.fire('tool_execution_end', a, { toolName: 'read' });
    expect(saved()).toMatchObject({ piSessionId: A, piSessionCwd: a.cwd });
    expect(calls.filter(call => call.args[0] === 'report-session').map(call => [call.args[1], flag(call.args, '--cwd')]))
      .toEqual([[A, CWD_A], [B, CWD_B], [A, CWD_A], [A, a.cwd]]);
  });

  it('keeps both fields across normal rebind/reload and clears both for an unborn new session', async () => {
    const a = context(A, CWD_A); const b = context(B, CWD_B);
    const old = await extension();
    await old.fire('session_start', a);
    await old.fire('session_shutdown', a, { reason: 'fork' });
    const next = await extension();
    await next.fire('session_start', b, { reason: 'fork' });
    expect(saved()).toMatchObject({ piSessionId: B, piSessionCwd: CWD_B });
    await next.fire('session_shutdown', b, { reason: 'reload' });
    const reloaded = await extension();
    await reloaded.fire('session_start', b, { reason: 'reload' });
    expect(saved()).toMatchObject({ piSessionId: B, piSessionCwd: CWD_B });
    await reloaded.fire('session_start', context('unborn', '/worktree/new', false), { reason: 'new' });
    expect(saved()).toEqual(leaf().surfaces[0]);
    expect(getAgentState(SURFACE)?.piSessionCwd).toBeUndefined();
    expect(calls.some(call => call.args[0] === 'release-agent')).toBe(false);
  });

  it('snapshots queued A/B pairs while tool reports are pending and ignores stale callbacks after rebind', async () => {
    hold = true;
    const pi = await extension();
    const a = context(A, CWD_A); const b = context(B, CWD_B);
    await pi.fire('session_start', a);
    await pi.fire('tool_execution_start', a, { toolName: 'read' });
    await pi.fire('tool_execution_end', a, { toolName: 'edit' });
    await pi.fire('session_start', b);
    a.cwd = '/mutated-after-A-enqueue'; b.cwd = '/mutated-after-B-enqueue';
    const shutdown = pi.fire('session_shutdown', b, { reason: 'resume' });
    expect(calls).toHaveLength(1);
    const pairs: Array<[string, string | undefined]> = [];
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const result = deliver(call.args);
      if (call.args[0] === 'report-session') pairs.push([call.args[1], flag(call.args, '--cwd')]);
      call.cb(null, JSON.stringify(result), ''); // pumps exactly the next queued item
    }
    await shutdown;
    expect(pairs).toEqual([[A, CWD_A], [B, CWD_B]]);
    expect(saved()).toMatchObject({ piSessionId: B, piSessionCwd: CWD_B });
    hold = false;
    const next = await extension();
    await next.fire('session_start', context(B, CWD_B));
    calls[0].cb(null, '{"accepted":false}', ''); // late old process callback cannot rebind A
    expect(saved()).toMatchObject({ piSessionId: B, piSessionCwd: CWD_B });
  });

  it('does not let child sessions publish, unblock, release, or stop their parent queue', async () => {
    const pi = await extension();
    const parent = context(A, CWD_A); const child = context(B, CWD_B);
    child.ui[Symbol.for('pi-subagents:child-extension-ui')] = true;
    await pi.fire('session_start', parent);
    const count = calls.length;
    for (const name of ['session_start', 'agent_start', 'message_start', 'ui_prompt_start', 'ui_prompt_end',
      'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_settled', 'model_select', 'session_shutdown']) {
      await pi.fire(name, child, { reason: 'quit', toolName: 'edit', title: 'Child prompt' });
    }
    expect(calls).toHaveLength(count);
    expect(saved()).toMatchObject({ piSessionId: A, piSessionCwd: CWD_A });
    parent.cwd = 'C:/parent-moved';
    await pi.fire('message_start', parent);
    expect(saved()).toMatchObject({ piSessionId: A, piSessionCwd: parent.cwd });
    await pi.fire('session_shutdown', parent, { reason: 'quit' });
    expect(saved()).toEqual(leaf().surfaces[0]);
  });

  it('prioritizes the latest binding and clean quit over 25 healthy 100ms edit notifications', async () => {
    vi.useFakeTimers();
    cliDelay = 100;
    const pi = await extension();
    const a = context(A, CWD_A); const b = context(B, CWD_B);
    await pi.fire('session_start', a);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved()).toMatchObject({ piSessionId: A, piSessionCwd: CWD_A });
    const before = calls.length;
    for (let n = 0; n < 25; n++) await pi.fire('tool_execution_end', a, { toolName: 'edit' });
    // Collapse superseded queued bindings too, not only the telemetry backlog.
    await pi.fire('message_start', b);
    await pi.fire('message_start', a);
    await pi.fire('message_start', b);
    let settled = false;
    const quit = pi.fire('session_shutdown', b, { reason: 'quit' }).then(() => { settled = true; });
    await pi.fire('tool_execution_end', a, { toolName: 'edit' }); // cannot refill during drain
    await vi.advanceTimersByTimeAsync(350);
    expect(settled).toBe(true);
    await quit;
    expect(calls.slice(before).map(call => call.args[0])).toEqual(['hook', 'report-session', 'release-agent']);
    expect(calls[before + 1].args[1]).toBe(B);
    expect(flag(calls[before + 1].args, '--cwd')).toBe(CWD_B);
    expect(saved()).toEqual(leaf().surfaces[0]);
    calls[before].cb(null, '{"accepted":false}', ''); // old callback cannot revive it
    expect(saved()).toEqual(leaf().surfaces[0]);
  });

  it('preserves the pair during wmux quit but removes both after deliberate pi quit', async () => {
    const parent = context(A, CWD_A);
    const pi = await extension();
    await pi.fire('session_start', parent);
    const before = saved();
    quitting = true;
    await pi.fire('session_shutdown', parent, { reason: 'quit' });
    expect(saved()).toEqual(before);
    quitting = false;
    const next = await extension();
    await next.fire('session_start', parent);
    await next.fire('session_shutdown', parent, { reason: 'quit' });
    expect(saved()).toEqual(leaf().surfaces[0]);
  });
});
