// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentBrowserViewer, { viewerCoordinates } from '../../src/renderer/components/Browser/AgentBrowserViewer';
import type { AgentViewerBridge, AgentViewerEvent } from '../../src/shared/types';
import { useStore } from '../../src/renderer/store';

let container: HTMLDivElement, root: Root;
let api: AgentViewerBridge;
let onEvent: (event: AgentViewerEvent) => void;
let measure: () => void;
let decode: HTMLImageElement[];
const draw = vi.fn();
let width = 900, height = 640;
const event = async (message: AgentViewerEvent['message'], revision = 1) => {
  const token = vi.mocked(api.attach).mock.calls.at(-1)![1];
  await act(async () => onEvent({ surfaceId: 'surf-renderer', token, revision, message }));
};
const present = async (revision = 1) => {
  await event({ type: 'frame', id: decode.length + 1, data: 'AAAA', width: 900, height: 640 }, revision);
  await act(async () => decode.at(-1)!.onload?.(new Event('load')));
};
const render = async (visible = true) => {
  await act(async () => root.render(createElement(AgentBrowserViewer, { surfaceId: 'surf-renderer', visible, onPageState: vi.fn() })));
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  decode = [];
  width = 900; height = 640;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('Image', class {
    naturalWidth = 900; naturalHeight = 640; onload?: () => void; onerror?: () => void;
    constructor() { decode.push(this as unknown as HTMLImageElement); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as any);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, top: 20, width, height } as DOMRect));
  api = { attach: vi.fn(async () => {}), detach: vi.fn(), ack: vi.fn(), input: vi.fn(), action: vi.fn(async () => {}),
    onEvent: vi.fn((callback) => { onEvent = callback; return vi.fn(); }) };
  window.wmux = { agentViewer: api };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  draw.mockClear();
});
const textarea = () => container.querySelector('textarea')!;
const dispatchText = async (value: string, inputType = 'insertText', isComposing = false) => {
  await act(async () => {
    textarea().value = value;
    textarea().dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType, isComposing }));
  });
};
const dispatchKey = async (type: string, key: string, code: string, keyCode: number, ctrlKey = false) => {
  await act(async () => textarea().dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, keyCode, ctrlKey })));
};

describe('renderer stream/input bridge', () => {
  it('acknowledges draw/drop and ignores a decode completing after detach', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 900, height: 640 });
    expect(api.ack).not.toHaveBeenCalled();
    await act(async () => decode[0].onload?.(new Event('load')));
    expect(draw).toHaveBeenCalledOnce();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 1, true);
    await event({ type: 'frame', id: 2, data: 'BBBB', width: 900, height: 640 });
    await render(false);
    await act(async () => decode[1].onload?.(new Event('load')));
    expect(draw).toHaveBeenCalledOnce();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 2, false);
    expect(api.detach).toHaveBeenCalledOnce();
  });

  it('sends Unicode once and avoids duplicating committed composition', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    await dispatchKey('keydown', 'a', 'KeyA', 65);
    await dispatchText('a✓');
    await dispatchKey('keyup', 'a', 'KeyA', 65);
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await dispatchText('漢', 'insertCompositionText', true);
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '漢字' })));
    await dispatchText('漢字', 'insertFromComposition');
    const inputs = vi.mocked(api.input).mock.calls.map((call) => call[3]);
    expect(inputs).toEqual([
      expect.objectContaining({ eventType: 'rawKeyDown', key: 'a' }),
      expect.objectContaining({ eventType: 'char', text: 'a✓' }),
      expect.objectContaining({ eventType: 'keyUp', key: 'a' }),
      expect.objectContaining({ eventType: 'char', text: '漢字' }),
    ]);
  });

  it('keeps copy/paste finite and lets outer-tab shortcuts bubble without forwarding to Chrome', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    await dispatchKey('keydown', 'c', 'KeyC', 67, true);
    await dispatchKey('keydown', 'v', 'KeyV', 86, true);
    expect(vi.mocked(api.action).mock.calls.map((call) => call[3])).toEqual([{ type: 'copy' }, { type: 'paste' }]);
    const binding = useStore.getState().shortcuts.nextSurface;
    const bubbled = vi.fn();
    document.addEventListener('keydown', bubbled);
    try {
      await act(async () => textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
        key: binding.key, ctrlKey: !!binding.ctrl, shiftKey: !!binding.shift, altKey: !!binding.alt })));
      expect(bubbled).toHaveBeenCalledOnce();
      expect(api.input).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', bubbled); }
  });

  it('blocks key/text/pointer/clipboard until the current revision is actually drawn, including reattach', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    const tryInput = async () => {
      await dispatchKey('keydown', 'ArrowDown', 'ArrowDown', 40);
      await dispatchText('not yet');
      await dispatchKey('keydown', 'v', 'KeyV', 86, true);
      await act(async () => container.querySelector('canvas')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 50 })));
    };
    await tryInput();
    expect(api.input).not.toHaveBeenCalled();
    expect(api.action).not.toHaveBeenCalled();
    await present();
    await dispatchText('tab A');
    expect(api.input).toHaveBeenCalledOnce();
    vi.mocked(api.input).mockClear();
    await event({ type: 'tabs', tabs: [{ tabId: 't2', title: 'B', url: 'https://b.test/', active: true }] }, 2);
    await tryInput();
    expect(api.input).not.toHaveBeenCalled();
    await present(2);
    await dispatchText('tab B');
    expect(api.input).toHaveBeenCalledOnce();
    vi.mocked(api.input).mockClear();
    await render(false);
    await render(true);
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await tryInput();
    expect(api.input).not.toHaveBeenCalled();
    await present();
    await dispatchText('reattached');
    expect(api.input).toHaveBeenCalledOnce();
  });

  it('drains newest-tab sizing after obsolete in-flight resize rejection without a permanent error', async () => {
    vi.useFakeTimers();
    await render();
    let rejectOld!: (error: Error) => void;
    vi.mocked(api.action).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledOnce();
    width = 800; height = 600;
    await event({ type: 'tabs', tabs: [{ tabId: 't2', title: 'B', url: 'https://b.test/', active: true }] }, 2);
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledOnce();
    await act(async () => rejectOld(new Error('Stale page action')));
    expect(api.action).toHaveBeenCalledTimes(2);
    expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 2, { type: 'viewport', width: 800, height: 600 });
    expect(container.textContent).not.toContain('Stale');
  });

  it('coalesces real viewport writes, ignores zero/hidden panes, and reapplies on tab changes', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 1280, height: 720 });
    width = 800; height = 600; measure();
    width = 750; measure();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledWith('surf-renderer', expect.any(String), 1, { type: 'viewport', width: 750, height: 600 });
    expect(api.action).toHaveBeenCalledOnce();
    await event({ type: 'tabs', tabs: [{ tabId: 't1', title: '', url: 'about:blank', active: true }] });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    vi.mocked(api.action).mockClear();
    await event({ type: 'tabs', tabs: [{ tabId: 't1', title: 'new title', url: 'https://fixture.test/', active: true }] });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).not.toHaveBeenCalled();
    await event({ type: 'tabs', tabs: [{ tabId: 't2', title: '', url: 'about:blank', active: true }] }, 2);
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledOnce();
    vi.mocked(api.action).mockClear();
    width = 0; height = 0; measure();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    await render(false);
    width = 600; height = 400; measure();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).not.toHaveBeenCalled();
  });

  it('forwards pointer drag/release and cancels host wheel scrolling', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 1800, height: 1280 });
    await act(async () => decode[0].onload?.(new Event('load')));
    const canvas = container.querySelector('canvas')!;
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const pointer = async (type: string, button: number, buttons: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 460, clientY: 340, button, buttons, detail: 1 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      await act(async () => canvas.dispatchEvent(event));
    };
    await pointer('pointerdown', 0, 1);
    await pointer('pointermove', -1, 1);
    await pointer('pointerup', 0, 0);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 460, clientY: 340, deltaY: 700 });
    await act(async () => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(vi.mocked(api.input).mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ eventType: 'mousePressed', x: 900, y: 640, button: 'left' }),
      expect.objectContaining({ eventType: 'mouseMoved', button: 'left' }),
      expect.objectContaining({ eventType: 'mouseReleased', button: 'left' }),
      expect.objectContaining({ eventType: 'mouseWheel', deltaY: 700, button: 'none' }),
    ]);
  });

  it('maps coordinates using viewport dimensions, not image pixels or scroll metadata', () => {
    expect(viewerCoordinates(460, 340, { left: 10, top: 20, width: 900, height: 640 }, 1800, 1280)).toEqual({ x: 900, y: 640 });
    expect(viewerCoordinates(10, 20, { left: 10, top: 20, width: 0, height: 0 }, 900, 640)).toBeNull();
  });
});
