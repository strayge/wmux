/**
 * v2-browser.ts — Per-caller browser routing for V2 pipe handlers.
 *
 * Each distinct caller (an agent's terminal surface, identified by its
 * WMUX_SURFACE_ID and sent as `params.caller`) is bound to its OWN browser
 * surface in that caller's workspace. Among page commands, only navigation
 * can create a browser pane. The CDPBridge tracks every attached browser
 * independently, so concurrent agents no longer share — and clobber — a single
 * browser window. Without valid caller context, commands use the sole browser
 * pane (not a side panel) in the selected window's active workspace.
 *
 * ── Two engines, one set of verbs ─────────────────────────────────────────
 * A browser surface is backed either by the Electron <webview> (`web`, the
 * default and the only thing that existed before) or by vercel-labs
 * agent-browser driving a real Chrome (`agent`). The engine is a property of
 * the SURFACE, resolved here — never of the command. That is the whole design
 * goal: the global CLAUDE.md wmux writes to every machine keeps saying
 * `wmux browser open <url>`, so no agent anywhere has to be re-educated, and
 * only what happens underneath changes. Consequently the two engines must be
 * indistinguishable to a caller in everything it can observe — verb names,
 * result shapes, and the error for a verb neither supports.
 */
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { cdpBridge } from './ipc-handlers';
import { unwrapAgentData, type RunResult } from './agent-browser-cli';
import { AGENT_BROWSER_COMMAND_TIMEOUT_MS } from './agent-browser-control';
import { acquireDashboardFor, ensureStartedSession, runAgentBrowserForSession, withDeadline } from './agent-browser-runtime';
import type { AgentSession } from './agent-browser-session';
import { toAgentBrowserArgv } from './agent-browser-verbs';
import { keepRenderingLeases } from './browser-keep-rendering';
import { targetForCaller, type CallerTarget } from './v2-bridge';
import type { BrowserEngine, SurfaceId } from '../shared/types';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

/**
 * A resolved place to run a browser verb.
 *
 * `web` carries the guest webContents id the CDPBridge addresses; `agent`
 * carries the agent-browser session every argv is pinned to. Resolution
 * produces one of these once, and the command runner switches on it once — so
 * there is exactly one place in the codebase that knows an engine exists.
 */
export type BrowserTarget =
  | { kind: 'web'; wcId: number }
  | { kind: 'agent'; session: AgentSession };

/**
 * Injected so routing is unit-testable with no Electron, no CDP and no daemon
 * — the two things this module does that are hard to fake are precisely the
 * two things behind this interface.
 */
export interface BrowserDeps {
  bridge: typeof cdpBridge;
  runAgent: (argv: string[], timeoutMs: number) => Promise<RunResult>;
  /**
   * An agent is driving this web pane: keep it painting while it is hidden
   * (browser-keep-rendering.ts). Optional, so fakes that do not care need not
   * provide it.
   */
  keepRendering?: (wcId: number) => Promise<void>;
}

/** Layout membership, not CDP attachment order, authorizes untargeted commands. */
async function resolveUntargetedBrowserTarget(allowCreate: boolean): Promise<BrowserTarget | null> {
  const live = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (!live.length) throw new Error('No live wmux window is available.');
  const focused = BrowserWindow.getFocusedWindow();
  const win = focused && live.includes(focused) ? focused : live.length === 1 ? live[0] : null;
  if (!win) throw new Error('Multiple wmux windows are open and none is focused. Pass --surface <id> to choose a target.');

  // Both globals run synchronously in one renderer turn: focus cannot change
  // the active workspace between reading its id and counting its browser tabs.
  const layout = await win.webContents.executeJavaScript(`(() => {
    if (!window.__wmux_listWorkspaces || !window.__wmux_listBrowserSurfaces)
      return { error: 'Browser workspace layout is unavailable in the selected wmux window.' };
    const workspace = window.__wmux_listWorkspaces().find(ws => ws.isActive);
    if (!workspace) return { error: 'No active workspace in the selected wmux window.' };
    return { workspaceId: workspace.id, surfaceIds: window.__wmux_listBrowserSurfaces(workspace.id) };
  })()`).catch(() => {
    throw new Error('Browser workspace layout is unavailable in the selected wmux window.');
  });
  if (typeof layout?.error === 'string') throw new Error(layout.error);
  if (typeof layout?.workspaceId !== 'string' || !layout.workspaceId || !Array.isArray(layout.surfaceIds)
    || !layout.surfaceIds.every((id: unknown) => typeof id === 'string' && id)) {
    throw new Error('Cannot read the active workspace browser layout in the selected wmux window.');
  }
  if (layout.surfaceIds.length > 1) {
    throw new Error('Multiple browser panes are available in the active workspace. Pass --surface <id> to choose a target.');
  }
  let surfaceId: string | undefined = layout.surfaceIds[0];
  if (!surfaceId) {
    if (!allowCreate) return null;
    const created = await win.webContents.executeJavaScript(
      `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser', workspaceId: ${JSON.stringify(layout.workspaceId)} }) ?? null`,
    );
    surfaceId = created?.surfaceId;
    if (!surfaceId) throw new Error('Could not create a browser surface in the selected workspace.');
  }
  if ((await engineForSurface(surfaceId)) === 'agent') return agentTargetFor(surfaceId);
  return { kind: 'web', wcId: await pollSurfaceWcId(surfaceId, 5000) };
}

// caller terminal surface → its own browser surface. boundBrowserSurfaces tracks
// which browser surfaces are already owned so a second agent never adopts the
// first agent's browser.
const callerBrowserSurface = new Map<string, string>();
const boundBrowserSurfaces = new Set<string>();

async function pollSurfaceWcId(surfaceId: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wcId = cdpBridge.wcIdForSurface(surfaceId);
    if (wcId !== null) return wcId;
    await new Promise((r) => setTimeout(r, 100));
  }
  const wcId = cdpBridge.wcIdForSurface(surfaceId);
  if (wcId !== null) return wcId;
  throw new Error(`Browser surface ${surfaceId} is not ready: CDP did not attach within ${timeoutMs}ms. Retry once the page is ready.`);
}

/**
 * Renderer membership validates cached bindings before CDP or Agent dispatch.
 * Among page commands, only navigation may create a pane. Null also represents
 * an Agent binding, whose session is resolved by the caller rather than polled
 * for CDP.
 */
async function resolveBrowserWcId(caller: string, allowCreate: boolean, located: CallerTarget<BrowserWindow>): Promise<number | null> {
  const { win, workspaceId } = located;

  // Adopt an existing unowned browser surface in the workspace (e.g. one the user
  // opened manually); among page commands, only navigation may create one there.
  const existing: string[] = await win.webContents.executeJavaScript(
    `window.__wmux_listBrowserSurfaces?.(${JSON.stringify(workspaceId)}) ?? []`,
  );

  // `--surface <id>` may name a BROWSER surface — the documented meaning of the
  // flag is "whose browser to drive" — rather than a terminal that owns one.
  // Without this, the browser's id was treated as a brand-new terminal caller:
  // every browser in the workspace was already bound, so a fresh pane was split
  // for it, and an agent that then targeted the pane it could see (the newest)
  // split another on every command. Same precedence `pickBrowserSurface` gives
  // `browser engine`, fixed there in 2.1.0 and never carried over to the verbs.
  // Bound to itself for subsequent resolution, but NOT added
  // to `boundBrowserSurfaces`: naming a pane is not owning it, and a terminal
  // agent may still adopt it.
  if (existing.includes(caller)) {
    callerBrowserSurface.set(caller, caller);
    if ((await engineForSurface(caller)) === 'agent') return null;
    return pollSurfaceWcId(caller, 5000);
  }

  // Renderer membership, not an engine value or a lingering CDP registration,
  // proves a cached surface is live. Keep live Agent bindings without CDP.
  const bound = callerBrowserSurface.get(caller);
  if (bound && existing.includes(bound)) {
    if ((await engineForSurface(bound)) === 'agent') return null;
    return pollSurfaceWcId(bound, 5000);
  }
  if (bound) {
    callerBrowserSurface.delete(caller);
    if (bound !== caller) boundBrowserSurfaces.delete(bound);
  }

  let browserSurfaceId = existing.find((id) => !boundBrowserSurfaces.has(id)) ?? null;
  if (!browserSurfaceId && allowCreate) {
    const created = await win.webContents.executeJavaScript(
      `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser', workspaceId: ${JSON.stringify(workspaceId)} }) ?? null`,
    );
    browserSurfaceId = created?.surfaceId ?? null;
  }
  if (!browserSurfaceId) return null;

  callerBrowserSurface.set(caller, browserSurfaceId);
  boundBrowserSurfaces.add(browserSurfaceId);
  // An agent-mode surface is not driven over CDP, so waiting for a wcId to
  // attach is pure latency — up to the full 5s, on the first command a caller
  // ever issues, every time. Give up immediately instead; `resolveBrowserTarget`
  // re-reads this binding and routes it to the agent engine. The answer is the
  // same either way, it just arrives 5s sooner, which matters because the CLI's
  // client-side deadline is spending that time too.
  if ((await engineForSurface(browserSurfaceId)) === 'agent') return null;
  return pollSurfaceWcId(browserSurfaceId, 5000);
}

/**
 * Which engine backs this browser surface?
 *
 * Asked of the RENDERER, because the split tree lives in the Zustand store and
 * main has no copy of it. Three details are load-bearing:
 *
 *  - EVERY window is asked, first affirmative answer wins. A surface may live
 *    in a different window; using only the first silently picks the wrong engine.
 *  - `?.` and `?? 'web'` let this ship before the renderer half exists: a
 *    renderer that has never heard of `__wmux_getBrowserEngine` degrades to
 *    exactly today's behaviour instead of throwing on every browser command.
 *  - a rejected `executeJavaScript` (renderer reloading, webContents destroyed
 *    mid-flight) is 'web', not a failure. This runs on the hot path of every
 *    command, where it previously did no renderer IPC at all; without the catch
 *    it would be a brand-new way for a working command to fail -32000.
 */
async function engineForSurface(surfaceId: string): Promise<BrowserEngine> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const engine = await win.webContents
      .executeJavaScript(`window.__wmux_getBrowserEngine?.(${JSON.stringify(surfaceId)}) ?? 'web'`)
      .catch(() => 'web');
    if (engine === 'agent') return 'agent';
  }
  return 'web';
}

/**
 * Ready an agent-mode surface: its session, and the dashboard that displays it.
 *
 * The dashboard reference is taken but NOT awaited, and that is the whole
 * point. agent-browser drives Chrome perfectly well without its viewer, so the
 * verb has nothing to gain by waiting — while a cold `dashboard start` can take
 * 30s, which is longer than the CLI's entire client-side deadline for most
 * verbs (see AGENT_*_MS below). Blocking here would turn "the viewer is slow"
 * into "every browser command times out", which is precisely the failure
 * `tests/unit/browser-timeout.test.ts` exists to prevent.
 *
 * The failure is logged rather than swallowed: it is invisible to the user
 * otherwise. It is deliberately not fatal — but it is also not harmless. The
 * pane loads the dashboard url in its webview, so a dashboard that never
 * started would render ERR_CONNECTION_REFUSED, which reads as "my browser is
 * broken" rather than "an optional viewer did not start". `BrowserPane` closes
 * that gap on the renderer side: it checks `dashboardAvailable` before ever
 * calling `loadURL` and shows a distinct no-dashboard card, so the interstitial
 * is never painted. This log is the main-side half of the same story.
 */
async function agentTargetFor(surfaceId: string): Promise<BrowserTarget> {
  // Deliberately NOT awaited — see above. `.catch` is what keeps an unawaited
  // rejection from surfacing as an unhandled promise rejection.
  acquireDashboardFor(surfaceId).catch((err: Error) => {
    console.warn('[wmux] agent-browser dashboard did not start:', err?.message);
  });
  return { kind: 'agent', session: await ensureStartedSession(surfaceId as SurfaceId) };
}

/**
 * Readiness includes renderer resolution and Agent startup, not the optional
 * dashboard. Even a non-null CDP registration must respect an engine toggle.
 */
export async function resolveBrowserTarget(caller?: string, allowCreate = false, surfaceId?: string): Promise<BrowserTarget | null> {
  // The public CLI budgets already reserve 5s for readiness. Shared UI startup
  // may continue after this request gives up, but its requested verb must not.
  const outcome = await withDeadline<{ target: BrowserTarget | null } | { error: unknown }>(
    resolveBrowserTargetWithinBudget(surfaceId ?? caller, allowCreate, surfaceId !== undefined).then((target) => ({ target }), (error: unknown) => ({ error })),
    5000,
    { error: new Error('Browser readiness timed out after 5s. The session may still be starting; retry the command once the page is ready.') },
  );
  if ('error' in outcome) throw outcome.error;
  return outcome.target;
}

async function resolveBrowserTargetWithinBudget(caller: string | undefined, allowCreate: boolean, explicit: boolean): Promise<BrowserTarget | null> {
  if (!caller) return resolveUntargetedBrowserTarget(allowCreate);
  // A closed terminal's surviving binding no longer authorizes targeting it.
  const located = await targetForCaller(caller);
  // The bridge's fallback window has no workspace id: it is not ownership.
  if (!located?.workspaceId) {
    const bound = callerBrowserSurface.get(caller);
    callerBrowserSurface.delete(caller);
    if (bound && bound !== caller) boundBrowserSurfaces.delete(bound);
    if (explicit) throw new Error(`Unknown or closed surface: ${caller}. Run wmux list-surfaces to check.`);
    return resolveUntargetedBrowserTarget(allowCreate);
  }
  const wcId = await resolveBrowserWcId(caller, allowCreate, located);

  // Only bindings verified against the renderer by resolution may start a
  // session. A stale engine value must never resurrect a closed browser.
  const settled = callerBrowserSurface.get(caller);
  if (settled && (await engineForSurface(settled)) === 'agent') {
    return agentTargetFor(settled);
  }

  return wcId === null ? null : { kind: 'web', wcId };
}

/** Does `data` actually carry `key`, as opposed to merely not contradicting it?
 *
 *  A `??` chain cannot answer this: `data.result ?? fallback` replaces a
 *  perfectly good `false`, `0` or `''` with the fallback, which for
 *  `browser.eval` means an agent that evaluated `document.hidden` gets the raw
 *  stdout instead of `false`. */
function hasField(data: unknown, key: string): boolean {
  return !!data && typeof data === 'object' && key in (data as Record<string, unknown>);
}

const field = (data: unknown, key: string): any =>
  hasField(data, key) ? (data as Record<string, unknown>)[key] : undefined;

/**
 * How many refs a snapshot tree exposes, counted from the tree itself.
 *
 * The `--json` payload carries a `refs` map and this is unnecessary — but the
 * argv wmux sends for `snapshot` does not pass `--json`, so what actually
 * arrives is the bare tree text, in which every ref appears as `[ref=e1]` /
 * `[level=1, ref=e2]`. Counting DISTINCT ids rather than matches, because a
 * ref can legitimately be mentioned more than once.
 */
function countRefs(tree: string): number {
  return new Set([...tree.matchAll(/\bref=(e\d+)/g)].map((m) => m[1])).size;
}

/**
 * Coerce an agent-browser result into the shape the WEB engine returns for the
 * same verb, so a caller written against one engine keeps working against the
 * other. This is the second half of engine indistinguishability (the first
 * being the shared `-32601`), and the reason it lives next to the web switch:
 * the two must be read together, and a shape changed on one side without the
 * other is the bug this function exists to make obvious.
 *
 * Every branch handles BOTH forms agent-browser can answer in, because which
 * one arrives depends on whether the verb's argv carries `--json` (only
 * `screenshot`'s does today). With it, the payload is wrapped in
 * `{success, data, error}` — `unwrapAgentData` strips that. Without it, the
 * verb prints bare text and `stdout` is the whole answer. Field names below are
 * from actual 0.35.0 output, not from the docs:
 *
 *     snapshot   → data.snapshot (tree) + data.refs (map keyed e1/e2)
 *     get text   → data.text  ·  read → data.content
 *     eval       → data.result
 *     screenshot → data.path — a PNG on disk, NOT base64
 */
async function agentResultShape(method: string, res: RunResult): Promise<any> {
  const data = unwrapAgentData(res);
  switch (method) {
    case 'browser.snapshot': {
      // The web engine answers {tree, refCount}. Passing agent-browser's
      // payload through verbatim — which is what this used to do — handed the
      // agent a completely different object depending on the engine.
      // `res.stdout` carries the trailing newline the CLI printed; the `--json`
      // payload does not. Trim so the two forms of the SAME snapshot are
      // byte-identical — an engine-parity bug small enough to be invisible
      // until something diffs two trees and finds them different.
      const tree: string = field(data, 'snapshot') ?? res.stdout.trimEnd();
      const refs = field(data, 'refs');
      return { tree, refCount: refs ? Object.keys(refs).length : countRefs(tree) };
    }
    case 'browser.get_text':
      return { text: field(data, 'text') ?? field(data, 'content') ?? res.stdout };
    case 'browser.screenshot':
      return { data: await screenshotBase64(data, res) };
    case 'browser.eval':
      if (hasField(data, 'result')) return { result: field(data, 'result') };
      // Bare stdout is text: `eval 1+1` prints `2`, where the web engine
      // returns the number 2. Recover the value when it round-trips as JSON so
      // the two engines agree on the TYPE, not merely on the digits.
      return { result: jsonOrText(res.stdout) };
    default:
      return { ok: true };
  }
}

/** Parse stdout as JSON when it is JSON, else hand back the trimmed text. */
function jsonOrText(stdout: string): unknown {
  const raw = stdout.trim();
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Base64 PNG, the way the web engine answers `browser.screenshot`.
 *
 * `cdpBridge.screenshot` returns `Page.captureScreenshot`'s base64 `data`
 * directly. agent-browser has no equivalent: `screenshot [selector] [path]`
 * always WRITES A FILE and reports its path (`data.path`), with no flag to emit
 * bytes on stdout. So parity has to be bought by reading the file back.
 *
 * A failed read falls through to whatever else the payload offered rather than
 * throwing: a screenshot that cannot be encoded is worth reporting as an empty
 * result, not worth failing the agent's whole command over.
 */
async function screenshotBase64(data: unknown, res: RunResult): Promise<string> {
  const filePath = field(data, 'path');
  if (typeof filePath === 'string' && filePath) {
    try {
      return (await fs.promises.readFile(filePath)).toString('base64');
    } catch {
      /* fall through to the shapes below */
    }
  }
  return field(data, 'data') ?? field(data, 'base64') ?? res.stdout.trim();
}

/**
 * What went wrong when an agent-browser invocation failed.
 *
 * `spawnFailed` and a non-zero exit are opposite problems and must not be
 * collapsed into one message (see `RunResult.spawnFailed`). A non-zero exit is
 * the CLI reporting on the page — its `stderr` is the useful thing and belongs
 * verbatim in front of the agent. A spawn failure means the process never ran:
 * `stderr` is empty, so echoing it would surface a blank error for what is
 * really a wmux/install fault, and the actionable advice ("re-resolve the
 * binary") is something no page-level message could convey. The thrown error
 * carries `spawnFailed` as a property too, so a caller can react rather than
 * having to pattern-match English.
 */
function agentFailure(method: string, res: RunResult): Error {
  if (res.spawnFailed) {
    return Object.assign(
      new Error(
        `agent-browser could not be launched for ${method} — the binary may have moved or been uninstalled. ` +
        `Reopen the pane in agent mode to re-resolve it.`,
      ),
      { spawnFailed: true },
    );
  }
  // A `--json` failure carries the reason in the envelope's `error` field
  // (`{"success":false,"data":null,"error":"Unknown ref: e1"}`) and prints the
  // same thing to stderr as `✗ Unknown ref: e1`. Prefer the structured field —
  // it is the message without the decoration — and fall back to the streams.
  const enveloped = res.data as { error?: unknown } | null;
  const structured = typeof enveloped?.error === 'string' ? enveloped.error.trim() : '';
  return Object.assign(
    new Error(structured || res.stderr.trim() || res.stdout.trim() || `agent-browser ${method} failed`),
    { spawnFailed: false },
  );
}

/**
 * Run one browser verb against an already-resolved target. Shared by the
 * single-command and batch paths so there's one source of truth (and no deeply
 * nested handler maps).
 */
export async function runBrowserCommandForTarget(
  method: string,
  params: any,
  target: BrowserTarget,
  deps: BrowserDeps,
): Promise<any> {
  validateBrowserCommand(method, params);
  if (target.kind === 'agent') {
    // Built FIRST, before anything is spawned: an unsupported verb must cost a
    // rejected message, not a Chrome round-trip. `toAgentBrowserArgv` throws
    // the identical -32601 the web switch below does, which is what makes the
    // engines indistinguishable for an unknown verb.
    const argv = toAgentBrowserArgv(method, params, target.session.sessionName);
    const res = await deps.runAgent(argv, agentTimeoutFor(method, params));
    if (!res.ok) throw agentFailure(method, res);
    return agentResultShape(method, res);
  }

  const { wcId } = target;
  const bridge = deps.bridge;
  // Before the verb, so a pane on another workspace is painting again by the
  // time a screenshot waits for its frame. A lease that cannot be granted
  // leaves the verb to run exactly as it did before leases existed.
  if (deps.keepRendering) await deps.keepRendering(wcId).catch(() => {});
  switch (method) {
    case 'browser.navigate':
      await bridge.navigate(params?.url, params?.timeout, wcId);
      return { ok: true };
    case 'browser.snapshot':
      return bridge.snapshot(wcId);
    case 'browser.click':
      await bridge.click(params?.ref, wcId);
      return { ok: true };
    case 'browser.type':
      await bridge.type(params?.ref, params?.text, wcId);
      return { ok: true };
    case 'browser.fill':
      await bridge.fill(params?.ref, params?.value, wcId);
      return { ok: true };
    case 'browser.screenshot':
      return { data: await bridge.screenshot(params?.fullPage, wcId) };
    case 'browser.get_text':
      return { text: await bridge.getText(params?.ref, wcId) };
    case 'browser.eval':
      return { result: await bridge.evaluate(params?.js, wcId) };
    case 'browser.wait':
      await bridge.wait(params?.ref, params?.timeout, wcId);
      return { ok: true };
    case 'browser.back':
      await bridge.goBack(wcId);
      return { ok: true };
    case 'browser.forward':
      await bridge.goForward(wcId);
      return { ok: true };
    case 'browser.reload':
      await bridge.reload(wcId);
      return { ok: true };
    default: {
      const unhandled: never = method;
      throw Object.assign(new Error(`Unknown: ${unhandled}`), { rpcCode: -32601 });
    }
  }
}

/**
 * Native action deadlines should return their own result before wmux's hard
 * watchdog fires. The public CLI outwaits readiness plus this budget. Explicit
 * longer waits still reserve room for the session's pre/post identity checks.
 */
const AGENT_WAIT_MS = 10000;
const AGENT_WAIT_GUARD_MS = 3000;

function agentTimeoutFor(method: string, params: any): number {
  const wait = method === 'browser.wait'
    ? (typeof params?.timeout === 'number' ? params.timeout : AGENT_WAIT_MS) + AGENT_WAIT_GUARD_MS : 0;
  return Math.max(AGENT_BROWSER_COMMAND_TIMEOUT_MS, wait);
}

/** The real machine behind `BrowserDeps`. Every production call uses this. */
const defaultDeps: BrowserDeps = {
  bridge: cdpBridge,
  runAgent: runAgentBrowserForSession,
  keepRendering: async (wcId) => keepRenderingLeases.touch(wcId, cdpBridge.surfaceIdFor(wcId)),
};

const NO_BROWSER = 'No browser pane is available. Run wmux list-surfaces to check, or wmux browser open <url> to open one.';

const BROWSER_METHODS = [
  'browser.navigate', 'browser.snapshot', 'browser.click', 'browser.type', 'browser.fill',
  'browser.screenshot', 'browser.get_text', 'browser.eval', 'browser.wait', 'browser.back',
  'browser.forward', 'browser.reload',
] as const;
type BrowserMethod = typeof BROWSER_METHODS[number];

/** Reject invalid navigation before layout mutation; keep the web switch exhaustive. */
function validateBrowserCommand(method: string, params: any): asserts method is BrowserMethod {
  if (!(BROWSER_METHODS as readonly string[]).includes(method)) {
    throw Object.assign(new Error(`Unknown: ${method}`), { rpcCode: -32601 });
  }
  if (method === 'browser.navigate' && (typeof params?.url !== 'string' || !params.url.trim())) {
    throw Object.assign(new Error('browser.navigate requires a nonempty url'), { rpcCode: -32602 });
  }
}

async function handleBrowserBatch(params: any, respond: Respond, respondError: RespondError): Promise<void> {
  if (!Array.isArray(params?.commands)) {
    respondError(-32602, 'browser.batch commands must be an array');
    return;
  }
  if (params.commands.length === 0) {
    respond({ results: [] });
    return;
  }
  const first = params.commands[0];
  try {
    if (first) validateBrowserCommand(first.method, first.params);
  } catch (err: any) {
    respond({ results: [{ error: { code: err.rpcCode ?? -32000, message: err.message } }] });
    return;
  }
  const target = await resolveBrowserTarget(params?.caller, first?.method === 'browser.navigate', params?.surfaceId);
  if (target === null) { respondError(-32000, NO_BROWSER); return; }
  const results: any[] = [];
  for (const cmd of params?.commands || []) {
    try {
      results.push({ result: await runBrowserCommandForTarget(cmd.method, cmd.params, target, defaultDeps) });
    } catch (err: any) {
      results.push({ error: { code: err.rpcCode ?? -32000, message: err.message } });
      break;
    }
  }
  respond({ results });
}

/** Entry point: handle any `browser.*` V2 method. */
export function handleBrowserV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): void {
  (async () => {
    if (params?.surfaceId !== undefined && (typeof params.surfaceId !== 'string' || !params.surfaceId.trim())) {
      respondError(-32602, 'surfaceId must be a nonempty string');
      return;
    }
    if (method === 'browser.batch') {
      await handleBrowserBatch(params, respond, respondError);
      return;
    }
    validateBrowserCommand(method, params);
    const target = await resolveBrowserTarget(params?.caller, method === 'browser.navigate', params?.surfaceId);
    if (target === null) { respondError(-32000, NO_BROWSER); return; }
    respond(await runBrowserCommandForTarget(method, params, target, defaultDeps));
    // `err.rpcCode ?? -32000`, matching the batch loop. It used to be a flat
    // -32000 here, so an unknown verb reported -32601 inside a batch and -32000
    // as a single command — undoing, one frame up, the engine-indistinguishable
    // -32601 that runBrowserCommandForTarget goes to some trouble to produce.
  })().catch((err: any) => respondError(err?.rpcCode ?? -32000, err?.message));
}
