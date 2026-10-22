import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { getAgentState, reportAgentSession, resetAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { isValidPiSessionId, stampPiSessionIds } from '../../src/main/pi-resume';
import { launchedAgent } from '../../src/renderer/hooks/agent-launcher';
import { withClaudeResume, restoredPiCwd, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { isValidPiSessionCwd } from '../../src/shared/pi-session';
import { instantiateLayout } from '../../src/renderer/store/split-utils';
import { DEFAULT_WORKSPACE_PREFS } from '../../src/renderer/store/settings-slice';
import type { SurfaceId, SplitLeaf, SurfaceRef, PaneId } from '../../src/shared/types';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'custom_session.2';
const SA = 'surf-pi-a' as SurfaceId;
const SB = 'surf-pi-b' as SurfaceId;
const terminal = (id = SA, extra: Partial<SurfaceRef> = {}): SurfaceRef => ({ id, type: 'terminal', cwd: 'C:/same-project', ...extra });
const leaf = (surfaces: SurfaceRef[]): SplitLeaf => ({ type: 'leaf', paneId: 'pane-test' as PaneId, activeSurfaceIndex: 0, surfaces });
function rpc(method: string, params: Record<string, unknown>): any {
  let response: unknown;
  expect(handleAgentStateV2(method, params, value => { response = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return response;
}
const report = (sessionId: string | null, surfaceId = SA) => rpc('pane.report_agent_session', { surfaceId, sessionId, provider: 'pi' });
function restore(surface: SurfaceRef, piEnabled = true, shell?: string, base?: string[]) {
  return withClaudeResume({
    base, surfaceId: surface.id, claudeSessionId: surface.claudeSessionId,
    codexSessionId: surface.codexSessionId, opencodeSessionId: surface.opencodeSessionId,
    agySessionId: surface.agySessionId, qwenSessionId: surface.qwenSessionId, ompSessionId: surface.ompSessionId,
    piSessionId: surface.piSessionId, piSessionCwd: surface.piSessionCwd, piEnabled, shell, enabled: true,
    codexEnabled: true, opencodeEnabled: true, agyEnabled: true, qwenEnabled: true, ompEnabled: true,
  });
}

beforeEach(() => { resetAgentState(); resetResumedSurfaces(); });

describe('pi per-terminal conversation restore', () => {
  it('round-trips two terminals in the same cwd to different IDs, never Claude', () => {
    report(A); report(B, SB);
    const saved = stampAgentSessionIds(leaf([terminal(), terminal(SB)]));
    expect(saved.surfaces.map(s => s.piSessionId)).toEqual([A, B]);
    expect(saved.surfaces.map(s => s.claudeSessionId)).toEqual([undefined, undefined]);
    expect(saved.surfaces.map(s => s.cwd)).toEqual(['C:/same-project', 'C:/same-project']);
    expect(restore(saved.surfaces[0])).toEqual([`pi --session ${A}`]);
    expect(restore(saved.surfaces[1])).toEqual([`pi --session ${B}`]);
  });

  it('is opt-in/default off and only consumes a handle once per surface', () => {
    expect(DEFAULT_WORKSPACE_PREFS.restorePiSessions).toBe(false);
    const surface = terminal(SA, { piSessionId: A });
    expect(restore(surface, false)).toBeUndefined();
    expect(restore(surface)).toEqual([`pi --session ${A}`]);
    expect(restore(surface)).toBeUndefined();
  });

  it.each(['cmd.exe', 'pwsh.exe', 'powershell.exe', 'bash.exe', 'wsl.exe'])('uses one safe bare ID token in %s', shell => {
    expect(restore(terminal(SA, { piSessionId: B }), true, shell)).toEqual([`pi --session ${B}`]);
  });

  it.each(['a', A, B, 'A_b-C.3', 'a'.repeat(128)])('accepts pi ID %s', id => {
    expect(isValidPiSessionId(id)).toBe(true);
    report(id);
    expect(getAgentState(SA)?.sessionProvider).toBe('pi');
    expect(getAgentState(SA)?.sessionId).toBe(id);
  });

  it.each(['', '-a', '_a', '.a', 'a-', 'a_', 'a.', 'a'.repeat(129), 'x.jsonl', 'X.JsOnL',
    'a b', 'a;calc', 'a&calc', 'a|calc', 'a$(calc)', 'a`calc`', 'a%PATH%', 'a"b', "a'b", 'a\nb',
    'a\rb', 'a\0b', 'a\n', 'a\r', 'a\r\n', 'a\u2028', 'a\u2029', '../x', 'C:/x', '/x', 'a\\b', 'é', null, 42])('rejects unsafe/path-like ID %s at both boundaries', id => {
    expect(isValidPiSessionId(id)).toBe(false);
    reportAgentSession(SA, { sessionId: id as any, provider: 'pi' });
    expect(getAgentState(SA)?.sessionId).toBeNull();
    expect(restore(terminal(SA, { piSessionId: id as any }))).toBeUndefined();
  });

  it('keeps true awaiting-report silence but clears an explicit empty/ephemeral pi', () => {
    const saved = leaf([terminal(SA, { piSessionId: A })]);
    expect(stampAgentSessionIds(saved)).toBe(saved);
    rpc('pane.report_agent', { surfaceId: SA, runDepth: 0 });
    expect(stampAgentSessionIds(saved)).toBe(saved);
    report(A);
    const active = stampAgentSessionIds(saved);
    report(null); // /new or --no-session
    expect(stampAgentSessionIds(active).surfaces[0].piSessionId).toBeUndefined();
    expect(getAgentState(SA)?.sessionProvider).toBe('pi');
    report(B);
    expect(stampAgentSessionIds(active).surfaces[0].piSessionId).toBe(B);
    report(A); // /resume A after B, or /reload A
    expect(stampAgentSessionIds(active).surfaces[0].piSessionId).toBe(A);
  });

  it('stamps only persisted terminals, preserving input and undefined silence', () => {
    const tree = leaf([terminal(), { type: 'browser', id: SB, piSessionId: A }]);
    const next = stampPiSessionIds(tree, () => B);
    expect(tree.surfaces[0].piSessionId).toBeUndefined();
    expect(next.surfaces[0].piSessionId).toBe(B);
    expect(next.surfaces[1]).toBe(tree.surfaces[1]);
    expect(stampPiSessionIds(next, () => undefined)).toBe(next);
    expect(stampPiSessionIds(next, () => null).surfaces[0].piSessionId).toBeUndefined();
  });

  it('mutually clears other providers on pi report and clears pi on another provider report', () => {
    const saved = leaf([terminal(SA, { claudeSessionId: A, codexSessionId: A, opencodeSessionId: 'ses_1234567890',
      agySessionId: A, qwenSessionId: A, ompSessionId: 'C:/session.jsonl' })]);
    report(B);
    expect(stampAgentSessionIds(saved).surfaces[0]).toEqual(terminal(SA, { piSessionId: B }));
    const piSaved = leaf([terminal(SA, { piSessionId: B, piSessionCwd: '/worktree/B' })]);
    reportAgentSession(SA, { sessionId: A, provider: 'claude' });
    expect(stampAgentSessionIds(piSaved).surfaces[0]).toEqual(terminal(SA, { claudeSessionId: A }));
    // An empty pi report cannot erase another provider's handle or blocked state.
    rpc('pane.report_agent', { surfaceId: SA, awaitingHuman: true, reason: 'permission' });
    expect(report(null).accepted).toBe(false);
    expect(getAgentState(SA)?.sessionId).toBe(A);
    expect(getAgentState(SA)?.state).toBe('blocked');
  });

  it.each(['claudeSessionId', 'codexSessionId', 'opencodeSessionId', 'agySessionId', 'qwenSessionId', 'ompSessionId'] as const)(
    'refuses mixed-provider saved state with %s', field => {
      expect(restore(terminal(SA, { piSessionId: A, [field]: B }))).toBeUndefined();
    });

  it('releases only pi and optionally only the exact current ID', () => {
    report(A);
    const saved = stampAgentSessionIds(leaf([terminal()]));
    expect(rpc('pane.release_pi_session', { surfaceId: SA, sessionId: B }).released).toBe(false);
    expect(rpc('pane.release_pi_session', { surfaceId: SA, sessionId: '' }).released).toBe(false);
    expect(rpc('pane.release_pi_session', { surfaceId: SA, sessionId: A }).released).toBe(true);
    expect(stampAgentSessionIds(saved).surfaces[0].piSessionId).toBeUndefined();
    report(A);
    expect(rpc('pane.release_pi_session', { surfaceId: SA }).released).toBe(true);
  });

  it('releases status-only pi records but never another provider, even without its ID', () => {
    rpc('pane.report_agent', { surfaceId: SA, runDepth: 1 });
    expect(rpc('pane.release_pi_session', { surfaceId: SA, sessionId: '' }).released).toBe(true);
    report(null);
    expect(rpc('pane.release_pi_session', { surfaceId: SA, sessionId: '' }).released).toBe(true);
    reportAgentSession(SA, { sessionId: A, provider: 'claude' });
    expect(rpc('pane.release_pi_session', { surfaceId: SA }).released).toBe(false);
    reportAgentSession(SA, { sessionId: null, provider: 'opencode' });
    expect(rpc('pane.release_pi_session', { surfaceId: SA }).released).toBe(false);
    expect(getAgentState(SA)?.sessionProvider).toBe('opencode');
  });

  it('strips pi recovery IDs from newly instantiated layout presets', () => {
    const created = instantiateLayout(leaf([terminal(SA, { piSessionId: A, piSessionCwd: '/worktree/A' })])).surfaces[0];
    expect(created.piSessionId).toBeUndefined();
    expect(created.piSessionCwd).toBeUndefined();
  });

  it('recognizes pi launchers and merges sessions without losing custom configuration', () => {
    expect(launchedAgent('pi')).toBe('pi');
    expect(launchedAgent('npx -y pi')).toBe('pi');
    expect(launchedAgent('"C:\\Program Files\\pi.cmd"')).toBe('pi');
    expect(launchedAgent('pi-monitor')).toBeUndefined();
    const base = ['setup', 'pi --session old --session-dir "C:\\custom sessions" --model custom'];
    expect(restore(terminal(SA, { piSessionId: A }), true, 'cmd.exe', base)).toEqual([
      'setup', `pi --session-dir "C:\\custom sessions" --model custom --session ${A}`,
    ]);
    expect(base[1]).toContain('--session old');
  });

  it.each(['--continue', '-c', '--resume', '-r', '--session old', '--session=old', '--session-id old', '--session-id=old'])(
    'replaces conflicting pi session selector %s', flag => {
      expect(restore(terminal(SA, { piSessionId: A }), true, undefined, [`pi ${flag} --model custom`]))
        .toEqual([`pi --model custom --session ${A}`]);
    });

  it('keeps a pi initial prompt when replacing its valueless resume-picker flag', () => {
    expect(restore(terminal(SA, { piSessionId: A }), true, undefined, ['pi --resume "initial prompt"']))
      .toEqual([`pi "initial prompt" --session ${A}`]);
  });

  it.each(['pi --no-session', 'pi --fork old', 'pi --fork=old', 'pi -- prompt', 'claude'])('leaves explicit incompatible launcher %s alone', launcher => {
    const base = [launcher];
    expect(restore(terminal(SA, { piSessionId: A }), true, undefined, base)).toBe(base);
  });

  it('atomically stamps cwd with the current pi ID, updates same-ID cwd, and clears both on empty/exit', () => {
    let saved = leaf([terminal(SA, { piSessionId: A, piSessionCwd: '/worktree/A' })]);
    expect(stampAgentSessionIds(saved)).toBe(saved); // real awaiting-report silence
    for (const [sessionId, cwd] of [[B, '/worktree/B'], [A, '/worktree/A'], [A, '/worktree/A-moved']]) {
      rpc('pane.report_agent_session', { surfaceId: SA, provider: 'pi', sessionId, cwd });
      saved = stampAgentSessionIds(saved);
      expect(saved.surfaces[0]).toEqual(terminal(SA, { piSessionId: sessionId, piSessionCwd: cwd }));
      expect(getAgentState(SA)?.piSessionCwd).toBe(cwd);
    }
    report(null);
    expect(getAgentState(SA)?.piSessionCwd).toBeUndefined();
    expect(stampAgentSessionIds(saved).surfaces[0]).toEqual(terminal());
    rpc('pane.report_agent_session', { surfaceId: SA, provider: 'pi', sessionId: B, cwd: '/worktree/B' });
    rpc('pane.release_pi_session', { surfaceId: SA, sessionId: B });
    expect(stampAgentSessionIds(saved).surfaces[0]).toEqual(terminal());
  });

  it('keeps ID-only reports backward compatible and never retains a cwd from an earlier pair', () => {
    rpc('pane.report_agent_session', { surfaceId: SA, provider: 'pi', sessionId: A, cwd: '/worktree/A' });
    const saved = stampAgentSessionIds(leaf([terminal()]));
    report(B);
    expect(stampAgentSessionIds(saved).surfaces[0]).toEqual(terminal(SA, { piSessionId: B }));
    expect(getAgentState(SA)?.piSessionCwd).toBeUndefined();
    reportAgentSession(SA, { provider: 'claude', sessionId: A, cwd: '/ignored' });
    expect(getAgentState(SA)?.piSessionCwd).toBeUndefined();
    reportAgentSession(SA, { provider: 'opencode', sessionId: null });
    const otherProvider = stampAgentSessionIds(saved).surfaces[0];
    expect(otherProvider.piSessionId).toBeUndefined();
    expect(otherProvider.piSessionCwd).toBeUndefined();
  });

  it.each(['C:/worktree B', 'D:\\worktrees\\R&D', '/home/user/worktree', '/home/user/$literal', '\\\\server\\share\\tree', '/'])('accepts absolute cwd %s without resolving it on this machine', cwd => {
    expect(isValidPiSessionCwd(cwd)).toBe(true);
    expect(rpc('pane.report_agent_session', { surfaceId: SA, provider: 'pi', sessionId: B, cwd }).accepted).toBe(true);
    expect(stampAgentSessionIds(leaf([terminal()])).surfaces[0].piSessionCwd).toBe(cwd);
  });

  it.each(['', 'relative/tree', 'C:relative', '\\relative', '/a\n', '/a\rb', '/a\0b', '/a\x7f', '/a\u0085', '/a\u2028', '/a\u2029', '/' + 'x'.repeat(4096), null, 42])('rejects malformed pi cwd %j at main and renderer boundaries', cwd => {
    expect(isValidPiSessionCwd(cwd)).toBe(false);
    rpc('pane.report_agent_session', { surfaceId: SA, provider: 'pi', sessionId: A, cwd: '/worktree/A' });
    expect(rpc('pane.report_agent_session', { surfaceId: SA, provider: 'pi', sessionId: B, cwd }).accepted).toBe(false);
    expect(getAgentState(SA)?.sessionId).toBe(A);
    expect(getAgentState(SA)?.piSessionCwd).toBe('/worktree/A');
    const surface = terminal(SA, { piSessionId: B, piSessionCwd: cwd as any });
    expect(restore(surface)).toBeUndefined();
    expect(restoredPiCwd({ shellCwd: 'C:/shell', piSessionId: B, piSessionCwd: cwd as any,
      piEnabled: true, base: undefined, commands: [`pi --session ${B}`] })).toBe('C:/shell');
  });

  it('spawns B in its own cwd instead of shell A only if the pi resume was actually applied', () => {
    const surface = terminal(SA, { piSessionId: B, piSessionCwd: '/worktree/B' });
    const spawnCwd = (enabled: boolean, base?: string[], reattaching = false) => {
      const commands = reattaching ? base : restore(surface, enabled, 'wsl.exe', base);
      return restoredPiCwd({ shellCwd: surface.cwd!, piSessionId: surface.piSessionId,
        piSessionCwd: surface.piSessionCwd, piEnabled: enabled, base, commands, reattaching });
    };
    expect(spawnCwd(false)).toBe('C:/same-project');
    expect(spawnCwd(true, ['pi --no-session'])).toBe('C:/same-project');
    expect(spawnCwd(true, ['claude'])).toBe('C:/same-project');
    expect(spawnCwd(true, undefined, true)).toBe('C:/same-project');
    expect(spawnCwd(true)).toBe('/worktree/B');
    expect(spawnCwd(true)).toBe('C:/same-project'); // already consumed
    resetResumedSurfaces();
    const mixed = { ...surface, claudeSessionId: A };
    expect(restoredPiCwd({ shellCwd: surface.cwd!, piSessionId: B, piSessionCwd: '/worktree/B',
      piEnabled: true, base: undefined, commands: restore(mixed) })).toBe('C:/same-project');
    expect(restoredPiCwd({ shellCwd: surface.cwd!, piSessionId: B, piEnabled: true,
      base: undefined, commands: [`pi --session ${B}`] })).toBe('C:/same-project'); // legacy ID only
  });

  it('routes pi release through the quitting guard and wires every renderer prop/ref', () => {
    const root = path.resolve(__dirname, '../..');
    const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
    const main = read('src/main/index.ts');
    const guard = main.slice(main.indexOf("if ((request.method === 'pane.release_codex_session'"), main.indexOf('// Declared agent state (issue #128)'));
    expect(guard).toContain("request.method === 'pane.release_pi_session'");
    expect(guard).toContain('&& isQuitting');
    expect(guard).toContain('respond({ released: false })');
    // Execute the real isolated route guard, not a copy of its decision.
    const quittingGuard = new Function('request', 'isQuitting', 'respond', `${guard}\nreturn false;`);
    const respond = vi.fn();
    report(A);
    expect(quittingGuard({ method: 'pane.release_pi_session' }, true, respond)).toBe(true);
    expect(respond).toHaveBeenCalledWith({ released: false });
    expect(getAgentState(SA)?.sessionId).toBe(A);
    expect(quittingGuard({ method: 'pane.release_pi_session' }, false, respond)).toBe(false);
    expect(read('src/renderer/hooks/useTerminal.ts')).toContain('piSessionId: piSessionIdRef.current');
    const terminalHook = read('src/renderer/hooks/useTerminal.ts');
    expect(terminalHook).toContain('const piEnabled = useStore.getState().workspacePrefs.restorePiSessions');
    expect(terminalHook).toContain('piSessionCwd: piSessionCwdRef.current');
    expect(terminalHook).toContain('cwd: spawnCwd');
    expect(terminalHook).toContain('piResumeCwdGuard: piGuard');
    const existingBranch = terminalHook.slice(terminalHook.indexOf('if (exists) {'), terminalHook.indexOf('// No existing PTY'));
    expect(existingBranch).toContain('attachToPty(surfaceId!)');
    expect(existingBranch).toContain('restoreSurfaceState(true)');
    expect(existingBranch).not.toContain('piResumeCwdGuard');
    expect(existingBranch).not.toContain('withClaudeResume');
    expect(terminalHook).toContain('restoreSurfaceState(created.reused)');
    expect(terminalHook).toContain('reused: boolean; shellFallbackFrom?: string');
    const wrapper = read('src/renderer/components/SplitPane/PaneWrapper.tsx');
    const keptTerminal = wrapper.slice(wrapper.indexOf('<KeptAliveTerminal'), wrapper.indexOf('/>', wrapper.indexOf('<KeptAliveTerminal')));
    expect(keptTerminal).toContain('piSessionId={surface.piSessionId}');
    expect(keptTerminal).toContain('piSessionCwd={surface.piSessionCwd}');
    const pane = read('src/renderer/components/Terminal/TerminalPane.tsx');
    expect(pane).toContain('export interface TerminalPaneProps');
    const hookCall = pane.slice(pane.indexOf('= useTerminal('), pane.indexOf(');', pane.indexOf('= useTerminal(')));
    for (const prop of ['piSessionId', 'piSessionCwd', 'attachGeneration']) {
      expect(hookCall).toContain(prop);
      expect(terminalHook.slice(terminalHook.indexOf('export function useTerminal'), terminalHook.indexOf(': UseTerminalOptions = {}'))).toContain(prop);
    }
    const preload = read('src/preload/index.ts');
    const createApi = preload.slice(preload.indexOf('create: (options:'), preload.indexOf('write: (id:'));
    expect(createApi).toContain('piResumeCwdGuard?: PiResumeCwdGuard');
    expect(createApi).toContain('reused: boolean');
    expect(read('src/renderer/components/Settings/WorkspaceSettings.tsx')).toContain('checked={workspacePrefs.restorePiSessions}');
  });
});
