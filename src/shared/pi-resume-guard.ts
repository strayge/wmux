import { isValidPiSessionCwd } from './pi-session';
import { quoteOmpArg } from './shell-quoting';

/** Transient PTY-create metadata. Never persisted; shell text is chosen only in main. */
export interface PiResumeCwdGuard {
  index: number;
  cwd: string;
}

/** The actual resolved executable is authoritative; never infer from requested cwd. */
function guardPiLaunch(command: string, cwd: unknown, resolvedShell: string): string | null {
  if (!isValidPiSessionCwd(cwd)) return null;
  const name = resolvedShell.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  if (/^(pwsh(?:-preview)?|powershell)(?:\.exe)?$/.test(name ?? '')) {
    const quoted = quoteOmpArg(cwd, 'powershell');
    return `try { Set-Location -LiteralPath ${quoted} -ErrorAction Stop; ${command} } catch { Write-Error $_ }`;
  }
  if (/^(bash|git-bash|zsh|sh|dash|ash|wsl)(?:\.exe)?$/.test(name ?? '')) {
    return `cd -- ${quoteOmpArg(cwd, 'bash')} && ${command}`;
  }
  if (/^(cmd|command)(?:\.exe)?$/.test(name ?? '')) {
    // /v:on expands !VAR! even inside quotes. Reject for pi only; omp's
    // existing quote policy is deliberately unchanged.
    if (cwd.includes('!')) return null;
    const quoted = quoteOmpArg(cwd, 'cmd');
    return quoted ? `cd /d ${quoted} && ${command}` : null;
  }
  return null; // unknown shell: omission is safer than guessing its language
}

/**
 * Apply before filtering commands, so the renderer's original index stays valid.
 * Invalid index => drop the batch; invalid cwd/shell => omit ONLY the designated
 * resume launch. Never leave its raw pi invocation behind as a fallback.
 * Non-pi callers (no descriptor) retain their original commands unchanged.
 */
export function guardPiStartupCommands(
  commands: string[],
  guard: PiResumeCwdGuard | undefined,
  resolvedShell: string,
): string[] {
  if (guard === undefined) return commands;
  if (!guard || !Number.isInteger(guard.index) || guard.index < 0 || guard.index >= commands.length
      || typeof commands[guard.index] !== 'string' || !commands[guard.index].trim()) return [];
  const guarded = guardPiLaunch(commands[guard.index], guard.cwd, resolvedShell);
  if (!guarded) return commands.filter((_command, index) => index !== guard.index);
  const next = [...commands];
  next[guard.index] = guarded;
  return next;
}
