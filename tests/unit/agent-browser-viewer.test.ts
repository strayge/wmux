import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type WebSocket from 'ws';
import { AgentBrowserViewer, validatedViewerInput } from '../../src/main/agent-browser-viewer';
import type { AgentViewerEvent, SurfaceId } from '../../src/shared/types';
import protocol from '../fixtures/agent-browser/viewer-protocol.json';

const ID = 'surf-viewer' as SurfaceId;
const SESSION = { surfaceId: ID, sessionName: 'wmux-surf-viewer', streamPort: 9301, dashboardUrl: 'unused' };
const ok = { ok: true, spawnFailed: false, data: { result: 'Selected 漢字' }, stdout: '', stderr: '' };

function harness() {
  const sockets: Array<EventEmitter & { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }> = [];
  const run = vi.fn(async (_session: typeof SESSION, _argv: string[]) => ok);
  const events: AgentViewerEvent[] = [];
  const connect = vi.fn((_url: string) => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() });
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const writeClipboard = vi.fn();
  const readClipboard = vi.fn(() => 'Pasted 漢字');
  let session: typeof SESSION | undefined = SESSION;
  const viewer = new AgentBrowserViewer({ connect, run, session: () => session,
    readClipboard, writeClipboard });
  viewer.attach(ID, 10, 'token-a', (event) => events.push(event));
  const receive = (message: unknown, index = sockets.length - 1) => sockets[index].emit('message', JSON.stringify(message));
  receive(protocol.status);
  receive(protocol.tabs);
  const present = (token = 'token-a') => {
    receive(protocol.frame);
    const frame = events.at(-1)!.message;
    if (frame.type !== 'frame') throw new Error('Expected delivered frame');
    viewer.ack(ID, 10, token, frame.id, true);
    sockets.at(-1)!.send.mockClear();
  };
  return { viewer, run, connect, readClipboard, writeClipboard, events, sockets, receive, present,
    replaceSession: () => { session = { ...SESSION }; } };
}

const key = { type: 'input_keyboard', eventType: 'char', text: '✓漢字', windowsVirtualKeyCode: 0, modifiers: 0 };

describe('surface stream subscriptions', () => {
  it('resolves only the registered loopback endpoint and relays finite page state', () => {
    const h = harness();
    expect(h.connect).toHaveBeenCalledWith('ws://127.0.0.1:9301/?pacing=ack&maxFps=30');
    h.receive(protocol.url);
    h.receive({ type: 'result', success: false });
    h.receive({ type: 'console', text: 'not page state' });
    expect(h.events.map((event) => event.message.type)).toEqual(['status', 'tabs', 'url']);
    expect(h.events[1].message).toEqual({ type: 'tabs', tabs: [{ tabId: 't1', title: 'Fixture', url: 'https://fixture.test/', active: true }] });
  });

  it.each(['detach', 'replacement', 'teardown'])('invalidates a pending authorized attach on %s', async (mode) => {
    const h = harness();
    let authorize!: () => void;
    const pending = h.viewer.attachAuthorized(ID, 10, 'pending',
      () => new Promise<void>((resolve) => { authorize = resolve; }), () => {});
    if (mode === 'detach') h.viewer.detach(ID, 10, 'pending');
    if (mode === 'teardown') h.viewer.forget(ID);
    if (mode === 'replacement') await h.viewer.attachAuthorized(ID, 10, 'newer', async () => {}, () => {});
    const connects = h.connect.mock.calls.length;
    authorize();
    await pending;
    expect(h.connect).toHaveBeenCalledTimes(connects);
  });

  it('does not let wrong-window attach/detach invalidate the owner pending or live subscription', async () => {
    const h = harness();
    let authorize!: () => void;
    const pending = h.viewer.attachAuthorized(ID, 10, 'pending',
      () => new Promise<void>((resolve) => { authorize = resolve; }), () => {});
    await expect(h.viewer.attachAuthorized(ID, 99, 'pending', async () => { throw new Error('Unauthorized'); }, () => {})).rejects.toThrow('Unauthorized');
    h.viewer.detach(ID, 99, 'pending');
    expect(h.sockets[0].terminate).not.toHaveBeenCalled();
    authorize();
    await pending;
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
    expect(h.sockets[1].terminate).not.toHaveBeenCalled();
  });

  it('requires a drawn current-tab frame after attach or tab change, not just connection or a drop ack', async () => {
    const h = harness();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    h.receive(protocol.frame);
    h.viewer.ack(ID, 10, 'token-a', 1, false);
    h.sockets[0].send.mockClear();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.receive(protocol.frame);
    h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    h.viewer.ack(ID, 10, 'token-a', 2, true);
    h.sockets[0].send.mockClear();
    h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.present();
    await h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls[0][0])).toEqual(key);
  });

  it('bounds IPC to one outstanding frame and the newest pending frame', () => {
    const h = harness();
    for (let seq = 1; seq <= 100; seq++) h.receive({ ...protocol.frame, seq });
    expect(h.events.filter((event) => event.message.type === 'frame')).toHaveLength(1);
    h.viewer.ack(ID, 99, 'token-a', 1, false);
    h.viewer.ack(ID, 10, 'stale', 1, false);
    h.viewer.ack(ID, 10, 'token-a', 2, false);
    expect(h.events.filter((event) => event.message.type === 'frame')).toHaveLength(1);
    h.viewer.ack(ID, 10, 'token-a', 1, false);
    expect(h.events.filter((event) => event.message.type === 'frame').map((event) => event.message)).toEqual([
      { type: 'frame', id: 1, data: protocol.frame.data, width: 900, height: 640 },
      { type: 'frame', id: 100, data: protocol.frame.data, width: 900, height: 640 },
    ]);
    expect(h.sockets[0].send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ack', seq: 100 }));
  });

  it('isolates wrong owners, replaced tokens, and late socket callbacks', async () => {
    const h = harness();
    const late = h.sockets[0].listeners('message')[0] as (data: string) => void;
    h.viewer.input(ID, 99, 'token-a', 1, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.viewer.attach(ID, 10, 'token-b', (event) => h.events.push(event));
    h.receive(protocol.status);
    h.viewer.input(ID, 10, 'token-a', 0, key);
    h.viewer.detach(ID, 10, 'token-a');
    late(JSON.stringify(protocol.frame));
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
    expect(h.events.some((event) => event.message.type === 'frame')).toBe(false);
    h.present('token-b');
    await h.viewer.input(ID, 10, 'token-b', 0, key);
    expect(JSON.parse(h.sockets[1].send.mock.calls[0][0])).toEqual(key);
    h.viewer.detach(ID, 10, 'token-b');
    expect(h.sockets[1].terminate).toHaveBeenCalledOnce();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('drops stale tab input and queued native work after agent-driven tab selection', async () => {
    const h = harness();
    h.present();
    const action = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(action).rejects.toThrow('Stale');
    expect(h.run).not.toHaveBeenCalled();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.present();
    await h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls[0][0])).toEqual(key);
  });

  it('pauses on observed loss, with no remount/toggle bypass or session closure', async () => {
    const h = harness();
    h.receive({ ...protocol.status, connected: false });
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(() => h.viewer.attach(ID, 10, 'token-b', () => {})).toThrow('unavailable');
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
    h.viewer.forget(ID);
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('does not dispatch against a replacement registry session', async () => {
    const h = harness();
    h.replaceSession();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy' })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('rejects malformed known protocol with a readable error', () => {
    const h = harness();
    h.receive({ type: 'frame', data: 'not an image' });
    expect(h.events.at(-1)?.message.type).toBe('error');
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
  });
});

describe('finite native actions and input', () => {
  it('uses native viewport and only main-owned paste/selection evaluations', async () => {
    const h = harness();
    h.present();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste', argv: ['close'] });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy', js: 'malicious' });
    expect(h.run.mock.calls).toEqual([
      [SESSION, ['set', 'viewport', '900', '640']],
      [SESSION, ['eval', `document.execCommand('insertText', false, "Pasted 漢字")`]],
      [SESSION, ['eval', expect.stringContaining('selectionStart')]],
    ]);
    expect(h.run.mock.calls[2][1][1]).not.toContain('malicious');
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    expect(h.writeClipboard).toHaveBeenCalledWith('Selected 漢字');
    for (const action of [{ type: 'exec', argv: ['close'] }, { type: 'viewport', width: NaN, height: 4 }]) {
      await expect(h.viewer.action(ID, 10, 'token-a', 1, action)).rejects.toThrow();
    }
    expect(h.run).toHaveBeenCalledTimes(3);
  });

  it.each(['--version', '--json', '', 'Unicode café 日本語 🙂', '--leading-dash\nquotes \' \" and 漢字', '\");throw new Error("injected");//'])('encodes clipboard text %j only inside a main-owned literal', async (value) => {
    const h = harness();
    h.present();
    h.readClipboard.mockReturnValue(value);
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste', js: 'throw new Error("renderer script")' });
    expect(h.viewer.canAct(ID)).toBe(true);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    if (value) {
      expect(h.run).toHaveBeenCalledOnce();
      const argv = h.run.mock.calls[0][1];
      expect(argv[0]).toBe('eval');
      expect(argv).not.toContain(value);
      const insert = vi.fn(() => true);
      new Function('document', `return ${argv[1]}`)({ execCommand: insert });
      expect(insert).toHaveBeenCalledExactlyOnceWith('insertText', false, value);
    } else expect(h.run).not.toHaveBeenCalled();
  });

  it('rejects oversized encoded paste before spawning without pausing the healthy page', async () => {
    const h = harness();
    h.present();
    for (const value of ['x'.repeat(12000), '"'.repeat(6000), '\u0000'.repeat(2500)]) {
      h.readClipboard.mockReturnValue(value);
      await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('encoded limit');
      expect(h.run).not.toHaveBeenCalled();
      expect(h.viewer.canAct(ID)).toBe(true);
    }
    h.readClipboard.mockReturnValue('still healthy');
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('preserves resize -> paste -> subsequent typing/pointer receive order across native work', async () => {
    const h = harness();
    h.present();
    const order: string[] = [];
    let finishResize!: (result: typeof ok) => void;
    let finishPaste!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(async () => {
      order.push('resize');
      return new Promise((resolve) => { finishResize = resolve; });
    }).mockImplementationOnce(async () => {
      order.push('paste');
      return new Promise((resolve) => { finishPaste = resolve; });
    });
    h.sockets[0].send.mockImplementation((payload: string) => {
      const input = JSON.parse(payload);
      order.push(input.type === 'input_keyboard' ? 'typing' : 'pointer');
    });
    const resize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    await vi.waitFor(() => expect(order).toEqual(['resize']));
    const paste = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    const typing = h.viewer.input(ID, 10, 'token-a', 1, { ...key, text: 'typed after paste' });
    const pointer = h.viewer.input(ID, 10, 'token-a', 1, { type: 'input_mouse', eventType: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 });
    expect(order).toEqual(['resize']);
    finishResize(ok);
    await resize;
    await vi.waitFor(() => expect(order).toEqual(['resize', 'paste']));
    finishPaste(ok);
    await Promise.all([paste, typing, pointer]);
    expect(order).toEqual(['resize', 'paste', 'typing', 'pointer']);
  });

  it.each(['tab', 'subscription'])('drops queued old input/paste and does not pause a replacement %s on a late native failure', async (replacement) => {
    const h = harness();
    h.present();
    let failOld!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { failOld = resolve; }));
    const oldResize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 }).catch((err) => err);
    await vi.waitFor(() => expect(failOld).toBeTypeOf('function'));
    const oldPaste = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' }).catch((err) => err);
    const oldInput = h.viewer.input(ID, 10, 'token-a', 1, key);
    let token = 'token-a', revision = 2;
    if (replacement === 'subscription') {
      token = 'token-b'; revision = 0;
      h.viewer.attach(ID, 10, token, (event) => h.events.push(event));
      h.receive(protocol.status);
    } else h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    h.present(token);
    const newInput = h.viewer.input(ID, 10, token, revision, { ...key, text: 'new page input' });
    failOld({ ...ok, ok: false, stderr: 'old native failure' });
    await Promise.all([oldResize, oldPaste, oldInput, newInput]);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.viewer.canAct(ID)).toBe(true);
    expect(h.events.filter((event) => event.message.type === 'error')).toEqual([]);
    expect(h.sockets.at(-1)!.send.mock.calls.map((call) => JSON.parse(call[0]))).toEqual([
      expect.objectContaining({ type: 'input_keyboard', text: 'new page input' }),
    ]);
  });

  it('bounds input queued behind native work and pauses instead of accumulating indefinitely', async () => {
    const h = harness();
    h.present();
    let finish!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const resize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 }).catch(() => {});
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const input = Array.from({ length: 500 }, () => h.viewer.input(ID, 10, 'token-a', 1, key));
    expect(h.events.filter((event) => event.message.type === 'error')).toHaveLength(1);
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'error', message: expect.stringContaining('queue is full') });
    finish(ok);
    await Promise.all([resize, ...input]);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    expect(h.viewer.canAct(ID)).toBe(false);
  });

  it('copies only the actual selection, blocks password values, and preserves clipboard on empty selection', async () => {
    const h = harness();
    h.present();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy' });
    const script = h.run.mock.calls[0][1][1];
    const evaluate = new Function('document', 'window', `return ${script}`);
    for (const tagName of ['INPUT', 'TEXTAREA']) {
      expect(evaluate({ activeElement: { tagName, type: 'text', value: 'full selected value', selectionStart: 5, selectionEnd: 13 } }, {})).toBe('selected');
      expect(evaluate({ activeElement: { tagName, type: 'text', value: 'not selected', selectionStart: 2, selectionEnd: 2 } }, {})).toBe('');
    }
    expect(evaluate({ activeElement: { tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 } }, {})).toBe('');
    expect(evaluate({ activeElement: { tagName: 'DIV' } }, { getSelection: () => 'DOM selected' })).toBe('DOM selected');
    h.writeClipboard.mockClear();
    h.run.mockResolvedValueOnce({ ...ok, data: { result: '' } });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy' });
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });

  it('stops queued mutations when a native command fails', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce({ ...ok, ok: false, stderr: 'Browser unavailable' });
    h.present();
    const first = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    const second = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.viewer.canAct(ID)).toBe(false);
  });

  it('validates finite mouse/key messages and strips arbitrary CDP/argv fields', () => {
    expect(validatedViewerInput({ ...key, method: 'Browser.close', argv: ['close'] })).toEqual(key);
    expect(validatedViewerInput({ ...key, modifiers: 32 })).toBeNull();
    expect(validatedViewerInput({ ...key, eventType: 'execute' })).toBeNull();
    const mouse = { type: 'input_mouse', eventType: 'mouseWheel', x: 12, y: 30, button: 'none', clickCount: 0, modifiers: 0, deltaY: 100 };
    expect(validatedViewerInput(mouse)).toMatchObject(mouse);
    expect(validatedViewerInput({ ...mouse, x: Infinity })).toBeNull();
    expect(validatedViewerInput({ ...mouse, deltaY: NaN })).toBeNull();
  });
});
