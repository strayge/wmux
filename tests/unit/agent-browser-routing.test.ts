import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { engineOf } from '../../src/shared/types';
import { browserRequest } from '../../src/cli/wmux';
import type { SurfaceRef } from '../../src/shared/types';

/**
 * Mutable fakes for the three things v2-browser reaches out to: Electron's
 * windows, the CDP bridge (which lives in ipc-handlers, a module that pulls in
 * node-pty and most of the main process at import time), and the agent-browser
 * runtime singletons. Hoisted so the `vi.mock` factories can close over them.
 */
const env = vi.hoisted(() => ({
  windows: [] as any[],
  focusedWindow: undefined as any,
  wcIdBySurface: new Map<string, number>(),
  acquired: [] as string[],
  /** Swappable so a test can make the dashboard hang or fail. */
  acquireImpl: async (_surfaceId: string): Promise<void> => {},
  startImpl: undefined as ((surfaceId: string) => Promise<any>) | undefined,
  nativeCalls: [] as Array<{ argv: string[]; timeoutMs: number }>,
  nativeImpl: async (_argv: string[], _timeoutMs: number): Promise<any> => ({ ok: true, data: null, stdout: '', stderr: '' }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => env.windows,
    getFocusedWindow: () => env.focusedWindow === undefined ? env.windows[0] ?? null : env.focusedWindow,
  },
}));
vi.mock('../../src/main/ipc-handlers', () => ({
  cdpBridge: {
    wcIdForSurface: (id: string) => env.wcIdBySurface.get(id) ?? null,
    get isAttached() { return env.wcIdBySurface.size > 0; },
    get attachedWebContentsId() { return [...env.wcIdBySurface.values()].at(-1) ?? null; },
    surfaceIdFor: (wcId: number) => [...env.wcIdBySurface].find(([, id]) => id === wcId)?.[0] ?? null,
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ tree: '- button "OK" [ref=e1]', refCount: 1 })),
    screenshot: vi.fn(async () => 'BASE64'),
    evaluate: vi.fn(async () => 42),
  },
}));
vi.mock('../../src/main/agent-browser-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent-browser-cli')>()),
  agentBrowserPath: () => 'native.exe',
  runAgentBrowser: (_binary: string, argv: string[], timeoutMs: number) => {
    env.nativeCalls.push({ argv, timeoutMs });
    return env.nativeImpl(argv, timeoutMs);
  },
}));
vi.mock('../../src/main/agent-browser-runtime', async (importOriginal) => ({
  withDeadline: (await importOriginal<typeof import('../../src/main/agent-browser-runtime')>()).withDeadline,
  runAgentBrowserForSession: (argv: string[], timeoutMs: number) => {
    env.nativeCalls.push({ argv, timeoutMs });
    return env.nativeImpl(argv, timeoutMs);
  },
  acquireDashboardFor: (surfaceId: string) => {
    env.acquired.push(surfaceId);
    return env.acquireImpl(surfaceId);
  },
  ensureStartedSession: async (surfaceId: string) => env.startImpl ? env.startImpl(surfaceId) : ({
    surfaceId,
    sessionName: `wmux-${surfaceId}`,
    streamPort: 9300,
    dashboardUrl: `http://127.0.0.1:4848/?port=9300`,
  }),
}));

import { cdpBridge } from '../../src/main/ipc-handlers';
import {
  handleBrowserV2,
  resolveBrowserTarget,
  runBrowserCommandForTarget,
  type BrowserDeps,
  type BrowserTarget,
} from '../../src/main/v2-browser';

describe('engineOf', () => {
  it('defaults an undefined engine to web', () => {
    const s = { id: 'surf-1', type: 'browser' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('returns an explicit engine', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('agent');
  });

  it('treats a non-browser surface as web', () => {
    const s = { id: 'surf-1', type: 'terminal', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('rejects an unknown engine string from a hand-edited session file', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'evil' } as unknown as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });
});

// ── routing ────────────────────────────────────────────────────────────────

const SNAPSHOT = { tree: '- button "OK" [ref=e1]', refCount: 1 };

/** Every method the web branch can reach, each recording its own call. */
function makeBridge() {
  return {
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async () => SNAPSHOT),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    screenshot: vi.fn(async () => 'BASE64'),
    getText: vi.fn(async () => 'hello page'),
    evaluate: vi.fn(async () => 42),
    wait: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  };
}

const ok = (data: unknown, stdout = ''): any => ({ ok: true, spawnFailed: false, data, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): any => ({ ok: false, spawnFailed: false, data: null, stdout, stderr });
const neverStarted = (): any => ({ ok: false, spawnFailed: true, data: null, stdout: '', stderr: '' });

function deps(bridge: any, runAgent: any = vi.fn()): BrowserDeps {
  return { bridge: bridge as any, runAgent };
}

const SESSION = {
  surfaceId: 'surf-a',
  sessionName: 'wmux-surf-a',
  streamPort: 9300,
  dashboardUrl: 'http://127.0.0.1:4848/?port=9300',
} as any;

const web = (wcId = 7): BrowserTarget => ({ kind: 'web', wcId });
const agent = (): BrowserTarget => ({ kind: 'agent', session: SESSION });

/** Every verb wmux exposes, with params good enough to build an argv. */
const ALL_VERBS: Array<[string, any]> = [
  ['browser.navigate', { url: 'https://a' }],
  ['browser.snapshot', {}],
  ['browser.click', { ref: 'e1' }],
  ['browser.type', { ref: 'e1', text: 'hi' }],
  ['browser.fill', { ref: 'e1', value: 'v' }],
  ['browser.screenshot', {}],
  ['browser.get_text', {}],
  ['browser.eval', { js: '1+1' }],
  ['browser.wait', { ref: 'e1' }],
  ['browser.back', {}],
  ['browser.forward', {}],
  ['browser.reload', {}],
];

describe('runBrowserCommandForTarget — engine dispatch', () => {
  it('sends a web target to the CDP bridge, and never shells out', async () => {
    const bridge = makeBridge();
    const runAgent = vi.fn();
    const res = await runBrowserCommandForTarget('browser.navigate', { url: 'https://a' }, web(7), deps(bridge, runAgent));

    expect(bridge.navigate).toHaveBeenCalledWith('https://a', undefined, 7);
    expect(runAgent).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('threads every web verb\'s arguments through in the order cdp-bridge expects', async () => {
    const bridge = makeBridge();
    const d = deps(bridge);
    await runBrowserCommandForTarget('browser.navigate', { url: 'u', timeout: 1234 }, web(3), d);
    await runBrowserCommandForTarget('browser.click', { ref: 'e1' }, web(3), d);
    await runBrowserCommandForTarget('browser.type', { ref: 'e1', text: 't' }, web(3), d);
    await runBrowserCommandForTarget('browser.fill', { ref: 'e1', value: 'v' }, web(3), d);
    await runBrowserCommandForTarget('browser.screenshot', { fullPage: true }, web(3), d);
    await runBrowserCommandForTarget('browser.get_text', { ref: 'e2' }, web(3), d);
    await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, web(3), d);
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: 99 }, web(3), d);
    await runBrowserCommandForTarget('browser.back', {}, web(3), d);
    await runBrowserCommandForTarget('browser.forward', {}, web(3), d);
    await runBrowserCommandForTarget('browser.reload', {}, web(3), d);

    expect(bridge.navigate).toHaveBeenCalledWith('u', 1234, 3);
    expect(bridge.click).toHaveBeenCalledWith('e1', 3);
    expect(bridge.type).toHaveBeenCalledWith('e1', 't', 3);
    expect(bridge.fill).toHaveBeenCalledWith('e1', 'v', 3);
    expect(bridge.screenshot).toHaveBeenCalledWith(true, 3);
    expect(bridge.getText).toHaveBeenCalledWith('e2', 3);
    expect(bridge.evaluate).toHaveBeenCalledWith('1+1', 3);
    expect(bridge.wait).toHaveBeenCalledWith('e1', 99, 3);
    expect(bridge.goBack).toHaveBeenCalledWith(3);
    expect(bridge.goForward).toHaveBeenCalledWith(3);
    expect(bridge.reload).toHaveBeenCalledWith(3);
  });

  it('sends an agent target to the CLI with the session pinned, and never touches the bridge', async () => {
    const bridge = makeBridge();
    const runAgent = vi.fn(async () => ok({ url: 'https://a' }));
    await runBrowserCommandForTarget('browser.navigate', { url: 'https://a' }, agent(), deps(bridge, runAgent));

    expect(runAgent).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'open', 'https://a'], expect.any(Number));
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  // A server budget above the CLI's client deadline is not a longer budget, it
  // is an unreportable one: the client has already hung up and printed a bare
  // `timed out`, so the server's real diagnosis never reaches the user.
  // browser-timeout.test.ts pins the actual numbers against src/cli/wmux.ts;
  // this pins that a budget is passed at all, per verb.
  it('lets native actions finish inside a hard watchdog and accommodates explicit longer waits', async () => {
    const runAgent = vi.fn(async () => ok({}));
    const d = deps(makeBridge(), runAgent);
    await runBrowserCommandForTarget('browser.navigate', { url: 'u' }, agent(), d);
    await runBrowserCommandForTarget('browser.snapshot', {}, agent(), d);
    await runBrowserCommandForTarget('browser.wait', { timeout: 777 }, agent(), d);

    await runBrowserCommandForTarget('browser.wait', { timeout: 90_000 }, agent(), d);
    expect(runAgent.mock.calls.map((c: any[]) => c[1])).toEqual([35_000, 35_000, 35_000, 93_000]);
    expect(runAgent).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'wait', '777'], 35_000);
  });

  it('never spawns a process for a verb the agent engine cannot express', async () => {
    const runAgent = vi.fn();
    await expect(
      runBrowserCommandForTarget('browser.teleport', {}, agent(), deps(makeBridge(), runAgent)),
    ).rejects.toThrow(/Unknown/);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe('runBrowserCommandForTarget — agent failures', () => {
  it('surfaces a CLI-reported failure as an error carrying stderr', async () => {
    const runAgent = vi.fn(async () => fail('chrome not installed'));
    await expect(
      runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), runAgent)),
    ).rejects.toThrow(/chrome not installed/);
  });

  it('falls back to stdout when a failing CLI said nothing on stderr', async () => {
    const runAgent = vi.fn(async () => fail('', 'no such session'));
    await expect(
      runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), runAgent)),
    ).rejects.toThrow(/no such session/);
  });

  // spawnFailed and a non-zero exit are opposite problems: one is a wmux/install
  // fault (the resolved binary went stale), the other is the CLI reporting on a
  // page. Echoing an empty stderr for the first reads like a broken install with
  // no explanation, which is exactly what it must not do.
  it('reports a process that never started as a launch failure, not as empty stderr', async () => {
    const runAgent = vi.fn(async () => neverStarted());
    const err = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), runAgent))
      .then(() => null, (e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/could not be launched/i);
    expect(err.spawnFailed).toBe(true);
  });

  it('gives a launch failure a different message from a CLI failure', async () => {
    const launch = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => neverStarted())))
      .then(() => null, (e: any) => e);
    const cliFailure = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => fail('boom'))))
      .then(() => null, (e: any) => e);

    expect(launch.message).not.toBe(cliFailure.message);
    expect(cliFailure.spawnFailed).toBeFalsy();
  });
});

describe('the two engines are indistinguishable to a caller', () => {
  // A caller must not be able to tell which engine it got by the error it
  // receives for a verb neither supports — same message, same JSON-RPC code.
  it('rejects an unknown verb byte-identically on both engines', async () => {
    const d = deps(makeBridge(), vi.fn());
    const fromWeb = await runBrowserCommandForTarget('browser.nope', {}, web(), d).then(() => null, (e: any) => e);
    const fromAgent = await runBrowserCommandForTarget('browser.nope', {}, agent(), d).then(() => null, (e: any) => e);

    expect(fromWeb.message).toBe('Unknown: browser.nope');
    expect(fromAgent.message).toBe(fromWeb.message);
    expect(fromWeb.rpcCode).toBe(-32601);
    expect(fromAgent.rpcCode).toBe(-32601);
  });

  it('maps every verb wmux exposes onto the agent engine', async () => {
    // The guard that catches a 13th verb being added to the web switch and
    // forgotten in the translation table: it would throw -32601 here.
    const runAgent = vi.fn(async () => ok({}));
    for (const [method, params] of ALL_VERBS) {
      const err = await runBrowserCommandForTarget(method, params, agent(), deps(makeBridge(), runAgent))
        .then(() => null, (e: any) => e);
      expect(err?.rpcCode, `${method} is unmapped on the agent engine`).not.toBe(-32601);
    }
    expect(runAgent).toHaveBeenCalledTimes(ALL_VERBS.length);
  });

  /**
   * Fixtures below are VERBATIM stdout from agent-browser 0.35.0 on this
   * machine, not invented shapes — the previous versions of these tests
   * asserted parity against a payload this file made up, which made them
   * circular. `--json` wraps every verb in `{success, data, error}`; without it
   * the same verbs print bare text. wmux's argv only passes `--json` for
   * screenshot today, so BOTH forms are live and both are pinned here.
   */
  const REAL_TREE =
    '- heading "Example Domain" [level=1, ref=e1]\n'
    + '- paragraph\n'
    + '  - StaticText "This domain is for use in documentation examples without needing permission. Avoid use in operations."\n'
    + '- paragraph\n'
    + '  - link "Learn more" [ref=e2]';

  const REAL_SNAPSHOT_JSON = {
    success: true,
    data: {
      lifecycle: { launched: false, reused: true },
      origin: 'https://example.com/',
      refs: { e1: { name: 'Example Domain', role: 'heading' }, e2: { name: 'Learn more', role: 'link' } },
      snapshot: REAL_TREE,
    },
    error: null,
  };

  it('returns the same result shape from both engines for snapshot (bare stdout)', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.snapshot', {}, web(), deps(bridge));
    // No --json in wmux's argv, so this is what actually arrives.
    const fromAgent = await runBrowserCommandForTarget(
      'browser.snapshot', {}, agent(), deps(bridge, vi.fn(async () => ok(null, REAL_TREE))),
    );

    expect(Object.keys(fromAgent).sort()).toEqual(Object.keys(fromWeb).sort());
    expect(fromAgent).toEqual({ tree: REAL_TREE, refCount: 2 });
  });

  it('unwraps the --json envelope for snapshot and counts refs from the map', async () => {
    const fromAgent = await runBrowserCommandForTarget(
      'browser.snapshot', {}, agent(),
      deps(makeBridge(), vi.fn(async () => ok(REAL_SNAPSHOT_JSON, JSON.stringify(REAL_SNAPSHOT_JSON)))),
    );
    expect(fromAgent).toEqual({ tree: REAL_TREE, refCount: 2 });
  });

  // The CLI prints a trailing newline that the --json payload does not carry,
  // so the same snapshot arrived as two different strings depending on which
  // form it came back in. Caught by diffing the two against the real binary.
  it('yields a byte-identical tree whichever form the snapshot arrives in', async () => {
    const bare = await runBrowserCommandForTarget(
      'browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => ok(null, `${REAL_TREE}\n`))),
    );
    const enveloped = await runBrowserCommandForTarget(
      'browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => ok(REAL_SNAPSHOT_JSON))),
    );
    expect(bare).toEqual(enveloped);
  });

  // The bug: the envelope was passed through verbatim, so an agent calling
  // `wmux browser snapshot` got {success,data:{lifecycle,origin,refs,snapshot}}
  // on one engine and {tree,refCount} on the other.
  it('never hands the caller agent-browser\'s envelope for a snapshot', async () => {
    const fromAgent: any = await runBrowserCommandForTarget(
      'browser.snapshot', {}, agent(),
      deps(makeBridge(), vi.fn(async () => ok(REAL_SNAPSHOT_JSON))),
    );
    expect(fromAgent).not.toHaveProperty('success');
    expect(fromAgent).not.toHaveProperty('data');
    expect(fromAgent).not.toHaveProperty('lifecycle');
    expect(typeof fromAgent.tree).toBe('string');
    expect(typeof fromAgent.refCount).toBe('number');
  });

  it('counts a ref mentioned twice in the tree only once', async () => {
    const tree = '- link "a" [ref=e1]\n- note [ref=e1]\n- link "b" [ref=e2]';
    const fromAgent = await runBrowserCommandForTarget(
      'browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => ok(null, tree))),
    );
    expect(fromAgent).toEqual({ tree, refCount: 2 });
  });

  it('returns the same result shape from both engines for get_text', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.get_text', {}, web(), deps(bridge));
    const fromAgent = await runBrowserCommandForTarget('browser.get_text', {}, agent(), deps(bridge, vi.fn(async () => ok(null, 'hello page'))));

    expect(fromWeb).toEqual({ text: 'hello page' });
    expect(Object.keys(fromAgent)).toEqual(Object.keys(fromWeb));
    expect(fromAgent.text).toBe('hello page');
  });

  it('reads get_text out of the envelope, from `text` or `content`', async () => {
    // `get text @e1 --json` → data.text ; `read --json` → data.content
    const getText = { success: true, data: { origin: 'https://example.com/', text: 'Example Domain' }, error: null };
    const read = { success: true, data: { content: '# Example Domain', contentType: 'text/html' }, error: null };

    expect(await runBrowserCommandForTarget('browser.get_text', { ref: 'e1' }, agent(),
      deps(makeBridge(), vi.fn(async () => ok(getText))))).toEqual({ text: 'Example Domain' });
    expect(await runBrowserCommandForTarget('browser.get_text', {}, agent(),
      deps(makeBridge(), vi.fn(async () => ok(read))))).toEqual({ text: '# Example Domain' });
  });

  /**
   * agent-browser's `screenshot` has no way to emit bytes: it WRITES A PNG and
   * reports `data.path`. The web engine returns base64 straight from
   * `Page.captureScreenshot`, so parity has to be bought by reading the file.
   */
  it('returns base64 from both engines for screenshot, reading the file agent-browser wrote', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.screenshot', {}, web(), deps(bridge));
    expect(fromWeb).toEqual({ data: 'BASE64' });

    const png = path.join(os.tmpdir(), `wmux-shot-${process.pid}.png`);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    fs.writeFileSync(png, bytes);
    try {
      const envelope = { success: true, data: { lifecycle: { reused: true }, path: png }, error: null };
      const fromAgent = await runBrowserCommandForTarget(
        'browser.screenshot', {}, agent(), deps(bridge, vi.fn(async () => ok(envelope))),
      );
      expect(Object.keys(fromAgent)).toEqual(Object.keys(fromWeb));
      expect(fromAgent.data).toBe(bytes.toString('base64'));
    } finally {
      fs.unlinkSync(png);
    }
  });

  it('does not fail the command when the screenshot file cannot be read', async () => {
    const envelope = { success: true, data: { path: path.join(os.tmpdir(), 'wmux-no-such-shot.png') }, error: null };
    const fromAgent = await runBrowserCommandForTarget(
      'browser.screenshot', {}, agent(), deps(makeBridge(), vi.fn(async () => ok(envelope, ''))),
    );
    expect(fromAgent).toEqual({ data: '' });
  });

  it('returns the same result shape from both engines for eval', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, web(), deps(bridge));
    const envelope = { success: true, data: { origin: 'https://example.com/', result: 42 }, error: null };
    const fromAgent = await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, agent(), deps(bridge, vi.fn(async () => ok(envelope))));

    expect(fromWeb).toEqual({ result: 42 });
    expect(Object.keys(fromAgent)).toEqual(Object.keys(fromWeb));
    expect(fromAgent.result).toBe(42);
  });

  // `eval 1+1` bare-prints `2`. The web engine returns the NUMBER 2, so the
  // engines would disagree on type if stdout were handed back as a string.
  it('recovers the value, not the digits, from a bare eval', async () => {
    const fromAgent = await runBrowserCommandForTarget(
      'browser.eval', { js: '1+1' }, agent(), deps(makeBridge(), vi.fn(async () => ok(null, '2\n'))),
    );
    expect(fromAgent).toEqual({ result: 2 });
    expect(typeof (fromAgent as any).result).toBe('number');
  });

  it('leaves a non-JSON eval result as text', async () => {
    const fromAgent = await runBrowserCommandForTarget(
      'browser.eval', { js: 'document.title' }, agent(), deps(makeBridge(), vi.fn(async () => ok(null, 'Example Domain\n'))),
    );
    expect(fromAgent).toEqual({ result: 'Example Domain' });
  });

  // A falsy-but-present result must survive the coercion: `?? `-chained
  // fallbacks would quietly replace `false`/`0`/`''` with the raw stdout.
  it('preserves a falsy eval result rather than falling through to stdout', async () => {
    const envelope = { success: true, data: { result: false }, error: null };
    const fromAgent = await runBrowserCommandForTarget(
      'browser.eval', { js: 'false' }, agent(),
      deps(makeBridge(), vi.fn(async () => ok(envelope, 'ignored'))),
    );
    expect(fromAgent).toEqual({ result: false });
  });

  // `{"success":false,"data":null,"error":"Unknown ref: e1"}` with exit 1 is
  // what a --json verb answers for a bad ref; the reason belongs in front of
  // the agent without the `✗ ` decoration stderr adds.
  it('reports the envelope\'s error field when a --json verb fails', async () => {
    const envelope = { success: false, data: null, error: 'Unknown ref: e1' };
    const runAgent = vi.fn(async () => ({
      ok: false, spawnFailed: false, data: envelope,
      stdout: JSON.stringify(envelope), stderr: '',
    }));
    await expect(
      runBrowserCommandForTarget('browser.click', { ref: 'e1' }, agent(), deps(makeBridge(), runAgent as any)),
    ).rejects.toThrow('Unknown ref: e1');
  });

  it('answers ok:true for the action verbs on all engines', async () => {
    const bridge = makeBridge();
    for (const method of ['browser.navigate', 'browser.click', 'browser.type', 'browser.fill', 'browser.wait', 'browser.back', 'browser.forward', 'browser.reload']) {
      const params = { url: 'u', ref: 'e1', text: 't', value: 'v' };
      const fromWeb = await runBrowserCommandForTarget(method, params, web(), deps(bridge));
      const fromAgent = await runBrowserCommandForTarget(method, params, agent(), deps(bridge, vi.fn(async () => ok(null))));
      expect(fromAgent, method).toEqual(fromWeb);
      expect(fromAgent, method).toEqual({ ok: true });
    }
  });
});

// ── target resolution ──────────────────────────────────────────────────────

/**
 * A renderer window that answers the `window.__wmux_*` globals
 * `resolveBrowserTarget` reaches for. Dispatch is on the global's name and the
 * first quoted argument, because that string of JS is genuinely how main talks
 * to the store.
 */
function fakeWindow(opts: {
  workspaceOf?: Record<string, string>;
  browsersIn?: Record<string, string[]>;
  engines?: Record<string, string>;
  created?: string;
  destroyed?: boolean;
  activeWorkspaceId?: string | null;
  layoutAvailable?: boolean;
}) {
  const calls: string[] = [];
  const workspaceIds = [...new Set([...Object.values(opts.workspaceOf ?? {}), ...Object.keys(opts.browsersIn ?? {})])];
  if (!workspaceIds.length) workspaceIds.push('ws-empty');
  const activeWorkspaceId = opts.activeWorkspaceId === undefined ? workspaceIds[0] : opts.activeWorkspaceId;
  const workspaceOf = (id: string) => opts.workspaceOf?.[id]
    ?? Object.entries(opts.browsersIn ?? {}).find(([, ids]) => ids.includes(id))?.[0];
  return {
    id: ++windowSeq,
    calls,
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      executeJavaScript: async (js: string) => {
        calls.push(js);
        if (js.includes('__wmux_listWorkspaces')) {
          const bridge = opts.layoutAvailable === false ? {} : {
            __wmux_listWorkspaces: () => workspaceIds.map((id) => ({ id, isActive: id === activeWorkspaceId })),
            __wmux_listBrowserSurfaces: (id: string) => opts.browsersIn?.[id] ?? [],
          };
          return new Function('window', `return ${js}`)(bridge);
        }
        const arg = /"([^"]+)"/.exec(js)?.[1] ?? '';
        if (js.includes('__wmux_getBrowserEngine')) return opts.engines?.[arg] ?? 'web';
        if (js.includes('__wmux_locateSurface')) return workspaceOf(arg) ? { workspaceId: workspaceOf(arg) } : null;
        if (js.includes('__wmux_getWorkspaceIdForSurface')) return workspaceOf(arg) ?? null;
        if (js.includes('__wmux_listBrowserSurfaces')) return opts.browsersIn?.[arg] ?? [];
        if (js.includes('__wmux_splitPane')) return opts.created ? { surfaceId: opts.created } : null;
        return null;
      },
    },
  };
}

// Module state (the #62 caller→browser binding) lives for the whole file, so
// every test uses its own caller id rather than trying to reset it.
let windowSeq = 0;
let callerSeq = 0;
const nextCaller = () => `surf-caller-${++callerSeq}`;

function resetEnv(): void {
  vi.clearAllMocks();
  env.windows = [];
  env.focusedWindow = undefined;
  env.wcIdBySurface = new Map();
  env.acquired = [];
  env.acquireImpl = async () => {};
  env.startImpl = undefined;
  env.nativeCalls = [];
  env.nativeImpl = async () => ok(null);
}

describe('resolveBrowserTarget — which engine a command lands on', () => {
  beforeEach(resetEnv);

  /**
   * THE regression this rewrite exists for.
   *
   * A surface toggled web → agent keeps its CDP registration: nothing calls
   * cdp.detach on a toggle and pruneDead() only drops DESTROYED webContents. So
   * wcIdForSurface returns a perfectly valid, NON-null id for an agent-mode
   * surface — and a resolver that only consults the engine when the wcId came
   * back null routes the command to the web engine, driving CDP against
   * agent-browser's own dashboard SPA and corrupting the pane the user is
   * watching. Silently.
   */
  it('routes to the agent engine for a toggled surface that still has a live wcId', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-toggled'] },
      engines: { 'surf-toggled': 'agent' },
    })];
    env.wcIdBySurface.set('surf-toggled', 5); // the stale-but-valid registration

    const target = await resolveBrowserTarget(caller);

    expect(target?.kind).toBe('agent');
    expect((target as any).session.sessionName).toBe('wmux-surf-toggled');
  });

  it('still routes an ordinary web surface to the bridge, wcId intact', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-web'] },
      engines: { 'surf-web': 'web' },
    })];
    env.wcIdBySurface.set('surf-web', 11);

    expect(await resolveBrowserTarget(caller)).toEqual({ kind: 'web', wcId: 11 });
  });

  // The second command for a caller takes the already-bound fast path, which
  // must notice a toggle that happened between the two.
  it('notices a toggle that happens after the caller is already bound', async () => {
    const caller = nextCaller();
    const engines: Record<string, string> = { 'surf-flip': 'web' };
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-flip'] },
      engines,
    })];
    env.wcIdBySurface.set('surf-flip', 7);

    expect((await resolveBrowserTarget(caller))?.kind).toBe('web');
    engines['surf-flip'] = 'agent'; // user flips the pane
    expect((await resolveBrowserTarget(caller))?.kind).toBe('agent');
  });

  // A surface that STARTED in agent mode and has no webview at all: the wcId
  // path gives up with null, which is the expected answer, not a failure.
  it('routes to the agent engine when there is no wcId to be had', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-native'] },
      engines: { 'surf-native': 'agent' },
    })];

    const target = await resolveBrowserTarget(caller);
    expect(target?.kind).toBe('agent');
  });

  /** A surface's engine must be resolved in its owning window, not the first. */
  it('asks every window, not just the first, which engine a surface is on (#143)', async () => {
    const caller = nextCaller();
    const engines: Record<string, string> = { 'surf-elsewhere': 'web' };
    const home = fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-elsewhere'] },
      engines,
    });
    env.windows = [home];
    env.wcIdBySurface.set('surf-elsewhere', 3);
    expect((await resolveBrowserTarget(caller))?.kind).toBe('web'); // binds the caller

    // A second window opens in front of the one holding the surface, and the
    // pane flips to agent mode. Window 0 knows nothing about either.
    env.windows = [fakeWindow({}), home];
    engines['surf-elsewhere'] = 'agent';

    expect((await resolveBrowserTarget(caller))?.kind).toBe('agent');
  });

  // The first command a caller issues used to poll 5s for a CDP attachment that
  // an agent-mode surface is never going to make — latency the CLI's own
  // deadline was spending at the same time.
  it('does not poll for a wcId that an agent surface will never produce', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-nopoll'] },
      engines: { 'surf-nopoll': 'agent' },
    })];

    const started = Date.now();
    expect((await resolveBrowserTarget(caller))?.kind).toBe('agent');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats a renderer that rejects the query as web rather than failing the command', async () => {
    const caller = nextCaller();
    const win = fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-noisy'] },
    });
    const inner = win.webContents.executeJavaScript;
    win.webContents.executeJavaScript = async (js: string) => {
      if (js.includes('__wmux_getBrowserEngine')) throw new Error('renderer went away');
      return inner(js);
    };
    env.windows = [win];
    env.wcIdBySurface.set('surf-noisy', 9);

    expect(await resolveBrowserTarget(caller)).toEqual({ kind: 'web', wcId: 9 });
  });

  /**
   * `wmux browser <verb> --surface <browser-surface>` — the browser's own id as
   * the caller. It used to be read as a new terminal: the workspace's browser
   * was already bound to the agent's terminal, so a fresh pane was split for
   * it, and targeting THAT pane split another, one per command.
   */
  it('drives a browser surface named as the caller instead of splitting a new pane', async () => {
    const terminal = nextCaller();
    const win = fakeWindow({
      workspaceOf: { [terminal]: 'ws-1', 'surf-named': 'ws-1' },
      browsersIn: { 'ws-1': ['surf-named'] },
      created: 'surf-SPLIT',
    });
    env.windows = [win];
    env.wcIdBySurface.set('surf-named', 21);

    // The terminal binds the workspace's browser first, as an agent's plain
    // `wmux browser open` does…
    expect(await resolveBrowserTarget(terminal)).toEqual({ kind: 'web', wcId: 21 });
    // …then the same browser is named explicitly, twice.
    expect(await resolveBrowserTarget('surf-named')).toEqual({ kind: 'web', wcId: 21 });
    expect(await resolveBrowserTarget('surf-named')).toEqual({ kind: 'web', wcId: 21 });

    expect(win.calls.some((js) => js.includes('__wmux_splitPane'))).toBe(false);
  });

  it('routes a named agent-mode browser surface to the agent engine', async () => {
    env.windows = [fakeWindow({
      workspaceOf: { 'surf-named-agent': 'ws-1' },
      browsersIn: { 'ws-1': ['surf-named-agent'] },
      engines: { 'surf-named-agent': 'agent' },
      created: 'surf-SPLIT',
    })];

    const target = await resolveBrowserTarget('surf-named-agent');
    expect(target?.kind).toBe('agent');
    expect((target as any).session.sessionName).toBe('wmux-surf-named-agent');
  });

  // Naming a pane is not owning it: a terminal agent arriving later must still
  // be able to adopt it rather than split a pane of its own.
  it('leaves a named browser surface adoptable by a terminal', async () => {
    const terminal = nextCaller();
    const win = fakeWindow({
      workspaceOf: { [terminal]: 'ws-1', 'surf-shared': 'ws-1' },
      browsersIn: { 'ws-1': ['surf-shared'] },
      created: 'surf-SPLIT',
    });
    env.windows = [win];
    env.wcIdBySurface.set('surf-shared', 31);

    await resolveBrowserTarget('surf-shared');
    expect(await resolveBrowserTarget(terminal)).toEqual({ kind: 'web', wcId: 31 });
    expect(win.calls.some((js) => js.includes('__wmux_splitPane'))).toBe(false);
  });
});

describe('browser surface creation guardrail', () => {
  beforeEach(resetEnv);

  const request = (method: string, params: any = {}) =>
    new Promise<{ code?: number; message?: string; result?: any }>((resolve) => {
      handleBrowserV2(method, params, (result) => resolve({ result }), (code, message) => resolve({ code, message }));
    });
  const splitCalls = () => env.windows.flatMap((win) => win.calls.filter((js: string) => js.includes('__wmux_splitPane')));
  const expectNoDispatch = () => {
    expect(cdpBridge.navigate).not.toHaveBeenCalled();
    expect(cdpBridge.snapshot).not.toHaveBeenCalled();
    expect(cdpBridge.screenshot).not.toHaveBeenCalled();
    expect(cdpBridge.evaluate).not.toHaveBeenCalled();
    expect(env.nativeCalls).toEqual([]);
    expect(env.acquired).toEqual([]);
  };

  it.each(['caller', 'untargeted', 'stale ambient'])('page commands cannot split through the %s path', async (route) => {
    const caller = nextCaller();
    env.windows = [fakeWindow({ workspaceOf: route === 'caller' ? { [caller]: 'ws-empty' } : {}, created: 'surf-forbidden' })];
    const params = route === 'untargeted' ? {} : { caller };
    for (const method of ['browser.snapshot', 'browser.screenshot', 'browser.eval']) {
      const answer = await request(method, params);
      expect(answer.code).toBe(-32000);
      expect(answer.message).toContain('wmux list-surfaces');
      expect(answer.message).toContain('wmux browser open <url>');
    }
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it.each(['caller', 'untargeted'])('open can create through the %s path and snapshot reuses it', async (route) => {
    const caller = nextCaller();
    const surfaceId = `surf-created-${caller}`;
    const browsersIn = { 'ws-new': [] as string[] };
    const win = fakeWindow({ workspaceOf: { [caller]: 'ws-new' }, browsersIn, created: surfaceId });
    const execute = win.webContents.executeJavaScript;
    win.webContents.executeJavaScript = async (js) => {
      if (js.includes('__wmux_splitPane')) {
        browsersIn['ws-new'].push(surfaceId);
        env.wcIdBySurface.set(surfaceId, 71);
      }
      return execute(js);
    };
    env.windows = [win];
    const params = route === 'caller' ? { caller } : {};
    expect(await request('browser.navigate', { ...params, url: 'https://fixture.test/' })).toEqual({ result: { ok: true } });
    expect(await request('browser.snapshot', params)).toEqual({ result: SNAPSHOT });
    expect(splitCalls()).toHaveLength(1);
    expect(cdpBridge.navigate).toHaveBeenCalledWith('https://fixture.test/', undefined, 71);
    expect(cdpBridge.snapshot).toHaveBeenCalledWith(71);
  });

  it.each(['caller', 'untargeted'])('rejects blank navigation before splitting through the %s path', async (route) => {
    const caller = nextCaller();
    env.windows = [fakeWindow({ workspaceOf: { [caller]: 'ws-empty' }, created: 'surf-forbidden' })];
    const params = route === 'caller' ? { caller } : {};
    for (const url of [undefined, '', '  ', 42]) {
      expect((await request('browser.navigate', { ...params, url })).code).toBe(-32602);
    }
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it.each(['web', 'agent'])('discards a closed %s binding despite lingering CDP and engine state', async (engine) => {
    const caller = nextCaller();
    const surfaceId = `surf-stale-${caller}`;
    const browsersIn = { 'ws-stale': [surfaceId] };
    env.windows = [fakeWindow({ workspaceOf: { [caller]: 'ws-stale' }, browsersIn, engines: { [surfaceId]: engine }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set(surfaceId, 72);
    await resolveBrowserTarget(caller);
    browsersIn['ws-stale'] = [];
    env.acquired = [];
    const start = vi.fn(async () => SESSION);
    env.startImpl = start;
    const answer = await request('browser.snapshot', { caller });
    expect(answer.code).toBe(-32000);
    expect(splitCalls()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expectNoDispatch();
  });

  it('does not reuse a closed shared surface just because CDP remains attached', async () => {
    env.windows = [fakeWindow({ created: 'surf-forbidden' })];
    env.wcIdBySurface.set('surf-closed-shared', 73);
    expect((await request('browser.snapshot')).code).toBe(-32000);
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it('reuses the sole active-workspace Web browser despite newer side-panel and other-workspace attachments', async () => {
    const win = fakeWindow({ activeWorkspaceId: 'ws-selected',
      browsersIn: { 'ws-other': ['surf-other-web'], 'ws-selected': ['surf-selected-web'] }, created: 'surf-forbidden' });
    env.windows = [win];
    env.wcIdBySurface.set('surf-selected-web', 81);
    env.wcIdBySurface.set('surf-other-web', 82);
    env.wcIdBySurface.set('browser-ws-selected', 83);
    expect(await request('browser.snapshot')).toEqual({ result: SNAPSHOT });
    expect(await request('browser.navigate', { url: 'https://fixture.test/' })).toEqual({ result: { ok: true } });
    expect(cdpBridge.snapshot).toHaveBeenCalledWith(81);
    expect(cdpBridge.navigate).toHaveBeenCalledWith('https://fixture.test/', undefined, 81);
    expect(win.calls.filter((js) => js.includes('__wmux_listWorkspaces'))).toHaveLength(2);
    expect(win.calls.filter((js) => js.includes('__wmux_listBrowserSurfaces')))
      .toEqual(win.calls.filter((js) => js.includes('__wmux_listWorkspaces')));
    expect(splitCalls()).toEqual([]);
    expect(env.acquired).toEqual([]);
    expect(env.nativeCalls).toEqual([]);
  });

  it.each([false, true])('reuses the sole Agent browser without driving its dashboard (CDP attached: %s)', async (attached) => {
    const surfaceId = `surf-untargeted-agent-${attached}`;
    env.windows = [fakeWindow({ browsersIn: { 'ws-agent': [surfaceId] }, engines: { [surfaceId]: 'agent' }, created: 'surf-forbidden' })];
    if (attached) env.wcIdBySurface.set(surfaceId, 85);
    env.nativeImpl = async () => ok(null, SNAPSHOT.tree);
    expect(await request('browser.snapshot')).toEqual({ result: SNAPSHOT });
    expect(await request('browser.navigate', { url: 'https://fixture.test/' })).toEqual({ result: { ok: true } });
    expect(env.nativeCalls.map(({ argv }) => argv)).toEqual([
      ['--session', `wmux-${surfaceId}`, 'snapshot'],
      ['--session', `wmux-${surfaceId}`, 'open', 'https://fixture.test/'],
    ]);
    expect(cdpBridge.snapshot).not.toHaveBeenCalled();
    expect(cdpBridge.navigate).not.toHaveBeenCalled();
    expect(splitCalls()).toEqual([]);
  });

  it.each(['browser.snapshot', 'browser.navigate', 'browser.batch'])('requires --surface for mixed-engine ambiguity on %s without starting, splitting or claiming', async (method) => {
    const caller = nextCaller();
    const webId = `surf-ambiguous-web-${caller}`, agentId = `surf-ambiguous-agent-${caller}`;
    env.windows = [fakeWindow({ workspaceOf: { [caller]: 'ws-many' }, browsersIn: { 'ws-many': [webId, agentId] },
      engines: { [agentId]: 'agent' }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set(webId, 87);
    const start = vi.fn(async () => SESSION);
    env.startImpl = start;
    const answer = await request(method, { url: 'https://fixture.test/',
      commands: [{ method: 'browser.navigate', params: { url: 'https://fixture.test/' } }] });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('--surface <id>');
    expect(splitCalls()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expectNoDispatch();
    // Refusal must leave the first browser free for a terminal to adopt.
    expect(await resolveBrowserTarget(caller)).toEqual({ kind: 'web', wcId: 87 });
    expect(splitCalls()).toEqual([]);
  });

  it.each(['focused', 'sole unfocused', 'destroyed focus'])('selects the %s live window, never an arbitrary first window', async (focus) => {
    const selected = fakeWindow({ browsersIn: { 'ws-selected': ['surf-focus-selected'] } });
    const other = fakeWindow({ browsersIn: { 'ws-other': ['surf-focus-other'] }, destroyed: focus === 'destroyed focus' });
    env.windows = focus === 'sole unfocused' ? [selected] : [other, selected];
    env.focusedWindow = focus === 'focused' ? selected : focus === 'destroyed focus' ? other : null;
    env.wcIdBySurface.set('surf-focus-selected', 91);
    env.wcIdBySurface.set('surf-focus-other', 92);
    expect(await request('browser.snapshot')).toEqual({ result: SNAPSHOT });
    expect(cdpBridge.snapshot).toHaveBeenCalledWith(91);
    expect(other.calls.filter((js) => js.includes('__wmux_listWorkspaces') || js.includes('__wmux_splitPane'))).toEqual([]);
    expect(splitCalls()).toEqual([]);
  });

  it.each(['browser.snapshot', 'browser.navigate', 'browser.batch'])('refuses unfocused multi-window %s before querying any renderer', async (method) => {
    env.windows = [fakeWindow({ created: 'surf-forbidden' }), fakeWindow({ created: 'surf-forbidden' })];
    env.focusedWindow = null;
    const answer = await request(method, { url: 'https://fixture.test/',
      commands: [{ method: 'browser.navigate', params: { url: 'https://fixture.test/' } }] });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('--surface <id>');
    expect(env.windows.flatMap((win) => win.calls)).toEqual([]);
    expectNoDispatch();
  });

  it.each([
    ['missing bridge', 'Browser workspace layout is unavailable in the selected wmux window.'],
    ['missing workspace', 'No active workspace in the selected wmux window.'],
    ['reloading renderer', 'Browser workspace layout is unavailable in the selected wmux window.'],
    ['unreadable inventory', 'Cannot read the active workspace browser layout in the selected wmux window.'],
  ])('fails closed for %s rather than treating it as empty', async (failure, message) => {
    const win = fakeWindow({ created: 'surf-forbidden', layoutAvailable: failure !== 'missing bridge',
      activeWorkspaceId: failure === 'missing workspace' ? null : undefined });
    const execute = win.webContents.executeJavaScript;
    const rejectLayout = vi.fn().mockRejectedValue(new Error('Script failed to execute'));
    const rendererResults: unknown[] = [];
    win.webContents.executeJavaScript = async (js) => {
      if (js.includes('__wmux_listWorkspaces')) {
        if (failure === 'reloading renderer') return rejectLayout();
        if (failure === 'unreadable inventory') return { workspaceId: 'ws-empty' };
        const result = await execute(js);
        rendererResults.push(result);
        return result;
      }
      return execute(js);
    };
    env.windows = [win];
    for (const method of ['browser.snapshot', 'browser.navigate']) {
      expect(await request(method, { url: 'https://fixture.test/' })).toEqual({ code: -32000, message });
    }
    expect(rendererResults).toEqual(failure === 'missing bridge' || failure === 'missing workspace'
      ? [{ error: message }, { error: message }] : []);
    expect(rejectLayout).toHaveBeenCalledTimes(failure === 'reloading renderer' ? 2 : 0);
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it('does not count another workspace or a side panel as a browser in an empty active workspace', async () => {
    env.windows = [fakeWindow({ activeWorkspaceId: 'ws-empty',
      browsersIn: { 'ws-other': ['surf-only-elsewhere'], 'ws-empty': [] }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set('surf-only-elsewhere', 93);
    env.wcIdBySurface.set('browser-ws-empty', 94);
    const answer = await request('browser.snapshot');
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('No browser pane');
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it('pins navigation creation to the chosen window and workspace even if focus changes after the layout read', async () => {
    const selected = fakeWindow({ browsersIn: { 'ws-pinned': [] }, created: 'surf-pinned' });
    const other = fakeWindow({ browsersIn: { 'ws-other': [] }, created: 'surf-forbidden' });
    const execute = selected.webContents.executeJavaScript;
    selected.webContents.executeJavaScript = async (js) => {
      const result = await execute(js);
      if (js.includes('__wmux_listWorkspaces')) env.focusedWindow = other;
      return result;
    };
    env.windows = [other, selected];
    env.focusedWindow = selected;
    env.wcIdBySurface.set('surf-pinned', 95);
    expect(await request('browser.navigate', { url: 'https://fixture.test/' })).toEqual({ result: { ok: true } });
    expect(splitCalls()).toEqual([expect.stringContaining('workspaceId: "ws-pinned"')]);
    expect(other.calls.some((js) => js.includes('__wmux_splitPane'))).toBe(false);
    expect(cdpBridge.navigate).toHaveBeenCalledWith('https://fixture.test/', undefined, 95);
  });

  it('reports a failed pinned split without trying another window or workspace', async () => {
    env.windows = [fakeWindow({ browsersIn: { 'ws-removed': [] } }),
      fakeWindow({ browsersIn: { 'ws-other': ['surf-fallback-forbidden'] }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set('surf-fallback-forbidden', 96);
    const answer = await request('browser.navigate', { url: 'https://fixture.test/' });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('Could not create');
    expect(splitCalls()).toEqual([expect.stringContaining('workspaceId: "ws-removed"')]);
    expectNoDispatch();
  });

  it.each([false, true])('untargeted reuse does not change terminal ownership (already bound: %s)', async (bound) => {
    const owner = nextCaller(), newcomer = nextCaller();
    const surfaceId = `surf-ownership-${owner}`;
    env.windows = [fakeWindow({ workspaceOf: { [owner]: 'ws-owner', [newcomer]: 'ws-owner' },
      browsersIn: { 'ws-owner': [surfaceId] }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set(surfaceId, 97);
    if (bound) await resolveBrowserTarget(owner);
    expect(await request('browser.snapshot')).toEqual({ result: SNAPSHOT });
    if (bound) {
      expect(await resolveBrowserTarget(newcomer)).toBeNull();
      expect(await resolveBrowserTarget(owner)).toEqual({ kind: 'web', wcId: 97 });
    } else {
      expect(await resolveBrowserTarget(newcomer)).toEqual({ kind: 'web', wcId: 97 });
    }
    expect(splitCalls()).toEqual([]);
  });

  it.each(['web', 'agent'])('a closed ambient caller drops its old %s binding and uses the active workspace', async (engine) => {
    const caller = nextCaller();
    const oldId = `surf-ambient-old-${caller}`;
    const workspaceOf = { [caller]: 'ws-old' };
    env.windows = [fakeWindow({ workspaceOf, activeWorkspaceId: 'ws-active',
      browsersIn: { 'ws-old': [oldId], 'ws-active': ['surf-ambient-current'] }, engines: { [oldId]: engine } })];
    env.wcIdBySurface.set(oldId, 98);
    env.wcIdBySurface.set('surf-ambient-current', 99);
    await resolveBrowserTarget(caller);
    delete workspaceOf[caller];
    env.acquired = [];
    expect(await request('browser.snapshot', { caller })).toEqual({ result: SNAPSHOT });
    expect(cdpBridge.snapshot).toHaveBeenCalledWith(99);
    expect(env.acquired).toEqual([]);
    expect(splitCalls()).toEqual([]);
  });

  it.each(['browser.snapshot', 'browser.navigate'])('never substitutes Web when untargeted Agent readiness fails for %s', async (method) => {
    env.windows = [fakeWindow({ browsersIn: { 'ws-agent': ['surf-failing-agent'] },
      engines: { 'surf-failing-agent': 'agent' }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set('surf-failing-agent', 100);
    env.startImpl = async () => { throw new Error('Agent startup failed'); };
    const answer = await request(method, { url: 'https://fixture.test/' });
    expect(answer).toEqual({ code: -32000, message: 'Agent startup failed' });
    expect(splitCalls()).toEqual([]);
    expect(cdpBridge.navigate).not.toHaveBeenCalled();
    expect(cdpBridge.snapshot).not.toHaveBeenCalled();
    expect(env.nativeCalls).toEqual([]);
  });

  it('resolves an untargeted navigation batch once and keeps the chosen Agent session', async () => {
    const win = fakeWindow({ browsersIn: { 'ws-batch-agent': ['surf-batch-agent'] }, engines: { 'surf-batch-agent': 'agent' } });
    env.windows = [win];
    env.nativeImpl = async () => ok(null, SNAPSHOT.tree);
    expect(await request('browser.batch', { commands: [
      { method: 'browser.navigate', params: { url: 'https://fixture.test/' } }, { method: 'browser.snapshot' },
    ] })).toEqual({ result: { results: [{ result: { ok: true } }, { result: SNAPSHOT }] } });
    expect(win.calls.filter((js) => js.includes('__wmux_listWorkspaces'))).toHaveLength(1);
    expect(env.acquired).toEqual(['surf-batch-agent']);
    expect(splitCalls()).toEqual([]);
  });

  it('refuses a closed explicit browser instead of falling back to the active browser', async () => {
    const surfaceId = 'surf-closed-explicit-browser';
    const browsersIn = { 'ws-explicit': [surfaceId] };
    env.windows = [fakeWindow({ browsersIn })];
    env.wcIdBySurface.set(surfaceId, 101);
    await resolveBrowserTarget(undefined, false, surfaceId);
    browsersIn['ws-explicit'] = ['surf-explicit-fallback-forbidden'];
    env.wcIdBySurface.set('surf-explicit-fallback-forbidden', 102);
    const answer = await request('browser.navigate', { surfaceId, url: 'https://fixture.test/' });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('Unknown or closed surface');
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it.each([undefined, null, {}, 'invalid', { 0: { method: 'browser.navigate', params: { url: 'https://fixture.test/' } } }])(
    'rejects non-array batch commands before resolving or splitting: %j', async (commands) => {
      const win = fakeWindow({ created: 'surf-forbidden' });
      env.windows = [win];
      expect(await request('browser.batch', { commands })).toEqual({ code: -32602, message: 'browser.batch commands must be an array' });
      expect(win.calls).toEqual([]);
      expectNoDispatch();
    },
  );

  it.each(['named', 'adopted', 'bound', 'created', 'untargeted', 'untargeted-created'])('reports unavailable CDP as readiness, not missing inventory, for a %s Web surface', async (route) => {
    vi.useFakeTimers();
    try {
      const caller = nextCaller();
      const surfaceId = `surf-not-ready-${caller}`;
      const creates = route === 'created' || route === 'untargeted-created';
      env.windows = [fakeWindow({ workspaceOf: { [caller]: 'ws-not-ready' },
        browsersIn: { 'ws-not-ready': creates ? [] : [surfaceId] }, created: surfaceId })];
      if (route === 'bound') {
        env.wcIdBySurface.set(surfaceId, 86);
        await resolveBrowserTarget(caller);
        env.wcIdBySurface.clear();
      }
      const params = route.startsWith('untargeted') ? {} : route === 'named' ? { surfaceId } : { caller };
      const pending = request(creates ? 'browser.navigate' : 'browser.snapshot', { ...params, url: 'https://fixture.test/' });
      await vi.advanceTimersByTimeAsync(5100);
      const answer = await pending;
      expect(answer.code).toBe(-32000);
      expect(answer.message).toMatch(/readiness|not ready/i);
      expect(answer.message).not.toContain('No browser pane');
      expect(splitCalls()).toHaveLength(creates ? 1 : 0);
      expectNoDispatch();
    } finally { vi.useRealTimers(); }
  });

  it.each(['caller', 'untargeted'])('only a navigation-first batch may create through the %s path', async (route) => {
    const caller = nextCaller();
    const surfaceId = `surf-batch-${caller}`;
    const browsersIn = { 'ws-batch': [] as string[] };
    const win = fakeWindow({ workspaceOf: { [caller]: 'ws-batch' }, browsersIn, created: surfaceId });
    const execute = win.webContents.executeJavaScript;
    win.webContents.executeJavaScript = async (js) => {
      if (js.includes('__wmux_splitPane')) {
        browsersIn['ws-batch'].push(surfaceId);
        env.wcIdBySurface.set(surfaceId, 74);
      }
      return execute(js);
    };
    env.windows = [win];
    const params = route === 'caller' ? { caller } : {};
    const navigate = { method: 'browser.navigate', params: { url: 'https://fixture.test/' } };
    const snapshot = { method: 'browser.snapshot', params: {} };
    expect((await request('browser.batch', { ...params, commands: [snapshot, navigate] })).code).toBe(-32000);
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
    const invalid = await request('browser.batch', { ...params, commands: [{ method: 'browser.navigate', params: { url: ' ' } }, snapshot] });
    expect(invalid).toEqual({ result: { results: [{ error: { code: -32602, message: 'browser.navigate requires a nonempty url' } }] } });
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
    const valid = await request('browser.batch', { ...params, commands: [navigate, snapshot] });
    expect(valid).toEqual({ result: { results: [{ result: { ok: true } }, { result: SNAPSHOT }] } });
    expect(splitCalls()).toHaveLength(1);
  });

  it.each(['browser.snapshot', 'browser.navigate', 'browser.batch'])('refuses a closed explicit terminal with a surviving cached browser for %s', async (method) => {
    const caller = nextCaller();
    const surfaceId = `surf-survivor-${caller}`;
    const workspaceOf = { [caller]: 'ws-old' };
    env.windows = [fakeWindow({ workspaceOf, browsersIn: { 'ws-old': [surfaceId] }, created: 'surf-forbidden' })];
    env.wcIdBySurface.set(surfaceId, 75);
    await resolveBrowserTarget(caller);
    delete workspaceOf[caller];
    const answer = await request(method, { caller: 'surf-other-ambient', surfaceId: caller, url: 'https://fixture.test/',
      commands: [{ method: 'browser.navigate', params: { url: 'https://fixture.test/' } }] });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('Unknown or closed surface');
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });

  it.each(['terminal', 'browser'])('honors a live explicit %s in another window instead of the shared browser', async (type) => {
    const caller = nextCaller();
    const surfaceId = `surf-second-window-${caller}`;
    env.windows = [
      fakeWindow({ browsersIn: { 'ws-unrelated': ['surf-unrelated'] } }),
      fakeWindow({ workspaceOf: { [caller]: 'ws-second' }, browsersIn: { 'ws-second': [surfaceId] } }),
    ];
    env.wcIdBySurface.set('surf-unrelated', 76);
    env.wcIdBySurface.set(surfaceId, 77);
    expect(await request('browser.snapshot', { caller: 'surf-ambient', surfaceId: type === 'terminal' ? caller : surfaceId })).toEqual({ result: SNAPSHOT });
    expect(cdpBridge.snapshot).toHaveBeenCalledWith(77);
    expect(splitCalls()).toEqual([]);
  });

  it('does not fall back to a shared browser when an explicit scoped split fails', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({ browsersIn: { 'ws-shared': ['surf-shared-failure'] } }), fakeWindow({ workspaceOf: { [caller]: 'ws-empty' } })];
    env.wcIdBySurface.set('surf-shared-failure', 78);
    expect((await request('browser.navigate', { surfaceId: caller, url: 'https://fixture.test/' })).code).toBe(-32000);
    expect(splitCalls()).toHaveLength(1);
    expectNoDispatch();
  });

  it('returns an empty batch without resolving a browser or requiring a window', async () => {
    expect(await request('browser.batch', { commands: [] })).toEqual({ result: { results: [] } });
    const win = fakeWindow({ created: 'surf-forbidden' });
    env.windows = [win];
    expect(await request('browser.batch', { commands: [], surfaceId: 'surf-closed' })).toEqual({ result: { results: [] } });
    expect(win.calls).toEqual([]);
    expectNoDispatch();
  });

  it('keeps unknown-method codes without creating a pane, including nested batch errors', async () => {
    env.windows = [fakeWindow({ created: 'surf-forbidden' })];
    expect((await request('browser.unknown')).code).toBe(-32601);
    const batch = await request('browser.batch', { commands: [{ method: 'browser.unknown' }, { method: 'browser.snapshot' }] });
    expect(batch).toEqual({ result: { results: [{ error: { code: -32601, message: 'Unknown: browser.unknown' } }] } });
    expect(splitCalls()).toEqual([]);
    expectNoDispatch();
  });
});

describe('the dashboard reference an agent command takes', () => {
  beforeEach(resetEnv);

  function agentWorld(caller: string, surfaceId: string): void {
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': [surfaceId] },
      engines: { [surfaceId]: 'agent' },
    })];
  }

  it('takes it for the surface the command actually runs against', async () => {
    const caller = nextCaller();
    agentWorld(caller, 'surf-dash');
    await resolveBrowserTarget(caller);
    expect(env.acquired).toEqual(['surf-dash']);
  });

  /**
   * The dashboard is a VIEWER. A cold `dashboard start` can take 30s, which is
   * longer than the CLI's entire client-side deadline for most verbs — so
   * waiting for it would turn "the viewer is slow" into "every browser command
   * times out". Resolution must complete while the acquire is still in flight.
   */
  it('does not wait for the dashboard to come up', async () => {
    const caller = nextCaller();
    agentWorld(caller, 'surf-slow');
    env.acquireImpl = () => new Promise<void>(() => {}); // never settles

    const target = await Promise.race([
      resolveBrowserTarget(caller),
      new Promise((r) => setTimeout(() => r('TIMED_OUT'), 1000)),
    ]);
    expect((target as any)?.kind).toBe('agent');
  });

  it('survives a dashboard that fails to start, and still returns a usable target', async () => {
    const caller = nextCaller();
    agentWorld(caller, 'surf-nodash');
    env.acquireImpl = async () => { throw new Error('dashboard failed to start'); };

    const target = await resolveBrowserTarget(caller);
    expect(target?.kind).toBe('agent');
  });
});

describe('complete agent command readiness budget', () => {
  beforeEach(resetEnv);

  it.each([
    ['browser.snapshot', 'caller'], ['browser.navigate', 'caller'],
    ['browser.snapshot', 'untargeted'], ['browser.navigate', 'untargeted'],
  ])('times out %s readiness including prior %s resolution, with no later requested verb dispatch', async (method, route) => {
    vi.useFakeTimers();
    try {
      const caller = nextCaller();
      const surfaceId = `surf-budget-${caller}`;
      const win = fakeWindow({ workspaceOf: { [caller]: 'ws-budget' }, browsersIn: { 'ws-budget': [surfaceId] }, engines: { [surfaceId]: 'agent' } });
      const execute = win.webContents.executeJavaScript;
      win.webContents.executeJavaScript = async (js) => {
        if (js.includes(route === 'caller' ? '__wmux_locateSurface' : '__wmux_listWorkspaces')) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        return execute(js);
      };
      env.windows = [win];
      const startup = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 3000)); return SESSION; });
      env.startImpl = startup;
      const respond = vi.fn(), error = vi.fn();
      handleBrowserV2(method, { ...(route === 'caller' ? { caller } : {}), url: 'https://fixture.test/' }, respond, error);
      await vi.advanceTimersByTimeAsync(4999);
      expect(startup).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(error).toHaveBeenCalledWith(-32000, expect.stringContaining('retry the command'));
      expect(respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(65000);
      expect(env.nativeCalls).toEqual([]);
      expect(respond).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([['browser.snapshot', 'snapshot'], ['browser.navigate', 'open']] as const)('%s readiness plus native command still fits its public deadline', async (method, verb) => {
    const deadline = browserRequest(['browser', verb, 'https://fixture.test/'])!.timeoutMs;
    vi.useFakeTimers();
    try {
      const caller = nextCaller();
      const surfaceId = `surf-budget-${caller}`;
      env.windows = [fakeWindow({ workspaceOf: { [caller]: 'ws-budget' }, browsersIn: { 'ws-budget': [surfaceId] }, engines: { [surfaceId]: 'agent' } })];
      env.startImpl = async () => { await new Promise((resolve) => setTimeout(resolve, 4000)); return SESSION; };
      env.nativeImpl = async (_argv, timeoutMs) => { await new Promise((resolve) => setTimeout(resolve, timeoutMs)); return ok(null); };
      const respond = vi.fn(), error = vi.fn();
      const start = Date.now();
      handleBrowserV2(method, { caller, url: 'https://fixture.test/' }, respond, error);
      await vi.advanceTimersByTimeAsync(4000);
      expect(env.nativeCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(env.nativeCalls[0].timeoutMs);
      expect(Date.now() - start).toBeLessThan(deadline);
      expect(respond).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('handleBrowserV2 error codes', () => {
  beforeEach(resetEnv);

  const respondTo = (method: string, params: any) =>
    new Promise<{ code?: number; message?: string; result?: any }>((resolve) => {
      handleBrowserV2(method, params, (result) => resolve({ result }), (code, message) => resolve({ code, message }));
    });

  /**
   * The batch loop already forwarded `err.rpcCode ?? -32000` while this path
   * responded a flat -32000, so an unknown verb reported -32601 inside a batch
   * and -32000 as a single command — destroying, one frame up the stack, the
   * engine-indistinguishable -32601 the runner goes to some trouble to produce.
   */
  it('forwards the JSON-RPC code an unknown verb threw, rather than flattening it', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-codes'] },
    })];
    env.wcIdBySurface.set('surf-codes', 4);

    const single = await respondTo('browser.nope', { caller });
    expect(single.code).toBe(-32601);
    expect(single.message).toBe('Unknown: browser.nope');
  });

  it('agrees with the batch path on that code', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-codes2'] },
    })];
    env.wcIdBySurface.set('surf-codes2', 4);

    const batch = await respondTo('browser.batch', { caller, commands: [{ method: 'browser.nope', params: {} }] });
    expect(batch.result.results[0].error.code).toBe(-32601);
  });

  it('still reports a browser that could not be opened as -32000', async () => {
    const answer = await respondTo('browser.snapshot', { caller: nextCaller() });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toContain('No live wmux window');
  });
});

/**
 * A web pane an agent drives keeps painting while the user is on another
 * workspace (browser-keep-rendering.ts). The lease is renewed by the runner,
 * the one place both the single-command and the batch path go through.
 */
describe('runBrowserCommandForTarget — keeps a hidden web pane painting', () => {
  it('renews the lease before the verb runs, so a screenshot finds the pane painting', async () => {
    const order: string[] = [];
    const bridge = makeBridge();
    bridge.screenshot.mockImplementation(async () => { order.push('screenshot'); return 'BASE64'; });
    const keepRendering = vi.fn(async (wcId: number) => { order.push(`lease ${wcId}`); });
    await runBrowserCommandForTarget('browser.screenshot', {}, web(7), { ...deps(bridge), keepRendering });
    expect(order).toEqual(['lease 7', 'screenshot']);
  });

  it('renews it for every web verb, not only screenshots', async () => {
    const keepRendering = vi.fn(async () => {});
    const d = { ...deps(makeBridge()), keepRendering };
    for (const [method, params] of ALL_VERBS) await runBrowserCommandForTarget(method, params, web(5), d);
    expect(keepRendering).toHaveBeenCalledTimes(ALL_VERBS.length);
    expect(keepRendering.mock.calls.every(([wcId]) => wcId === 5)).toBe(true);
  });

  it('never for the agent engine, whose pages a real Chrome paints', async () => {
    const keepRendering = vi.fn(async () => {});
    const runAgent = vi.fn(async () => ok({ url: 'https://a' }));
    await runBrowserCommandForTarget('browser.navigate', { url: 'https://a' }, agent(), { ...deps(makeBridge(), runAgent), keepRendering });
    expect(keepRendering).not.toHaveBeenCalled();
  });

  it('runs the verb anyway when the lease cannot be granted', async () => {
    const bridge = makeBridge();
    const keepRendering = vi.fn(async () => { throw new Error('renderer went away'); });
    const res = await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, web(7), { ...deps(bridge), keepRendering });
    expect(res).toEqual({ result: 42 });
  });
});
