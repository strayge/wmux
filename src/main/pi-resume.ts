import type { SurfaceId } from '../shared/types';
import { isValidPiSessionId, isValidPiSessionCwd, type PiSessionBinding } from '../shared/pi-session';
import { mapSurfaces } from './claude-resume';

export { isValidPiSessionId } from '../shared/pi-session';

/** Undefined is silence; every explicit update stamps or removes the whole pair. */
export function stampPiSessionIds<T>(
  tree: T,
  lookup: (id: SurfaceId) => PiSessionBinding | string | null | undefined,
): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const id = typeof found === 'string' ? found : found?.sessionId;
    const cwd = typeof found === 'object' ? found?.cwd : undefined;
    const valid = isValidPiSessionId(id) && (cwd === undefined || isValidPiSessionCwd(cwd));
    const nextId = valid ? id : undefined;
    const nextCwd = valid ? cwd : undefined;
    if (nextId === surface.piSessionId && nextCwd === surface.piSessionCwd) return surface;
    const rest = { ...surface };
    delete rest.piSessionId;
    delete rest.piSessionCwd;
    return nextId ? { ...rest, piSessionId: nextId, ...(nextCwd !== undefined ? { piSessionCwd: nextCwd } : {}) } : rest;
  });
}

// Deliberately no default-root pruning: pi can run in WSL/SSH, with a custom
// sessionDir setting, environment, or --session-dir. Main cannot enumerate the
// authoritative directory from an ID. pi itself resolves --session in the pane's
// restored pi cwd; see docs/pi-session-resume.md for its prefix-lookup limitation.
