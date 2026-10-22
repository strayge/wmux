import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Run the REAL PtyManager.create pipeline and shell resolver. Only the native
// process and readiness driver are stand-ins; no WSL distro or agent is started.
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({
  pid: 123456, onData: vi.fn(), onExit: vi.fn(), on: vi.fn(), write: vi.fn(), kill: vi.fn(),
})) }));
vi.mock('../../src/main/startup-commands', () => ({ deliverStartupCommandsWhenReady: vi.fn(() => () => {}) }));
vi.mock('../../src/main/pty-crash-guard', () => ({ installPtyCrashGuard: () => true, attachErrorSink: () => {} }));
vi.mock('../../src/main/powershell-shim', () => ({ powerShellShimDir: () => null }));
vi.mock('../../src/main/node-runtime', () => ({ getNodeRuntime: () => ({ path: process.execPath, electron: false }) }));
vi.mock('../../src/main/settings-store', () => ({ loadSettings: () => ({}) }));
vi.mock('../../src/shared/instance', () => ({ getPipePath: () => 'test-pipe', readPipeToken: () => 'test-token' }));
import * as pty from 'node-pty';
import { deliverStartupCommandsWhenReady } from '../../src/main/startup-commands';
import { PtyManager, shellProbe, shellEnv, gitBashProbe, resetShellPathCache } from '../../src/main/pty-manager';
import type { SurfaceId } from '../../src/shared/types';

const ID = 'session-B';
const RAW = `pi --model custom --session ${ID}`;
const spawned = () => vi.mocked(pty.spawn).mock.lastCall!;
const delivered = () => {
  const env = spawned()[2]?.env as Record<string, string>;
  return env.WMUX_STARTUP_COMMANDS
    ? env.WMUX_STARTUP_COMMANDS.split('\n')
    : vi.mocked(deliverStartupCommandsWhenReady).mock.lastCall?.[1] ?? [];
};

describe.runIf(process.platform === 'win32')('PtyManager pi guard uses the actual resolved shell', () => {
  let manager: PtyManager;
  beforeEach(() => {
    vi.clearAllMocks(); resetShellPathCache();
    vi.spyOn(shellProbe, 'onPath').mockImplementation(name => {
      if (/^(pwsh|cmd)\.exe$/i.test(name)) return `C:/fake/${name}`;
      return undefined;
    });
    vi.spyOn(gitBashProbe, 'find').mockReturnValue(undefined);
    vi.spyOn(shellEnv, 'isWindows').mockReturnValue(true);
    vi.spyOn(shellEnv, 'hasWsl').mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager = new PtyManager();
  });
  afterEach(() => { manager.killAll(); vi.restoreAllMocks(); resetShellPathCache(); });

  it.each(['pwsh.exe', 'cmd.exe'])('requested %s + POSIX cwd becomes WSL, and receives only POSIX guard text', shell => {
    const cwd = '/home/user/worktree-B';
    manager.create({ shell, cwd, env: {}, startupCommands: ['cd /home/user/A', RAW], piResumeCwdGuard: { index: 1, cwd } });
    expect(spawned()[0]).toBe('wsl.exe');
    expect(delivered()).toEqual(['cd /home/user/A', `cd -- '${cwd}' && ${RAW}`]);
    expect(delivered().join('\n')).not.toContain('catch');
    expect(delivered().join('\n')).not.toContain('Set-Location');
  });

  it('unavailable requested bash falls back to pwsh and bakes a PowerShell guard, never POSIX syntax', () => {
    const cwd = os.tmpdir();
    const created = manager.create({ shell: 'bash.exe', cwd, env: {}, startupCommands: [RAW], piResumeCwdGuard: { index: 0, cwd } });
    expect(created.shellFallbackFrom).toBe('bash.exe');
    expect(spawned()[0]).toBe('C:/fake/pwsh.exe');
    expect(delivered()).toEqual([`try { Set-Location -LiteralPath '${cwd.replace(/['‘’‚‛]/g, '$&$&')}' -ErrorAction Stop; ${RAW} } catch { Write-Error $_ }`]);
    expect(vi.mocked(deliverStartupCommandsWhenReady)).not.toHaveBeenCalled(); // baked into actual PowerShell init
  });

  it('guard indices refer to the raw list, before empty startup commands are filtered', () => {
    const cwd = os.tmpdir();
    manager.create({ shell: 'cmd.exe', cwd, env: {}, startupCommands: ['', RAW], piResumeCwdGuard: { index: 1, cwd } });
    expect(delivered()).toEqual([`cd /d "${cwd}" && ${RAW}`]);
  });

  it('an invalid guard index cannot leave any raw pi invocation behind', () => {
    const created = manager.create({ shell: 'cmd.exe', cwd: os.tmpdir(), env: {}, startupCommands: ['echo SETUP', RAW],
      piResumeCwdGuard: { index: 99, cwd: os.tmpdir() } });
    expect(delivered()).toEqual([]);
    expect(created.startupCommandsConsumed).toBe(true); // callers must not replay the unsafe originals
  });

  it('idempotent reuse never rewrites or redelivers the existing PTY with new guard metadata', () => {
    const surfaceId = 'surf-pi-reused' as SurfaceId;
    manager.create({ shell: 'cmd.exe', cwd: os.tmpdir(), env: {}, surfaceId, startupCommands: ['echo ORIGINAL'] });
    const again = manager.create({ shell: 'pwsh.exe', cwd: '/home/user/B', env: {}, surfaceId, startupCommands: [RAW],
      piResumeCwdGuard: { index: 0, cwd: '/home/user/B' } });
    expect(again.reused).toBe(true);
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(delivered()).toEqual(['echo ORIGINAL']);
    expect(deliverStartupCommandsWhenReady).toHaveBeenCalledTimes(1);
  });

  it('default no-pi startup calls are unchanged', () => {
    manager.create({ shell: 'cmd.exe', cwd: os.tmpdir(), env: {}, startupCommands: ['echo SETUP', 'echo HELLO'] });
    expect(delivered()).toEqual(['echo SETUP', 'echo HELLO']);
  });

  it('cmd /v:on never launches pi after a bang cwd rewrites into an existing wrong directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-bang-'));
    try {
      const existing = path.join(root, 'wmux'); fs.mkdirSync(existing);
      const cwd = path.join(root, 'wmux!WMUX_REVIEW_REWRITE!'); // does NOT exist
      const probe = path.join(root, 'pi-must-not-run.txt');
      fs.writeFileSync(path.join(root, 'pi.cmd'), '@echo off\r\necho PI_RAN>"%WMUX_PI_PROBE%"\r\n');
      const created = manager.create({ shell: 'cmd.exe /v:on', cwd, env: { WMUX_REVIEW_REWRITE: '\\..\\wmux' },
        startupCommands: ['echo SETUP', `"${path.join(root, 'pi.cmd')}" --session ${ID}`], piResumeCwdGuard: { index: 1, cwd } });
      expect(spawned()[0]).toBe('C:/fake/cmd.exe');
      expect(spawned()[1]).toContain('/v:on');
      expect(delivered()).toEqual(['echo SETUP']);
      expect(created.startupCommandsConsumed).toBe(true);
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'),
        ['/d', '/v:on', '/c', delivered().join(' & ')], { cwd: existing, encoding: 'utf8', windowsHide: true,
          env: { ...process.env, WMUX_REVIEW_REWRITE: '\\..\\wmux', WMUX_PI_PROBE: probe } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(probe)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
