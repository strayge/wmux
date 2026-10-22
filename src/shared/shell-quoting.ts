/** Which quoting rules a shell applies to a single argument. */
export type ShellFamily = 'powershell' | 'posix' | 'cmd';

export function detectShellFamily(shell?: string, samplePath?: string): ShellFamily {
  if (!shell) return samplePath?.startsWith('/') ? 'posix' : 'powershell';
  const lower = shell.toLowerCase();
  if (/\b(pwsh|powershell)\b/.test(lower)) return 'powershell';
  if (/\b(cmd|command)\b/.test(lower)) return 'cmd';
  if (/\b(bash|zsh|sh|wsl|dash|ash)\b/.test(lower)) return 'posix';
  return samplePath?.startsWith('/') ? 'posix' : 'powershell';
}

/** Existing omp argument quoting, shared without changing its accepted paths. */
export function quoteOmpArg(id: string, shell?: string): string | null {
  const family = detectShellFamily(shell, id);
  if (family === 'powershell') {
    // PowerShell also treats these typographic quotes as string delimiters.
    return `'${id.replace(/['‘’‚‛]/g, '$&$&')}'`;
  }
  if (family === 'posix') return `'${id.replace(/'/g, "'\\''")}'`;
  if (id.includes('%') || id.includes('"')) return null;
  return `"${id}"`;
}
