/**
 * A surface-scoped stream subscription, not a Chrome owner. Detach never closes
 * the native session. Tokens and tab revisions fence late decodes and commands;
 * only one frame crosses IPC until the renderer acknowledges drawing/dropping it.
 */
import WebSocket from 'ws';
import type { AgentSession } from './agent-browser-session';
import { agentBrowserPath, runAgentBrowser, unwrapAgentData, type RunResult } from './agent-browser-cli';
import { getStartedSession } from './agent-browser-runtime';
import type { AgentBrowserTab, AgentViewerAction, AgentViewerEvent, AgentViewerInput, AgentViewerMessage, SurfaceId } from '../shared/types';

export interface ViewerDeps {
  session: (id: SurfaceId) => AgentSession | undefined;
  connect: (url: string) => WebSocket;
  run: (session: AgentSession, argv: string[]) => Promise<RunResult>;
  readClipboard: () => string;
  writeClipboard: (text: string) => void;
}

interface Subscription {
  surfaceId: SurfaceId;
  owner: number;
  token: string;
  session: AgentSession;
  socket: WebSocket;
  emit: (event: AgentViewerEvent) => void;
  revision: number;
  activeTab?: string;
  tabs: AgentBrowserTab[];
  visible: boolean;
  workRevision: number;
  tabOperation?: {
    ids: string[];
    originalActive?: string;
    target?: string;
    creating: boolean;
    closing?: string;
    closeDispatched: boolean;
    changed: boolean;
    unexpected: boolean;
  };
  ready: boolean;
  inFlight?: number;
  inFlightRevision?: number;
  presentedRevision?: number;
  pending?: Extract<AgentViewerMessage, { type: 'frame' }>;
  latest?: Extract<AgentViewerMessage, { type: 'frame' }>;
  nextFrame: number;
  queue: Promise<void>;
  queued: number;
}

// Bounds queued pointer/key data while a native operation is in flight.
const MAX_QUEUED_WORK = 256;
// Windows quoting may double the encoded script; leave room for binary/session flags.
const MAX_PASTE_SCRIPT_LENGTH = 12000;

const dimension = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 16384;
const bounded = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;
const member = (v: unknown, values: string[]): boolean => typeof v === 'string' && values.includes(v);

/** Rebuild whitelisted messages: never forward renderer-owned extra fields. */
export function validatedViewerInput(raw: unknown): AgentViewerInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!Number.isInteger(v.modifiers) || !bounded(v.modifiers, 15) || Number(v.modifiers) < 0) return null;
  const modifiers = v.modifiers as number;
  if (v.type === 'input_mouse') {
    if (!member(v.eventType, ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'])
      || !member(v.button, ['none', 'left', 'middle', 'right']) || !bounded(v.x, 16384) || !bounded(v.y, 16384)
      || !Number.isInteger(v.clickCount) || !bounded(v.clickCount, 3)
      || (v.deltaX !== undefined && !bounded(v.deltaX, 100000)) || (v.deltaY !== undefined && !bounded(v.deltaY, 100000))) return null;
    return { type: 'input_mouse', eventType: v.eventType as 'mouseMoved', x: v.x, y: v.y,
      button: v.button as 'left', clickCount: v.clickCount as number, modifiers,
      deltaX: v.deltaX as number | undefined, deltaY: v.deltaY as number | undefined };
  }
  if (v.type !== 'input_keyboard' || !member(v.eventType, ['keyDown', 'rawKeyDown', 'keyUp', 'char'])
    || !Number.isInteger(v.windowsVirtualKeyCode) || !bounded(v.windowsVirtualKeyCode, 255)
    || (v.key !== undefined && !text(v.key, 64)) || (v.code !== undefined && !text(v.code, 64))
    || (v.text !== undefined && !text(v.text))) return null;
  return { type: 'input_keyboard', eventType: v.eventType as 'keyDown', modifiers,
    windowsVirtualKeyCode: v.windowsVirtualKeyCode as number, key: v.key as string | undefined,
    code: v.code as string | undefined, text: v.text as string | undefined };
}

// Fixed main-owned evaluation, not a renderer-provided script or arbitrary eval API.
const COPY_SELECTION = `(() => { const e = document.activeElement;
  if (e && e.tagName === 'INPUT' && e.type === 'password') return '';
  return e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && typeof e.selectionStart === 'number'
    ? e.value.slice(e.selectionStart, e.selectionEnd) : String(window.getSelection() || ''); })()`;

export class AgentBrowserViewer {
  private subscriptions = new Map<SurfaceId, Subscription>();
  private paused = new Map<SurfaceId, string>();
  private attaching = new Map<string, { surfaceId: SurfaceId; owner: number; token: string }>();

  constructor(private deps: ViewerDeps) {}

  /** Record intent before async authorization so detach can fence a not-yet-created socket. */
  async attachAuthorized(surfaceId: SurfaceId, owner: number, token: string,
    authorize: () => Promise<void>, emit: Subscription['emit']): Promise<void> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(token)) throw new Error('Invalid viewer subscription');
    const key = `${owner}:${surfaceId}`;
    const intent = { surfaceId, owner, token };
    this.attaching.set(key, intent);
    try {
      await authorize();
      if (this.attaching.get(key) !== intent) return;
      this.attach(surfaceId, owner, token, emit);
    } finally {
      if (this.attaching.get(key) === intent) this.attaching.delete(key);
    }
  }

  attach(surfaceId: SurfaceId, owner: number, token: string, emit: Subscription['emit']): void {
    if (typeof token !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(token)) throw new Error('Invalid viewer subscription');
    const existing = this.subscriptions.get(surfaceId);
    if (existing && existing.owner !== owner) throw new Error('Unauthorized browser owner');
    this.attaching.delete(`${owner}:${surfaceId}`);
    const session = this.deps.session(surfaceId);
    if (!session) throw new Error('Browser session is not enabled');
    this.dispose(surfaceId);
    const failure = this.paused.get(surfaceId);
    if (failure) throw new Error(failure);
    const socket = this.deps.connect(`ws://127.0.0.1:${session.streamPort}/?pacing=ack&maxFps=30`);
    const sub: Subscription = { surfaceId, owner, token, session, socket, emit, revision: 0,
      ready: false, tabs: [], visible: true, workRevision: 0, nextFrame: 0, queue: Promise.resolve(), queued: 0 };
    this.subscriptions.set(surfaceId, sub);
    socket.on('message', (data) => {
      if (!this.current(sub)) return;
      try { this.receive(sub, JSON.parse(data.toString())); }
      catch { this.fail(sub, 'Invalid page stream protocol. Open dashboard to continue.'); }
    });
    socket.on('error', () => this.fail(sub, 'Page stream connection failed.'));
    socket.on('close', () => this.fail(sub, 'Page stream disconnected.'));
  }

  private current(sub: Subscription): boolean {
    return this.subscriptions.get(sub.surfaceId) === sub && this.deps.session(sub.surfaceId) === sub.session;
  }

  private send(sub: Subscription, message: AgentViewerMessage): void {
    if (this.current(sub)) sub.emit({ surfaceId: sub.surfaceId, token: sub.token, revision: sub.revision, message });
  }

  private fail(sub: Subscription, message: string): void {
    if (!this.current(sub)) return;
    sub.ready = false;
    sub.pending = undefined;
    sub.revision++;
    this.paused.set(sub.surfaceId, message);
    this.send(sub, { type: 'error', message });
    this.dispose(sub.surfaceId);
  }

  private receive(sub: Subscription, v: Record<string, any>): void {
    if (!v || typeof v.type !== 'string') throw new Error('Missing stream message type');
    switch (v.type) {
      case 'status':
        if (typeof v.connected !== 'boolean' || !dimension(v.viewportWidth) || !dimension(v.viewportHeight)) throw new Error('Invalid status');
        if (!v.connected) { this.fail(sub, 'Chrome is unavailable.'); return; }
        sub.ready = true;
        this.send(sub, { type: 'status', connected: true, width: v.viewportWidth, height: v.viewportHeight });
        return;
      case 'frame': {
        if (!text(v.data, 12 * 1024 * 1024) || !v.data.length || !/^[A-Za-z0-9+/=]+$/.test(v.data)
          || !dimension(v.metadata?.deviceWidth) || !dimension(v.metadata?.deviceHeight)) throw new Error('Invalid frame');
        const frame: Extract<AgentViewerMessage, { type: 'frame' }> = { type: 'frame', id: ++sub.nextFrame,
          data: v.data, width: v.metadata.deviceWidth, height: v.metadata.deviceHeight };
        sub.latest = frame;
        if (sub.visible && sub.inFlight === undefined) {
          sub.inFlight = frame.id;
          sub.inFlightRevision = sub.revision;
          this.send(sub, frame);
        }
        else sub.pending = frame;
        if (Number.isSafeInteger(v.seq) && v.seq >= 0) sub.socket.send(JSON.stringify({ type: 'ack', seq: v.seq }));
        return;
      }
      case 'tabs': {
        if (!Array.isArray(v.tabs) || v.tabs.length > 1000) throw new Error('Invalid tabs');
        const tabs: AgentBrowserTab[] = v.tabs.map((tab: Record<string, unknown>) => {
          if (!tab || typeof tab.tabId !== 'string' || !/^t[1-9]\d{0,15}$/.test(tab.tabId)
            || !text(tab.title) || !text(tab.url, 65536) || typeof tab.active !== 'boolean') throw new Error('Invalid tab');
          return { tabId: tab.tabId, title: tab.title, url: tab.url, active: tab.active };
        });
        if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length || tabs.filter((tab) => tab.active).length > 1) throw new Error('Invalid tabs');
        const active = tabs.find((tab) => tab.active)?.tabId;
        const op = sub.tabOperation;
        if (op) {
          const ids = tabs.map((tab) => tab.tabId);
          const sameIds = (expected: string[]) => ids.length === expected.length && expected.every((id) => ids.includes(id));
          const unchanged = !op.changed && active === op.originalActive && sameIds(op.ids);
          if (op.creating && !op.target && active && !op.ids.includes(active)) op.target = active;
          const activatedIds = op.creating && op.target ? [...op.ids, op.target] : op.ids;
          const activated = active === op.target && sameIds(activatedIds);
          const closed = op.closeDispatched && active === op.target && sameIds(activatedIds.filter((id) => id !== op.closing));
          if (!unchanged && !activated && !closed) op.unexpected = true;
          if (!unchanged) op.changed = true;
        }
        sub.tabs = tabs;
        if (sub.activeTab !== active) {
          sub.revision++;
          sub.presentedRevision = undefined;
          sub.pending = undefined;
          sub.latest = undefined;
          sub.activeTab = active;
        }
        this.send(sub, { type: 'tabs', tabs });
        return;
      }
      case 'url':
        if (!text(v.url, 65536)) throw new Error('Invalid URL');
        this.send(sub, { type: 'url', url: v.url });
        return;
      case 'error': this.fail(sub, text(v.message) ? v.message : 'Page stream error.'); return;
      default: return; // Console, command and diagnostic events are not page state.
    }
  }

  private owned(id: SurfaceId, owner: number, token: string): Subscription | undefined {
    const sub = this.subscriptions.get(id);
    return sub && sub.owner === owner && sub.token === token && this.current(sub) ? sub : undefined;
  }

  ack(id: SurfaceId, owner: number, token: string, frameId: number, drawn: boolean): void {
    const sub = this.owned(id, owner, token);
    if (!sub || sub.inFlight !== frameId) return;
    if (drawn === true && sub.visible && sub.inFlightRevision === sub.revision) sub.presentedRevision = sub.revision;
    sub.inFlight = undefined;
    sub.inFlightRevision = undefined;
    if (sub.visible && sub.pending) {
      const frame = sub.pending;
      sub.pending = undefined;
      sub.inFlight = frame.id;
      sub.inFlightRevision = sub.revision;
      this.send(sub, frame);
    }
  }

  /** Native mutations and stream input share receive order and stale-work fences. */
  private enqueue(sub: Subscription, revision: number, requireFrame: boolean, work: () => void | Promise<void>): Promise<void> {
    if (sub.queued >= MAX_QUEUED_WORK) {
      if (this.current(sub) && sub.revision === revision) this.fail(sub, 'Page input queue is full. Input has been paused.');
      return Promise.reject(new Error('Page input queue is full'));
    }
    sub.queued++;
    const workRevision = sub.workRevision;
    const run = sub.queue.then(() => {
      if (!this.current(sub) || !sub.ready || sub.revision !== revision || sub.workRevision !== workRevision) throw new Error('Stale page action');
      if (requireFrame && (!sub.visible || sub.presentedRevision !== revision)) throw new Error('Page frame is not presented');
      return work();
    }).finally(() => { sub.queued--; });
    sub.queue = run.catch(() => {});
    return run;
  }

  input(id: SurfaceId, owner: number, token: string, revision: number, raw: unknown): void | Promise<void> {
    const sub = this.owned(id, owner, token);
    const input = validatedViewerInput(raw);
    if (!sub?.ready || !sub.visible || sub.tabOperation || sub.revision !== revision || sub.presentedRevision !== revision
      || !input || sub.socket.readyState !== WebSocket.OPEN) return;
    return this.enqueue(sub, revision, true, () => {
      if (sub.socket.readyState !== WebSocket.OPEN || sub.socket.bufferedAmount > 65536) {
        this.fail(sub, 'Page input connection is stalled.');
        return;
      }
      sub.socket.send(JSON.stringify(input));
    }).catch(() => {});
  }

  async action(id: SurfaceId, owner: number, token: string, revision: number, raw: unknown): Promise<void> {
    const sub = this.owned(id, owner, token);
    const action = raw as AgentViewerAction;
    if (!sub || !action) throw new Error('Page is not interactive');
    if (action.type === 'visibility') {
      if (typeof action.visible !== 'boolean') throw new Error('Invalid visibility');
      sub.visible = action.visible;
      sub.workRevision++;
      sub.presentedRevision = undefined;
      sub.inFlightRevision = undefined;
      // Static pages need not emit another frame after an unchanged viewport.
      // Replay only the current-tab cache, with a fresh draw acknowledgment.
      if (sub.visible && sub.latest) sub.pending = { ...sub.latest, id: ++sub.nextFrame };
      if (sub.visible && sub.inFlight === undefined && sub.pending) {
        const frame = sub.pending;
        sub.pending = undefined;
        sub.inFlight = frame.id;
        sub.inFlightRevision = sub.revision;
        this.send(sub, frame);
      }
      return;
    }
    if (!sub.ready || sub.revision !== revision) throw new Error('Page is not interactive');
    const requireFrame = action.type === 'copy' || action.type === 'paste';
    if (requireFrame && (!sub.visible || sub.tabOperation || sub.presentedRevision !== revision)) throw new Error('Page frame is not presented');
    if (action.type === 'tab-new' || action.type === 'tab-select' || action.type === 'tab-close') {
      if (action.type !== 'tab-new' && (typeof action.tabId !== 'string' || !/^t[1-9]\d{0,15}$/.test(action.tabId))) throw new Error('Invalid tab ID');
      return this.enqueue(sub, revision, false, () => this.tabAction(sub, action));
    }
    let argv: string[];
    switch (action.type) {
      case 'viewport':
        if (!sub.visible || !dimension(action.width) || !dimension(action.height)) throw new Error('Invalid viewport');
        argv = ['set', 'viewport', String(action.width), String(action.height)]; break;
      case 'paste': {
        const value = this.deps.readClipboard();
        if (!text(value, 1024 * 1024)) throw new Error('Clipboard text is too large');
        if (!value) return;
        const script = `document.execCommand('insertText', false, ${JSON.stringify(value)})`;
        if (script.length > MAX_PASTE_SCRIPT_LENGTH) {
          throw new Error('Clipboard text is too large for a Windows browser command (encoded limit: 12000 characters).');
        }
        argv = ['eval', script];
        break;
      }
      case 'copy': argv = ['eval', COPY_SELECTION]; break;
      case 'navigate':
        if (!text(action.url, 65536) || !/^(https?|file|about):/i.test(action.url)) throw new Error('Invalid browser URL');
        argv = ['open', action.url]; break;
      case 'back': case 'forward': case 'reload': argv = [action.type]; break;
      default: throw new Error('Invalid page action');
    }
    const workRevision = sub.workRevision;
    return this.enqueue(sub, revision, requireFrame, async () => {
      if (action.type === 'viewport' && !sub.visible) throw new Error('Page is hidden');
      let res: RunResult;
      try { res = await this.deps.run(sub.session, argv); }
      catch (err) {
        if (this.current(sub) && sub.revision === revision && sub.workRevision === workRevision) this.fail(sub, 'Native page action could not be launched.');
        throw err;
      }
      if (!this.current(sub) || sub.revision !== revision || sub.workRevision !== workRevision) throw new Error('Stale page action');
      if (!res.ok) {
        const message = res.stderr.trim() || 'Native page action failed.';
        // A history boundary or rejected navigation is not evidence of browser loss.
        if (action.type === 'viewport' || requireFrame) this.fail(sub, message);
        throw new Error(message);
      }
      if (action.type === 'copy') {
        const data = unwrapAgentData(res) as { result?: unknown } | null;
        const value = data?.result;
        if (typeof value !== 'string') throw new Error('Could not read page selection');
        if (value) this.deps.writeClipboard(value);
      }
    });
  }

  /** A close always addresses the original ID, after a safe active replacement. */
  private async tabAction(sub: Subscription, action: Extract<AgentViewerAction, { type: 'tab-new' | 'tab-select' | 'tab-close' }>): Promise<void> {
    const ids = sub.tabs.map((tab) => tab.tabId);
    if (action.type !== 'tab-new' && !ids.includes(action.tabId)) throw new Error('Tab is no longer available');
    const closing = action.type === 'tab-close' ? action.tabId : undefined;
    const creating = action.type === 'tab-new' || (closing === sub.activeTab && ids.length === 1);
    const index = closing ? ids.indexOf(closing) : -1;
    const target = action.type === 'tab-select' ? action.tabId : creating ? undefined
      : closing === sub.activeTab ? ids[index + 1] ?? ids[index - 1] : sub.activeTab;
    if (action.type === 'tab-select' && target === sub.activeTab) return;
    const revision = sub.revision;
    let switched = false;
    const op = { ids, originalActive: sub.activeTab, target, creating, closing,
      closeDispatched: false, changed: false, unexpected: false };
    sub.tabOperation = op;
    // Work queued against the pre-command target is obsolete even if the
    // authoritative stream update follows the native command's completion.
    sub.workRevision++;
    const check = () => {
      if (!this.current(sub) || !sub.ready || op.unexpected) throw new Error('Tabs changed while the action was running.');
    };
    const run = async (argv: string[]) => {
      check();
      const result = await this.deps.run(sub.session, argv);
      check();
      if (!result.ok) throw new Error(result.stderr.trim() || 'Native tab action failed.');
      return result;
    };
    try {
      if (creating) {
        const result = await run(['tab', 'new', 'about:blank']);
        switched = true;
        const data = unwrapAgentData(result) as { tabId?: unknown } | null;
        if (typeof data?.tabId !== 'string' || !/^t[1-9]\d{0,15}$/.test(data.tabId)
          || ids.includes(data.tabId) || (op.target && op.target !== data.tabId)) throw new Error('Could not confirm the new tab.');
        // Native tab-new already activates it. The result covers a stream update
        // arriving after command completion; it never substitutes a visual index.
        op.target = data.tabId;
      } else if (target && target !== sub.activeTab) {
        await run(['tab', target]);
        switched = true;
      }
      if (closing) {
        check();
        op.closeDispatched = true;
        await run(['tab', 'close', closing]);
      }
    } finally {
      if (sub.tabOperation === op) {
        sub.tabOperation = undefined;
        // Observed tab changes already fence old frames by revision. Do not
        // discard a new target's drawn frame, or the original after a refusal.
        if (switched && sub.revision === revision) {
          sub.presentedRevision = undefined;
          sub.inFlightRevision = undefined;
          sub.pending = undefined;
          sub.latest = undefined;
        }
      }
    }
  }

  detach(id: SurfaceId, owner: number, token: string): void {
    const key = `${owner}:${id}`;
    if (this.attaching.get(key)?.token === token) this.attaching.delete(key);
    if (this.owned(id, owner, token)) this.dispose(id);
  }

  canAct(id: SurfaceId): boolean { return !this.paused.has(id); }

  /** Engine/surface teardown alone clears a paused session. */
  forget(id: SurfaceId): void {
    for (const [key, intent] of this.attaching) {
      if (intent.surfaceId === id) this.attaching.delete(key);
    }
    this.dispose(id);
    this.paused.delete(id);
  }

  private dispose(id: SurfaceId): void {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    this.subscriptions.delete(id);
    sub.pending = undefined;
    sub.latest = undefined;
    sub.ready = false;
    // Keep the error listener until close: terminating a connecting ws emits an error.
    sub.socket.removeAllListeners('message');
    sub.socket.terminate();
  }
}

export function createAgentBrowserViewer(clipboard: Pick<ViewerDeps, 'readClipboard' | 'writeClipboard'>): AgentBrowserViewer {
  return new AgentBrowserViewer({
    ...clipboard,
    session: getStartedSession,
    connect: (url) => new WebSocket(url, { maxPayload: 12 * 1024 * 1024, handshakeTimeout: 5000 }),
    run: async (session, argv) => {
      const binary = agentBrowserPath();
      if (!binary) throw new Error('agent-browser is not installed');
      return runAgentBrowser(binary, ['--session', session.sessionName, '--json', ...argv], 10000);
    },
  });
}
