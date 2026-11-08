// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPane, { disableTarget, engineTransition, resolveInputUrl, webviewHiding } from '../../src/renderer/components/Browser/BrowserPane';

vi.mock('../../src/renderer/components/Browser/AgentBrowserViewer', () => ({
  default: (props: { visible: boolean; onPageState: (url: string, title: string) => void }) =>
    createElement('button', { 'data-viewer': String(props.visible), onClick: () => props.onPageState('https://agent.test/next', 'Agent title') }, 'fixture page'),
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
    await click('Dashboard');
    expect(container.querySelector('[data-viewer]')).toBeNull();
    await click('Page');
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

  it('reports startup failure instead of presenting a ready page', async () => {
    api.enable.mockRejectedValue(new Error('Chrome startup failed'));
    await render();
    expect(container.querySelector('[data-viewer]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Chrome startup failed');
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
