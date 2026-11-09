import { describe, it, expect, vi } from 'vitest';
import { ensureStartedSession, releaseAgentSession, type AgentBrowserStartupDeps } from '../../src/main/agent-browser-runtime';
import { SessionRegistry } from '../../src/main/agent-browser-session';
import type { SurfaceId } from '../../src/shared/types';

const ID = 'surf-startup' as SurfaceId;
const ok = { ok: true, spawnFailed: false, data: null, stdout: '', stderr: '' };
function harness() {
  const registry = new SessionRegistry();
  const probe = vi.fn(async () => true);
  const run = vi.fn(async (_binary: string, _argv: string[], _env?: NodeJS.ProcessEnv) => ok);
  const captureArgs = vi.fn(() => ['--args', '--force-device-scale-factor=2']);
  const deps: AgentBrowserStartupDeps = { binary: () => 'native.exe', run, captureArgs,
    ensureSession: (id) => registry.ensureBindable(id, probe), getSession: (id) => registry.get(id), releaseSession: (id) => registry.release(id) };
  return { registry, probe, run, captureArgs, deps };
}

describe('shared UI/CLI startup', () => {
  it.each(['CLI', 'UI'])('%s-first joins one bindable startup and never reopens an enabled session', async (first) => {
    const h = harness();
    const initial = first === 'CLI' ? undefined : 'https://fixture.test/initial';
    const a = ensureStartedSession(ID, initial, h.deps);
    const b = ensureStartedSession(ID, 'https://fixture.test/stale-ui-url', h.deps);
    expect(a).toBe(b);
    const session = await a;
    expect(await b).toBe(session);
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledWith('native.exe',
      ['--session', session.sessionName, '--pin-tab', '--args', '--force-device-scale-factor=2', 'open', ...(initial ? [initial] : [])],
      { AGENT_BROWSER_STREAM_PORT: String(session.streamPort), AGENT_BROWSER_STREAM_QUALITY: '95',
        AGENT_BROWSER_STREAM_MAX_WIDTH: '16384', AGENT_BROWSER_STREAM_MAX_HEIGHT: '16384' });
    h.captureArgs.mockImplementation(() => { throw new Error('must not reread capture configuration'); });
    await ensureStartedSession(ID, 'https://fixture.test/never-reopen', h.deps);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.captureArgs).toHaveBeenCalledOnce();
  });

  it('does not confuse allocation with a successfully started browser', async () => {
    const h = harness();
    h.registry.ensure(ID);
    h.run.mockResolvedValueOnce({ ...ok, ok: false, stderr: 'Chrome failed' });
    await expect(ensureStartedSession(ID, undefined, h.deps)).rejects.toThrow('Chrome failed');
    await ensureStartedSession(ID, undefined, h.deps);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('renews a cancelled allocation only after its cleanup without overlapping launches', async () => {
    const h = harness();
    let allocated!: () => void;
    const gate = new Promise<void>((resolve) => { allocated = resolve; });
    h.deps.ensureSession = async (id) => { await gate; return h.registry.ensure(id); };
    const first = ensureStartedSession(ID, undefined, h.deps);
    await Promise.resolve();
    releaseAgentSession(ID);
    const renewed = ensureStartedSession(ID, 'https://fixture.test/renewed', h.deps);
    expect(renewed).not.toBe(first);
    expect(h.run).not.toHaveBeenCalled();
    allocated();
    await expect(first).rejects.toThrow('cancelled');
    const session = await renewed;
    expect(h.registry.get(ID)).toBe(session);
    expect(h.run).toHaveBeenCalledExactlyOnceWith('native.exe',
      ['--session', session.sessionName, '--pin-tab', '--args', '--force-device-scale-factor=2', 'open', 'https://fixture.test/renewed'],
      { AGENT_BROWSER_STREAM_PORT: String(session.streamPort), AGENT_BROWSER_STREAM_QUALITY: '95',
        AGENT_BROWSER_STREAM_MAX_WIDTH: '16384', AGENT_BROWSER_STREAM_MAX_HEIGHT: '16384' });
  });

  it('does not launch a renewal that was itself cancelled while awaiting predecessor cleanup', async () => {
    const h = harness();
    let allocated!: () => void;
    const gate = new Promise<void>((resolve) => { allocated = resolve; });
    h.deps.ensureSession = async (id) => { await gate; return h.registry.ensure(id); };
    const first = ensureStartedSession(ID, undefined, h.deps);
    await Promise.resolve();
    releaseAgentSession(ID);
    const renewed = ensureStartedSession(ID, undefined, h.deps);
    releaseAgentSession(ID);
    allocated();
    await expect(first).rejects.toThrow('cancelled');
    await expect(renewed).rejects.toThrow('cancelled');
    expect(h.registry.get(ID)).toBeUndefined();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('waits for an old native launch and close before opening the renewed session', async () => {
    const h = harness();
    let finishOpen!: (value: typeof ok) => void;
    let finishClose!: (value: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
    const first = ensureStartedSession(ID, undefined, h.deps);
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce());
    releaseAgentSession(ID);
    h.registry.release(ID);
    const renewed = ensureStartedSession(ID, undefined, h.deps);
    finishOpen(ok);
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    expect(h.run.mock.calls[1][1].at(-1)).toBe('close');
    finishClose(ok);
    await expect(first).rejects.toThrow('cancelled');
    await renewed;
    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.run.mock.calls[2][1]).toContain('open');
  });

  it('keeps separate surfaces separate and rejects URL-shaped argv injection', async () => {
    const h = harness();
    await expect(ensureStartedSession(ID, '--executable-path=bad', h.deps)).rejects.toThrow('Invalid');
    const [a, b] = await Promise.all([ensureStartedSession(ID, undefined, h.deps), ensureStartedSession('surf-other' as SurfaceId, undefined, h.deps)]);
    expect(a.sessionName).not.toBe(b.sessionName);
    expect(a.streamPort).not.toBe(b.streamPort);
  });
});
