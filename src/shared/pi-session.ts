/** Pi's recovery handle stays an ID; cwd is paired metadata, never a transcript path. */
export interface PiSessionBinding {
  sessionId: string;
  cwd?: string;
}

/** A bare pi ID safe in every supported shell and unambiguous as an ID argument. */
export function isValidPiSessionId(id: unknown): id is string {
  // pi --session treats *.jsonl as a file path BEFORE attempting ID lookup.
  return typeof id === 'string'
    // Absolute end, unlike $, which also accepts a trailing line terminator.
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?(?![\s\S])/.test(id)
    && !/\.jsonl$/i.test(id);
}

/** Validate spelling only: main cannot stat/resolve WSL or remote directories. */
export function isValidPiSessionCwd(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(cwd)
    && (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)
      || /^\\\\[^\\/]+[\\/][^\\/]+/.test(cwd));
}
