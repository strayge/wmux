import { useEffect, useRef, useState } from 'react';
import type { AgentViewerAction, AgentViewerBridge, AgentViewerEvent, AgentViewerInput } from '../../../shared/types';
import { useStore } from '../../store';
import { guestShortcutAction } from '../../hooks/useKeyboardShortcuts';
import { matchIndexShortcut } from '../../utils/index-shortcuts';

interface Props {
  surfaceId: string;
  visible: boolean;
  focused?: boolean;
  onActivate?: () => void;
  onPageState: (url: string, title?: string) => void;
}

export function viewerCoordinates(clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: Math.max(0, Math.min(width - 1, (clientX - rect.left) * width / rect.width)),
    y: Math.max(0, Math.min(height - 1, (clientY - rect.top) * height / rect.height)) };
}

export function viewerModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return Number(e.altKey) + Number(e.ctrlKey) * 2 + Number(e.metaKey) * 4 + Number(e.shiftKey) * 8;
}

/** Textarea supplies a real IME target; committed composition is sent exactly once. */
export default function AgentBrowserViewer({ surfaceId, visible, focused, onActivate, onPageState }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const state = useRef({ token: '', revision: 0, ready: false, drawnRevision: -1, width: 1, height: 1 });
  const callbacks = useRef({ onPageState, onActivate });
  callbacks.current = { onPageState, onActivate };
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const composing = useRef(false);
  const committedComposition = useRef<string | null>(null);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    el?.addEventListener('wheel', wheel, { passive: false });
    return () => el?.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (focused === false) keyboard.current?.blur();
  }, [focused]);

  useEffect(() => {
    if (!visible) return;
    const api = window.wmux.agentViewer as AgentViewerBridge;
    const token = crypto.randomUUID();
    state.current = { token, revision: 0, ready: false, drawnRevision: -1, width: 1, height: 1 };
    setError('');
    setConnected(false);
    setHasFrame(false);
    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let resizing = false;
    let pendingSize: { width: number; height: number; revision: number } | undefined;
    let lastSize = '';
    let activeTab: string | undefined;
    const resize = async () => {
      if (resizing || !state.current.ready || disposed) return;
      resizing = true;
      try {
        while (pendingSize && !disposed && state.current.ready) {
          const { width, height, revision } = pendingSize;
          pendingSize = undefined;
          if (revision !== state.current.revision) continue;
          const key = `${revision}:${width}x${height}`;
          if (key === lastSize) continue;
          try {
            await api.action(surfaceId, token, revision, { type: 'viewport', width, height });
            if (!disposed && revision === state.current.revision) lastSize = key;
          } catch (err) {
            if (!disposed && revision === state.current.revision) {
              setError(String(err));
              pendingSize = undefined;
              break;
            }
            // Obsolete work is dropped, but the newest current-tab measurement still drains.
          }
        }
      } finally { resizing = false; }
    };
    const measure = () => {
      const el = area.current;
      if (!el || disposed || document.hidden) return;
      const rect = el.getBoundingClientRect();
      const width = Math.floor(rect.width), height = Math.floor(rect.height);
      if (width < 1 || height < 1) return;
      pendingSize = { width, height, revision: state.current.revision };
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { void resize(); }, 120);
    };
    const off = api.onEvent((event: AgentViewerEvent) => {
      if (disposed || event.surfaceId !== surfaceId || event.token !== token) return;
      const { message } = event;
      if (state.current.revision !== event.revision) {
        state.current.drawnRevision = -1;
        setHasFrame(false);
      }
      state.current.revision = event.revision;
      switch (message.type) {
        case 'error':
          state.current.ready = false;
          state.current.drawnRevision = -1;
          setHasFrame(false);
          pendingSize = undefined;
          setError(message.message);
          setConnected(false);
          break;
        case 'status':
          state.current.ready = message.connected;
          setConnected(message.connected);
          measure();
          break;
        case 'url': callbacks.current.onPageState(message.url); break;
        case 'tabs': {
          const active = message.tabs.find((tab) => tab.active);
          if (active) callbacks.current.onPageState(active.url, active.title);
          if (active?.tabId !== activeTab) {
            activeTab = active?.tabId;
            lastSize = '';
            measure();
          }
          break;
        }
        case 'frame': {
          const revision = event.revision;
          const image = new Image();
          const finish = (drawn: boolean) => api.ack(surfaceId, token, message.id, drawn);
          image.onload = () => {
            let drawn = false;
            try {
              const el = canvas.current;
              if (!disposed && state.current.ready && state.current.revision === revision && el) {
                el.width = image.naturalWidth;
                el.height = image.naturalHeight;
                const context = el.getContext('2d');
                if (context) {
                  context.drawImage(image, 0, 0);
                  state.current.width = message.width;
                  state.current.height = message.height;
                  state.current.drawnRevision = revision;
                  drawn = true;
                  setHasFrame(true);
                }
              }
            } finally { finish(drawn); }
          };
          image.onerror = () => {
            if (!disposed && state.current.revision === revision) {
              state.current.ready = false;
              setError('Could not decode the page stream. Open Dashboard to continue.');
            }
            finish(false);
          };
          image.src = `data:image/jpeg;base64,${message.data}`;
          break;
        }
      }
    });
    void api.attach(surfaceId, token).catch((err) => { if (!disposed) setError(String(err)); });
    const observer = new ResizeObserver(measure);
    if (area.current) observer.observe(area.current);
    document.addEventListener('visibilitychange', measure);
    return () => {
      disposed = true;
      state.current.ready = false;
      pendingSize = undefined;
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', measure);
      off();
      api.detach(surfaceId, token);
    };
  }, [surfaceId, visible]);

  const input = (value: AgentViewerInput) => {
    const s = state.current;
    if (visible && s.ready && s.drawnRevision === s.revision) window.wmux.agentViewer.input(surfaceId, s.token, s.revision, value);
  };
  const action = (value: AgentViewerAction) => {
    const s = state.current;
    if (visible && s.ready && s.drawnRevision === s.revision) {
      const { token, revision } = s;
      void (window.wmux.agentViewer as AgentViewerBridge).action(surfaceId, token, revision, value).catch((err) => {
        if (state.current.token === token && state.current.revision === revision) setError(String(err));
      });
    }
  };
  const mouse = (e: React.PointerEvent<HTMLCanvasElement> | WheelEvent, eventType: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel') => {
    const el = canvas.current;
    if (!el) return;
    const s = state.current;
    const pos = viewerCoordinates(e.clientX, e.clientY, el.getBoundingClientRect(), s.width, s.height);
    if (!pos) return;
    const button = eventType === 'mouseWheel' ? 'none' : eventType === 'mouseMoved'
      ? (e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : e.buttons & 4 ? 'middle' : 'none')
      : (['left', 'middle', 'right'][e.button] ?? 'none') as 'left';
    input({ type: 'input_mouse', eventType, ...pos, button,
      clickCount: eventType === 'mousePressed' || eventType === 'mouseReleased' ? Math.max(1, Math.min(3, e.detail)) : 0,
      modifiers: viewerModifiers(e), ...('deltaX' in e ? { deltaX: e.deltaX, deltaY: e.deltaY } : {}) });
  };
  wheelHandler.current = (event) => { event.preventDefault(); mouse(event, 'mouseWheel'); };
  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>, eventType: 'keyDown' | 'keyUp') => {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const { shortcuts, keyboardPrefs } = useStore.getState();
    if (guestShortcutAction({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: false }, shortcuts)
      || matchIndexShortcut(e.nativeEvent, keyboardPrefs.workspaceIndexModifiers) !== null
      || matchIndexShortcut(e.nativeEvent, keyboardPrefs.surfaceIndexModifiers) !== null) return;
    e.stopPropagation();
    const lower = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['c', 'v'].includes(lower)) {
      e.preventDefault();
      if (eventType === 'keyDown' && !e.repeat) action({ type: lower === 'c' ? 'copy' : 'paste' });
      return;
    }
    if (e.key === 'Dead' || e.key === 'Process') return;
    const printable = Array.from(e.key).length === 1
      && ((!e.ctrlKey && !e.metaKey && !e.altKey) || e.getModifierState('AltGraph'));
    if (printable) {
      if (eventType === 'keyDown') committedComposition.current = null;
      input({ type: 'input_keyboard', eventType: eventType === 'keyDown' ? 'rawKeyDown' : 'keyUp',
        key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: viewerModifiers(e) });
      return; // The textarea supplies text separately, including dead keys and Unicode.
    }
    e.preventDefault();
    input({ type: 'input_keyboard', eventType, key: e.key, code: e.code,
      windowsVirtualKeyCode: e.keyCode, modifiers: viewerModifiers(e),
      ...(eventType === 'keyDown' && e.key === 'Enter' ? { text: '\r' } : {}) });
  };

  return <div ref={area} className="agent-browser-viewer" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
    <canvas ref={canvas} style={{ width: '100%', height: '100%', objectFit: 'fill', touchAction: 'none' }}
      onPointerDown={(e) => { callbacks.current.onActivate?.(); keyboard.current?.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); mouse(e, 'mousePressed'); e.preventDefault(); }}
      onPointerMove={(e) => mouse(e, 'mouseMoved')}
      onPointerUp={(e) => { mouse(e, 'mouseReleased'); e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={(e) => mouse(e, 'mouseReleased')}
      onContextMenu={(e) => e.preventDefault()} />
    <textarea ref={keyboard} aria-label="Agent browser page input" autoCapitalize="off" autoCorrect="off" spellCheck={false}
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      onKeyDown={(e) => key(e, 'keyDown')} onKeyUp={(e) => key(e, 'keyUp')}
      onCompositionStart={() => { composing.current = true; committedComposition.current = null; }}
      onCompositionEnd={(e) => {
        composing.current = false;
        committedComposition.current = e.data;
        if (e.data) input({ type: 'input_keyboard', eventType: 'char', text: e.data, windowsVirtualKeyCode: 0, modifiers: 0 });
        e.currentTarget.value = '';
      }}
      onInput={(e) => {
        if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
        const value = e.currentTarget.value;
        if (committedComposition.current !== null && (e.nativeEvent as InputEvent).data === committedComposition.current) {
          committedComposition.current = null;
          e.currentTarget.value = '';
          return;
        }
        committedComposition.current = null;
        if (value) input({ type: 'input_keyboard', eventType: 'char', text: value, windowsVirtualKeyCode: 0, modifiers: 0 });
        e.currentTarget.value = '';
      }}
      onPaste={(e) => { e.preventDefault(); action({ type: 'paste' }); }}
      onCopy={(e) => { e.preventDefault(); action({ type: 'copy' }); }} />
    {(!connected || !hasFrame || error) && <div className="browser-pane__blank" role="status" style={{ pointerEvents: 'none' }}>
      <p>{error || (connected ? 'Waiting for page frame…' : 'Connecting to page…')}</p>
      {error && <p>Open Dashboard to continue.</p>}
    </div>}
  </div>;
}
