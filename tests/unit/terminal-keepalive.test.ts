// @vitest-environment jsdom
import { createElement, act, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalKeepAlive } from '../../src/renderer/components/Terminal/terminal-keepalive';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #346: a split-tree change remounted the pane and with it the xterm, so
// every piece of terminal state had to be replayed by hand (#49, #164, #216,
// #256, #345). The terminal now lives once per surface and only its element
// moves between pane slots.
// ─────────────────────────────────────────────────────────────────────────────

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface P { visible: boolean; label?: string }

function slot(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('TerminalKeepAlive registry', () => {
  let alive: Set<string>;
  let deferred: Array<() => void>;
  let parking: HTMLElement;
  let reg: TerminalKeepAlive<P>;

  beforeEach(() => {
    document.body.innerHTML = '';
    alive = new Set(['surf-1']);
    deferred = [];
    parking = slot();
    reg = new TerminalKeepAlive<P>({
      isAlive: (id) => alive.has(id),
      parkedProps: (p) => ({ ...p, visible: false }),
      parkingRoot: () => parking,
      defer: (fn) => deferred.push(fn),
    });
  });

  it('creates the element on first claim and puts it in the slot', () => {
    const a = slot();
    reg.claim('surf-1', {}, a, { visible: true });
    expect(reg.ids()).toEqual(['surf-1']);
    expect(reg.get('surf-1')!.el.parentElement).toBe(a);
  });

  it('moves the SAME element to the next slot on a remount', () => {
    const [a, b] = [slot(), slot()];
    const ownerA = {};
    const ownerB = {};
    reg.claim('surf-1', ownerA, a, { visible: true });
    const el = reg.get('surf-1')!.el;
    const generation = reg.get('surf-1')!.generation;

    // React's order inside one commit: the old slot's cleanup, then the new one.
    reg.release('surf-1', ownerA);
    reg.claim('surf-1', ownerB, b, { visible: true });

    expect(reg.get('surf-1')!.el).toBe(el);
    expect(el.parentElement).toBe(b);
    expect(reg.get('surf-1')!.generation).toBe(generation + 1);
    expect(deferred).toHaveLength(0);
  });

  it('ignores a stale release from a slot that no longer owns it', () => {
    const [a, b] = [slot(), slot()];
    const ownerA = {};
    reg.claim('surf-1', ownerA, a, { visible: true });
    reg.claim('surf-1', {}, b, { visible: true });
    reg.release('surf-1', ownerA);
    expect(reg.get('surf-1')!.el.parentElement).toBe(b);
    expect(reg.get('surf-1')!.props.visible).toBe(true);
  });

  it('parks a live surface hidden and at the size it had', () => {
    const a = slot();
    const owner = {};
    reg.claim('surf-1', owner, a, { visible: true });
    const el = reg.get('surf-1')!.el;
    el.getBoundingClientRect = () => ({ width: 640, height: 300 }) as DOMRect;

    reg.release('surf-1', owner);

    expect(el.parentElement).toBe(parking);
    expect(el.style.width).toBe('640px');
    expect(el.style.height).toBe('300px');
    expect(reg.get('surf-1')!.props.visible).toBe(false);
    expect(reg.ids()).toEqual(['surf-1']);
  });

  it('never parks at 0×0, which would fit the terminal to two columns', () => {
    const owner = {};
    reg.claim('surf-1', owner, slot(), { visible: true });
    reg.release('surf-1', owner); // jsdom measures 0×0
    expect(reg.get('surf-1')!.el.style.width).toBe('100%');
  });

  it('fills the slot again when re-claimed', () => {
    const owner = {};
    reg.claim('surf-1', owner, slot(), { visible: true });
    const el = reg.get('surf-1')!.el;
    el.getBoundingClientRect = () => ({ width: 640, height: 300 }) as DOMRect;
    reg.release('surf-1', owner);
    reg.claim('surf-1', {}, slot(), { visible: true });
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('100%');
  });

  it('drops a terminal whose surface is gone, after the commit', () => {
    const owner = {};
    reg.claim('surf-1', owner, slot(), { visible: true });
    alive.delete('surf-1');
    reg.release('surf-1', owner);
    expect(reg.ids()).toEqual(['surf-1']);
    deferred.forEach((fn) => fn());
    expect(reg.ids()).toEqual([]);
    expect(reg.get('surf-1')).toBeUndefined();
  });

  it('a sweep drops only parked terminals of dead surfaces', () => {
    alive.add('surf-2');
    const owner1 = {};
    reg.claim('surf-1', owner1, slot(), { visible: true });
    reg.claim('surf-2', {}, slot(), { visible: true });
    reg.release('surf-1', owner1);
    expect(reg.hasParked()).toBe(true);

    alive.clear();
    reg.sweep();
    // surf-2 is still claimed by a slot: a slot's own release decides for it.
    expect(reg.ids()).toEqual(['surf-2']);
    expect(reg.hasParked()).toBe(false);
  });

  it('notifies an entry only when its props actually change', () => {
    const owner = {};
    const props = { visible: true, label: 'a' };
    reg.claim('surf-1', owner, slot(), props);
    const listener = vi.fn();
    reg.subscribeEntry('surf-1', listener);
    reg.update('surf-1', owner, { visible: true, label: 'a' });
    expect(listener).not.toHaveBeenCalled();
    reg.update('surf-1', owner, { visible: true, label: 'b' });
    expect(listener).toHaveBeenCalledOnce();
    reg.update('surf-1', {}, { visible: false });
    expect(reg.get('surf-1')!.props.label).toBe('b');
  });
});

// ── The React half, with TerminalPane replaced by a mount counter ────────────

const mounts = { mounted: 0, unmounted: 0 };
vi.mock('../../src/renderer/components/Terminal/TerminalPane', () => ({
  default: function FakeTerminalPane(props: { surfaceId: string; visible?: boolean; attachGeneration?: number; piSessionId?: string; piSessionCwd?: string }) {
    useEffect(() => {
      mounts.mounted += 1;
      return () => { mounts.unmounted += 1; };
    }, []);
    return createElement('div', {
      className: 'fake-term',
      'data-visible': String(props.visible),
      'data-generation': String(props.attachGeneration),
      'data-pi-session': props.piSessionId,
      'data-pi-cwd': props.piSessionCwd,
    });
  },
}));

describe('KeptAliveTerminal + TerminalHost', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    mounts.mounted = 0;
    mounts.unmounted = 0;
  });

  async function setup() {
    const { useStore } = await import('../../src/renderer/store');
    const mod = await import('../../src/renderer/components/Terminal/KeptAliveTerminal');
    const setSurfaces = (ids: string[]) => useStore.setState({
      workspaces: [{
        id: 'ws-1', title: 'W', pinned: false, shell: '',
        splitTree: { type: 'leaf', paneId: 'pane-1', activeSurfaceIndex: 0, surfaces: ids.map((id) => ({ id, type: 'terminal' })) },
      }],
    } as never);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (pane: ReactElement | null) => act(() => {
      root!.render(createElement('div', null, pane, createElement(mod.TerminalHost)));
    });
    const pane = (key: string, onActivate?: () => void, recovery?: { piSessionId: string; piSessionCwd: string }) => createElement('section', { key, 'data-pane': key },
      createElement(mod.default, { surfaceId: 'surf-x', visible: true, onActivate, ...recovery }));
    return { setSurfaces, render, pane };
  }

  it('a pane remount moves the terminal instead of rebuilding it', async () => {
    const { setSurfaces, render, pane } = await setup();
    setSurfaces(['surf-x']);
    render(pane('a'));
    expect(mounts).toEqual({ mounted: 1, unmounted: 0 });
    const term = host!.querySelector('.fake-term')!;
    expect(term.closest('[data-pane]')!.getAttribute('data-pane')).toBe('a');

    render(pane('b')); // a new key: what a split-tree reshape does

    expect(mounts).toEqual({ mounted: 1, unmounted: 0 });
    expect(host!.querySelector('.fake-term')).toBe(term);
    expect(term.closest('[data-pane]')!.getAttribute('data-pane')).toBe('b');
    expect(Number(term.getAttribute('data-generation'))).toBeGreaterThan(1);
  });

  it('forwards the pi recovery pair through the portal without remounting on moves or parking', async () => {
    const { setSurfaces, render, pane } = await setup();
    setSurfaces(['surf-x']);
    const recovery = { piSessionId: 'session-B', piSessionCwd: '/worktree/B' };
    render(pane('a', undefined, recovery));
    const term = host!.querySelector('.fake-term')!;
    const generation = Number(term.getAttribute('data-generation'));
    render(pane('b', undefined, recovery));
    expect(host!.querySelector('.fake-term')).toBe(term);
    expect(Number(term.getAttribute('data-generation'))).toBeGreaterThan(generation);
    render(null);
    expect(document.querySelector('.fake-term')).toBe(term);
    expect(term.getAttribute('data-pi-session')).toBe(recovery.piSessionId);
    expect(term.getAttribute('data-pi-cwd')).toBe(recovery.piSessionCwd);
    expect(term.getAttribute('data-visible')).toBe('false');
    expect(mounts).toEqual({ mounted: 1, unmounted: 0 });
  });

  it('keeps a hidden terminal alive while its surface exists (zoom), and disposes it once closed', async () => {
    const { setSurfaces, render, pane } = await setup();
    setSurfaces(['surf-x']);
    render(pane('a'));
    render(null); // zoomed onto another pane: this one has no slot

    expect(mounts).toEqual({ mounted: 1, unmounted: 0 });
    expect(document.querySelector('.fake-term')!.getAttribute('data-visible')).toBe('false');

    await act(async () => { setSurfaces([]); });
    expect(mounts).toEqual({ mounted: 1, unmounted: 1 });
  });

  it('a click on the terminal focuses its pane', async () => {
    const { setSurfaces, render, pane } = await setup();
    setSurfaces(['surf-x']);
    const onActivate = vi.fn();
    render(pane('a', onActivate));
    act(() => { (host!.querySelector('.fake-term') as HTMLElement).click(); });
    expect(onActivate).toHaveBeenCalledOnce();
  });
});
