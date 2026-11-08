// @vitest-environment jsdom
import { act, createElement, useEffect, useImperativeHandle, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPane, { disableTarget, engineTransition, resolveInputUrl, webviewHiding } from '../../src/renderer/components/Browser/BrowserPane';

const viewerAction = vi.hoisted(() => vi.fn(async (_action: unknown) => {}));
const tabs = [
  { tabId: 't1', title: 'First', url: 'https://initial.test/', active: true },
  { tabId: 't9', title: 'Other', url: 'https://other.test/', active: false },
];
vi.mock('../../src/renderer/components/Browser/AgentBrowserViewer', () => ({
  default: function Viewer(props: { visible: boolean; ref: Ref<{ action: typeof viewerAction }>;
    onPageState: (url: string, title: string) => void; onConnection: (connected: boolean) => void; onTabs: (tabs: unknown[]) => void; onStartNew: () => void }) {
    useImperativeHandle(props.ref, () => ({ action: viewerAction }));
    useEffect(() => { props.onConnection(true); }, []);
    return createElement('div', {}, createElement('button', { 'data-viewer': String(props.visible), onClick: () => {
      props.onPageState('https://agent.test/next', 'Agent title');
      props.onTabs(tabs);
    } }, 'fixture page'), createElement('button', { onClick: props.onStartNew }, 'Start new session'));
  },
}));

let root: Root;
let container: HTMLDivElement;
let api: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; currentUrl: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
let loadURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  viewerAction.mockClear();
  loadURL = vi.fn(async () => {});
  Object.defineProperty(HTMLElement.prototype, 'loadURL', { value: loadURL, configurable: true });
  api = { enable: vi.fn(async () => ({ installed: true, dashboardUrl: 'https://dashboard.test/' })),
    disable: vi.fn(async () => ({})), status: vi.fn(async () => ({ installed: true, dashboardAvailable: true })),
    currentUrl: vi.fn(), open: vi.fn(async () => ({ ok: true })) };
  window.wmux = { agentBrowser: api };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (HTMLElement.prototype as any).loadURL;
  vi.useRealTimers();
});
const render = async (extra = {}) => {
  await act(async () => { root.render(createElement(BrowserPane, { surfaceId: 'surf-pane', engine: 'agent', initialUrl: 'https://initial.test/', ...extra })); });
};
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};

describe('Page presentation', () => {
  it('defaults to the page without waiting for dashboard status', async () => {
    api.status.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(api.enable).toHaveBeenCalledTimes(1);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('keeps Page usable when the optional dashboard is unavailable', async () => {
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('round-trips Page/Dashboard inside the same outer pane without engine lifecycle calls', async () => {
    await render();
    const outer = container.querySelector('.browser-pane');
    const webview = container.querySelector('webview');
    await click('…');
    await click('Show dashboard');
    expect(container.querySelector('[data-viewer="false"]')).toBeTruthy();
    await click('…');
    await click('Return to page');
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(container.querySelector('.browser-pane')).toBe(outer);
    expect(container.querySelector('webview')).toBe(webview);
    expect(api.enable).toHaveBeenCalledTimes(1);
    expect(api.disable).not.toHaveBeenCalled();
    expect(api.open).not.toHaveBeenCalled();
  });

  it('passes hidden-workspace state down without disabling the session', async () => {
    await render();
    await render({ visible: false });
    expect(container.querySelector('[data-viewer="false"]')).toBeTruthy();
    expect(api.disable).not.toHaveBeenCalled();
    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it('takes authoritative streamed URL/title without launch-capable URL polling', async () => {
    vi.useFakeTimers();
    const onUrlChange = vi.fn(), onTitleChange = vi.fn();
    await render({ onUrlChange, onTitleChange });
    await click('fixture page');
    expect(onUrlChange).toHaveBeenCalledWith('https://agent.test/next');
    expect(onTitleChange).toHaveBeenCalledWith('Agent title');
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(api.currentUrl).not.toHaveBeenCalled();
    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it('routes menu, stable tab controls and refresh to Chrome even while showing Dashboard', async () => {
    await render({ onEngineChange: vi.fn() });
    expect(container.querySelector('.browser-pane__chrome-tabs')).toBeNull();
    await click('fixture page');
    expect(container.querySelectorAll('.browser-pane__chrome-tab')).toHaveLength(2);
    await click('Other');
    const close = container.querySelectorAll<HTMLButtonElement>('[aria-label="Close tab"]')[1];
    await act(async () => close.click());
    expect(viewerAction.mock.calls.map((call) => call[0])).toEqual([{ type: 'tab-select', tabId: 't9' }, { type: 'tab-close', tabId: 't9' }]);
    await click('…');
    await click('Show dashboard');
    await click('←');
    await click('→');
    await click('↻');
    await act(async () => document.dispatchEvent(new CustomEvent('wmux:refresh-surface', { detail: { surfaceId: 'surf-pane' } })));
    expect(viewerAction.mock.calls.slice(-4).map((call) => call[0])).toEqual([{ type: 'back' }, { type: 'forward' }, { type: 'reload' }, { type: 'reload' }]);
    await click('…');
    await click('New tab');
    expect(viewerAction).toHaveBeenLastCalledWith({ type: 'tab-new' });
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(document.activeElement).toBe(container.querySelector('input'));
    expect(container.querySelector('input')?.value).toBe('');
    expect(api.open).not.toHaveBeenCalled();
    expect(api.enable).toHaveBeenCalledOnce();
    expect(api.disable).not.toHaveBeenCalled();
  });

  it('preserves an address edit across authoritative agent URL/title updates until blur', async () => {
    await render();
    const input = container.querySelector('input')!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'draft.example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('fixture page');
    expect(input.value).toBe('draft.example');
    await act(async () => input.blur());
    expect(input.value).toBe('https://agent.test/next');
  });

  it('leaves Web refresh and address navigation on the guest, with no Agent menu', async () => {
    const reload = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'reload', { value: reload, configurable: true });
    try {
      await render({ engine: 'web' });
      expect(container.querySelector('[aria-label="Browser menu"]')).toBeNull();
      await act(async () => document.dispatchEvent(new CustomEvent('wmux:refresh-surface', { detail: { surfaceId: 'surf-pane' } })));
      expect(reload).toHaveBeenCalledOnce();
      await act(async () => window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { surfaceId: 'surf-pane', url: 'example.com' } })));
      expect(loadURL).toHaveBeenLastCalledWith('https://example.com');
      expect(viewerAction).not.toHaveBeenCalled();
    } finally { delete (HTMLElement.prototype as any).reload; }
  });

  it('starts a deliberately fresh blank session via disable then enable, never the old streamed URL', async () => {
    await render();
    await click('fixture page');
    api.disable.mockClear();
    api.enable.mockClear();
    await click('Start new session');
    expect(api.disable).toHaveBeenCalledExactlyOnceWith('surf-pane', true);
    expect(api.enable).toHaveBeenCalledExactlyOnceWith('surf-pane', 'about:blank');
    expect(api.disable.mock.invocationCallOrder[0]).toBeLessThan(api.enable.mock.invocationCallOrder[0]);
    expect(api.open).not.toHaveBeenCalled();
  });

  it('reports failed close and explicitly retries it before any new startup', async () => {
    await render();
    api.disable.mockRejectedValueOnce(new Error('Close timed out'));
    await click('Start new session');
    expect(container.querySelector('[data-viewer]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Close timed out');
    expect(api.enable).toHaveBeenCalledOnce();
    await click('Try again');
    expect(api.disable).toHaveBeenCalledTimes(2);
    expect(api.enable).toHaveBeenLastCalledWith('surf-pane', 'about:blank');
  });

  it('retries a failed fresh close from unavailable Dashboard before opening only a blank session', async () => {
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    api.disable.mockRejectedValueOnce(new Error('Close failed'));
    await click('Start new session');
    await click('…');
    await click('Show dashboard');
    expect(container.textContent).toContain('The activity viewer did not start');
    let finishClose!: () => void;
    api.disable.mockImplementationOnce(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    await click('Try again');
    expect(api.disable).toHaveBeenLastCalledWith('surf-pane', true);
    expect(api.enable).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Starting browser session');
    await act(async () => finishClose());
    expect(api.enable).toHaveBeenCalledTimes(2);
    expect(api.enable).toHaveBeenLastCalledWith('surf-pane', 'about:blank');
    expect(api.open).not.toHaveBeenCalled();
  });

  it('clears fresh-start retry intent after success so a later Dashboard retry does not close the healthy session', async () => {
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    await click('Start new session');
    expect(api.disable).toHaveBeenCalledOnce();
    expect(api.enable).toHaveBeenCalledTimes(2);
    await click('…');
    await click('Show dashboard');
    await click('Try again');
    expect(api.disable).toHaveBeenCalledOnce();
    expect(api.enable).toHaveBeenCalledTimes(3);
    expect(api.open).not.toHaveBeenCalled();
  });

  it('does not renew startup after a pending fresh close completes after switching to Web', async () => {
    await render();
    let finish!: () => void;
    api.disable.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await click('Start new session');
    await render({ engine: 'web' });
    await act(async () => finish());
    expect(api.enable).toHaveBeenCalledOnce();
  });

  it('offers setup for a missing binary and returns from unavailable Dashboard without a new session', async () => {
    api.enable.mockResolvedValueOnce({ installed: false });
    await render();
    expect(container.textContent).toContain('Install');
    expect(container.querySelector('[data-viewer]')).toBeNull();
    await render({ engine: 'web' });
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    await click('…');
    await click('Show dashboard');
    expect(container.textContent).toContain('The activity viewer did not start');
    await click('…');
    await click('Return to page');
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(api.enable).toHaveBeenCalledTimes(2);
  });

  it('reports startup failure instead of presenting a ready page', async () => {
    api.enable.mockRejectedValue(new Error('Chrome startup failed'));
    await render();
    expect(container.querySelector('[data-viewer]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Chrome startup failed');
    api.enable.mockResolvedValueOnce({ installed: true });
    await click('Try again');
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
  });
});

describe('unchanged Web decisions', () => {
  it('only changes engine lifecycle on an actual transition', () => {
    expect(engineTransition('agent', 'agent', 'https://a.test/')).toEqual({ action: 'none' });
    expect(engineTransition('web', 'agent', 'https://a.test/')).toEqual({ action: 'enable', url: 'https://a.test/' });
    expect(engineTransition('agent', 'web', 'https://a.test/')).toEqual({ action: 'disable' });
  });
  it('hands back the agent URL without redundantly navigating Web', () => {
    expect(disableTarget({ url: 'https://agent.test/' }, 'fallback', 'dashboard')).toBe('https://agent.test/');
    expect(disableTarget({}, 'https://same.test/', 'https://same.test/')).toBeNull();
  });
  it('keeps the existing address rules', () => {
    expect(resolveInputUrl('example.com')).toBe('https://example.com');
    expect(resolveInputUrl('two words')).toContain('google.com/search?q=');
  });
  it('hides overlays and blank pages with visibility, not unmounting', () => {
    expect(webviewHiding({ overlay: true, isBlank: false, isAgent: true, visible: true, keepRendering: false }))
      .toEqual({ style: { visibility: 'hidden' } });
  });
});
