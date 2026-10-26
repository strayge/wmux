import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire, Module } from 'node:module';

interface TestWindow extends EventEmitter {
  options: Record<string, unknown>;
  destroyed: boolean;
  webContents: EventEmitter & { id: number; openDevTools: ReturnType<typeof vi.fn> };
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setBackgroundMaterial: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  windows: [] as TestWindow[],
  app: { isPackaged: true },
  settings: {} as Record<string, unknown>,
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: mocks.app,
    BrowserWindow: class extends EventEmitter {
      options: Record<string, unknown>;
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        id: mocks.windows.length + 1,
        openDevTools: vi.fn(),
      });
      constructor(options: Record<string, unknown>) {
        super();
        this.options = options;
        mocks.windows.push(this);
      }
      isDestroyed() { return this.destroyed; }
      loadFile = vi.fn();
      loadURL = vi.fn();
      maximize = vi.fn();
      setBackgroundColor = vi.fn();
      setBackgroundMaterial = vi.fn();
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    dialog: { showMessageBox: vi.fn() },
  };
});
vi.mock('os', () => ({ default: { release: () => '10.0.22631' } }));
vi.mock('../../src/main/settings-store', () => ({ loadSettings: () => mocks.settings }));
vi.mock('../../src/main/crash-diagnostics', () => ({ logDiagnostic: vi.fn() }));

import { WindowManager, supportsBackdropMaterial } from '../../src/main/window-manager';

// Vitest mocks the ESM import above; WindowManager also deliberately uses
// CommonJS require('electron') for app metadata. Stub that without refactoring
// production code, then restore Node's cache after this file's tests.
const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
const previousElectron = require.cache[electronPath];
beforeAll(() => {
  const stub = new Module(electronPath);
  stub.exports = { app: mocks.app };
  require.cache[electronPath] = stub;
});
afterAll(() => {
  if (previousElectron) require.cache[electronPath] = previousElectron;
  else delete require.cache[electronPath];
});

beforeEach(() => {
  mocks.windows.length = 0;
  mocks.app.isPackaged = true;
  mocks.settings = {};
});

describe('startup backdrop reassertion', () => {
  it('never resets an already-opaque window when the renderer mounts', () => {
    const manager = new WindowManager();
    manager.createWindow();
    const win = mocks.windows[0];
    expect(manager.setBackdrop(false, 'clear')).toEqual({ needsRestart: false });
    manager.setBackdrop(false, 'clear');
    // Changing the remembered material while disabled is also a native no-op.
    manager.setBackdrop(false, 'mica');
    expect(win.setBackgroundColor).not.toHaveBeenCalled();
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
  });

  it('still applies live changes, but not repeated requests for the same state', () => {
    const manager = new WindowManager();
    manager.createWindow();
    const win = mocks.windows[0];
    manager.setBackdrop(true, 'mica');
    manager.setBackdrop(true, 'mica');
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(1);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#00000000');
    if (supportsBackdropMaterial()) {
      expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith('mica');
    }
    manager.setBackdrop(true, 'acrylic');
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(2);
    if (supportsBackdropMaterial()) {
      expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith('acrylic');
    }
    manager.setBackdrop(false, 'acrylic');
    manager.setBackdrop(false, 'clear');
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(3);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#1a1a1a');
    if (supportsBackdropMaterial()) {
      expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith('none');
    }
    manager.setBackdrop(true, 'acrylic');
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(4);
  });

  it.skipIf(process.platform !== 'win32')('remembers a material applied at window creation', () => {
    mocks.settings = { 'wmux-appearance-prefs': { windowTransparency: true, windowMaterial: 'mica' } };
    const manager = new WindowManager();
    manager.createWindow();
    const win = mocks.windows[0];
    expect(win.options.backgroundMaterial).toBe('mica');
    manager.setBackdrop(true, 'mica');
    expect(win.setBackgroundColor).not.toHaveBeenCalled();
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
    manager.setBackdrop(false, 'clear');
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith('none');
  });

  it('tracks the applied state separately for each window', () => {
    const manager = new WindowManager();
    manager.createWindow();
    manager.setBackdrop(true, 'mica');
    // A newly created opaque window must not inherit the first one's cache.
    manager.createWindow();
    const [first, second] = mocks.windows;
    manager.setBackdrop(true, 'mica');
    expect(first.setBackgroundColor).toHaveBeenCalledTimes(1);
    expect(second.setBackgroundColor).toHaveBeenCalledTimes(1);
    manager.setBackdrop(false, 'clear');
    expect(first.setBackgroundColor).toHaveBeenCalledTimes(2);
    expect(second.setBackgroundColor).toHaveBeenCalledTimes(2);
  });

  it('preserves the clear-mode restart boundary', () => {
    const manager = new WindowManager();
    manager.createWindow();
    expect(manager.setBackdrop(true, 'clear')).toEqual({ needsRestart: true });
    expect(mocks.windows[0].setBackgroundColor).not.toHaveBeenCalled();
  });

  it('retries after a native backdrop change fails', () => {
    const manager = new WindowManager();
    manager.createWindow();
    const win = mocks.windows[0];
    win.setBackgroundColor.mockImplementationOnce(() => { throw new Error('native failure'); });
    manager.setBackdrop(true, 'mica');
    manager.setBackdrop(true, 'mica');
    manager.setBackdrop(true, 'mica');
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform !== 'win32')('reapplies the old state after a partially failed change', () => {
    const manager = new WindowManager();
    manager.createWindow();
    const win = mocks.windows[0];
    // Colour was changed, but applying the material failed. The old cached
    // state is no longer trustworthy, even when the next request disables it.
    win.setBackgroundMaterial.mockImplementationOnce(() => { throw new Error('native failure'); });
    manager.setBackdrop(true, 'mica');
    manager.setBackdrop(false, 'clear');
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(2);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#1a1a1a');
    expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith('none');
  });
});
