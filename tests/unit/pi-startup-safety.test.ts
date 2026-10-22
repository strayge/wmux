import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { launchedAgent, quoteOmpArg } from '../../src/renderer/hooks/agent-launcher';
import { hasResumed, piResumeCwdGuard, resetResumedSurfaces, withClaudeResume } from '../../src/renderer/hooks/claude-resume-command';
import { guardPiStartupCommands } from '../../src/shared/pi-resume-guard';

const ID = 'session-B';
const SURFACE = 'surf-pi-startup';
function prepare(base?: string[], cwd?: string, shell?: string) {
  const commands = withClaudeResume({ base, surfaceId: SURFACE, claudeSessionId: undefined,
    enabled: false, piEnabled: true, piSessionId: ID, piSessionCwd: cwd, shell });
  const guard = piResumeCwdGuard({ shellCwd: 'C:/shell', piSessionId: ID, piSessionCwd: cwd,
    piEnabled: true, base, commands });
  return { commands, guard };
}
function resume(base?: string[], cwd?: string, resolvedShell = 'powershell.exe') {
  const { commands, guard } = prepare(base, cwd);
  return guard ? guardPiStartupCommands(commands!, guard, resolvedShell) : commands;
}
beforeEach(resetResumedSurfaces);

describe('pi launch cwd guards', () => {
  it('guards the actual launcher at its index, after setup and before trailing commands', () => {
    const base = ['cd /tmp/A', 'export SOME_SETUP=done', 'pi --model custom', 'echo after-pi'];
    expect(resume(base, '/tmp/B', 'bash')).toEqual([
      'cd /tmp/A', 'export SOME_SETUP=done', `cd -- '/tmp/B' && pi --model custom --session ${ID}`, 'echo after-pi',
    ]);
    expect(base[2]).toBe('pi --model custom');
  });

  it('guards an appended resume after setup too', () => {
    expect(resume(['cd /d C:/A'], 'D:/worktree B & literal', 'cmd.exe')).toEqual([
      'cd /d C:/A', `cd /d "D:/worktree B & literal" && pi --session ${ID}`,
    ]);
  });

  it('guards even without setup: PTY cwd can fall back when the worktree was deleted', () => {
    expect(resume(undefined, '/tmp/B', 'bash')).toEqual([`cd -- '/tmp/B' && pi --session ${ID}`]);
  });

  it('keeps the old simple command for an ID-only capture', () => {
    expect(resume()).toEqual([`pi --session ${ID}`]);
  });

  it('quotes POSIX apostrophes without interpreting dollar signs or ampersands', () => {
    expect(resume(['pi'], "/tmp/it's $literal & tree", 'bash')).toEqual([
      `cd -- '/tmp/it'\\''s $literal & tree' && pi --session ${ID}`,
    ]);
  });

  it('quotes PowerShell plain and typographic apostrophes and makes location failure terminating', () => {
    expect(resume(['pi --model custom'], "C:/O‘Brien's & $literal", 'pwsh.exe')).toEqual([
      `try { Set-Location -LiteralPath 'C:/O‘‘Brien''s & $literal' -ErrorAction Stop; pi --model custom --session ${ID} } catch { Write-Error $_ }`,
    ]);
  });

  it.each(['C:/%PATH%/tree', 'C:/a" & calc & "', 'C:/!VAR!/tree'])('omits an unsafe pi launch for resolved cmd cwd %s; never replays the raw command', cwd => {
    const base = ['cd /d C:/A', 'pi --model custom'];
    const { commands, guard } = prepare(base, cwd, 'pwsh.exe');
    expect(commands).toEqual(['cd /d C:/A', `pi --model custom --session ${ID}`]);
    expect(guard).toEqual({ index: 1, cwd });
    expect(guardPiStartupCommands(commands!, guard, 'cmd.exe')).toEqual(['cd /d C:/A']);
    expect(hasResumed(SURFACE)).toBe(true); // main owns delivery, including omission
    expect(quoteOmpArg('C:/!VAR!/tree', 'cmd.exe')).toBe('"C:/!VAR!/tree"'); // omp unchanged
  });

  it('sends only raw launch text and an index/cwd descriptor from the renderer', () => {
    const { commands, guard } = prepare(['cd /tmp/A', 'pi'], '/tmp/B', 'pwsh.exe');
    expect(commands).toEqual(['cd /tmp/A', `pi --session ${ID}`]);
    expect(guard).toEqual({ index: 1, cwd: '/tmp/B' });
  });

  it('fails closed on malformed index/cwd or an unknown actual shell and keeps no-pi calls identical', () => {
    const commands = ['echo setup', `pi --session ${ID}`];
    expect(guardPiStartupCommands(commands, undefined, 'anything')).toBe(commands);
    expect(guardPiStartupCommands(commands, { index: 99, cwd: '/tmp/B' }, 'bash')).toEqual([]);
    expect(guardPiStartupCommands(commands, { index: 1, cwd: 'relative' }, 'bash')).toEqual(['echo setup']);
    expect(guardPiStartupCommands(commands, { index: 1, cwd: '/tmp/B' }, 'mystery.exe')).toEqual(['echo setup']);
  });
});

describe('canonical npm pi launchers', () => {
  it.each([
    'npx -y @earendil-works/pi-coding-agent',
    'npx --yes @earendil-works/pi-coding-agent@0.77.0',
    'pnpm dlx @earendil-works/pi-coding-agent@latest',
    'bunx @earendil-works/pi-coding-agent@^0.77.0',
    'npx -y @mariozechner/pi-coding-agent',
    'npx -y @mariozechner/pi-coding-agent@0.60.0',
  ])('merges one session into %s without renaming the package', launcher => {
    expect(launchedAgent(launcher)).toBe('pi');
    expect(resume([`${launcher} --model custom --session old`])).toEqual([`${launcher} --model custom --session ${ID}`]);
  });

  it.each(['--no-session', '--fork old', '--fork=old', '-- prompt'])('respects incompatible scoped-launcher flags %s', flag => {
    const base = [`npx -y @earendil-works/pi-coding-agent@latest ${flag}`];
    expect(resume(base, '/tmp/B', 'bash')).toBe(base);
    expect(hasResumed(SURFACE)).toBe(false);
  });

  it.each(['npx -y @other/pi-coding-agent', 'npx -y @other/pi',
    'npx -y @earendil-works/pi-coding-agent-extra', 'npx -y @earendil-works/pi-coding-agent@',
    'npx -y @mariozechner/pi-coding-agent-tools'])('does not identify an unrelated package as pi: %s', launcher => {
    expect(launchedAgent(launcher)).toBeUndefined();
  });
});

const powershell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  : '/not-installed/powershell';
// Execute a harmless function named pi in a fresh shell. No real agent, profile,
// package install, user configuration, or inherited shell state is involved.
describe.skipIf(!fs.existsSync(powershell))('real PowerShell startup execution', () => {
  const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`;
  function execute(commands: string[], cwd: string, probe: string, root: string) {
    const script = path.join(root, 'startup.ps1');
    // Windows PowerShell 5.1 requires a BOM to read non-ASCII script literals.
    fs.writeFileSync(script, '\uFEFF' + [
      'function pi {',
      `  [pscustomobject]@{ cwd = (Get-Location).ProviderPath; argv = @($args); setup = $env:WMUX_PI_SETUP_PROBE } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${psQuote(probe)} -Encoding UTF8`,
      '}',
      `foreach ($command in @(${commands.map(psQuote).join(', ')})) {`,
      '  try { Invoke-Expression $command } catch { Write-Error $_ }',
      '}',
    ].join('\n'));
    return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  }

  it('runs pi in B after setup cd A, preserving setup order and launcher arguments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-startup-'));
    try {
      const a = path.join(root, 'A');
      const b = path.join(root, "B's ‘clauses’ & $literal");
      fs.mkdirSync(a); fs.mkdirSync(b);
      const probe = path.join(root, 'pi-called.json');
      const base = [`Set-Location -LiteralPath ${psQuote(a)}`, "$env:WMUX_PI_SETUP_PROBE = 'setup-ran'", 'pi --model custom'];
      const commands = resume(base, b, 'powershell.exe')!;
      const result = execute(commands, b, probe, root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(probe), result.stderr).toBe(true);
      const captured = JSON.parse(fs.readFileSync(probe, 'utf8').replace(/^\uFEFF/, ''));
      expect(captured.cwd).toBe(b);
      expect(captured.argv).toEqual(['--model', 'custom', '--session', ID]);
      expect(captured.setup).toBe('setup-ran');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('never executes pi for a missing target (preceding setup: %s)', setup => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-missing-'));
    try {
      const a = path.join(root, 'A'); fs.mkdirSync(a);
      const missing = path.join(root, 'deleted-worktree');
      const probe = path.join(root, 'pi-must-not-run.json');
      const base = setup ? [`Set-Location -LiteralPath ${psQuote(a)}`, 'pi --model custom'] : undefined;
      const result = execute(resume(base, missing, 'powershell.exe')!, a, probe, root);
      expect(result.error).toBeUndefined();
      expect(fs.existsSync(probe), result.stderr).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
