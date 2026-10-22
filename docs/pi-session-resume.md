# Restoring pi conversations

Enable **Settings → Workspace → Resume pi sessions on restore** to reopen each
restored terminal's active conversation with `pi --session <id>` in pi's last
working directory, including a directory selected by a worktree switch. The preference is **off by default**. Capture needs the
wmux pi extension installed through the existing **Status hooks** consent toggle.

wmux stores the session ID paired with pi's working directory, never the
transcript path. The parent shell's live cwd is not changed. The paired directory
is used only when pi resume is actually applied to a new PTY; disabling restore,
a conflicting startup launcher, or reattaching an existing PTY leaves the shell
cwd alone. Older ID-only reports fall back to the shell cwd. Empty sessions that pi
has not written yet and `--no-session` runs have no recovery handle. Switching to
one clears the previous conversation's handle. `/new`, `/resume`, `/fork`, and
`/reload` rebind the current ID/directory pair; same-ID directory changes update
it too. In-process child sessions marked by pi-subagents are ignored: they do not
own the parent pane's recovery handle or lifecycle. That marker is integration-specific,
not a public Pi API; unmarked child sessions cannot be distinguished. Only deliberate
pi quit releases the handle. During
wmux shutdown, releases are ignored so conversation recovery remains available.

Saved setup commands keep their order, but the actual pi launcher first changes
back to the paired directory with shell-safe quoting. Main chooses that guard
AFTER resolving the actual shell, including WSL substitution and shell fallback.
If that directory no longer exists, pi is not launched in a fallback project.
An invalid/unquotable guard omits the designated pi launch (an invalid command
index drops the batch); raw pi is never used as a fallback. Cmd rejects `%`, `"`,
and `!` in the paired directory, since delayed expansion can rewrite a quoted
`!VAR!` path. The saved recovery pair stays available for a future app restore.
Canonical `npx -y @earendil-works/pi-coding-agent[@version]` launchers (and the legacy
`@mariozechner` package) keep their original package name and flags; wmux merges the
session into that invocation instead of appending a second agent.

## ID lookup limitations

- The restored invocation must have access to the same session directory. Keep
  custom `sessionDir` settings or `PI_CODING_AGENT_SESSION_DIR` configured. A
  `--session-dir` in a saved startup command is preserved; a flag used only in a
  manually typed invocation cannot be reconstructed from an ID.
- pi searches the current project first, then other projects. A cross-project
  match may prompt to fork. This is why wmux restores pi's own paired cwd rather
  than relying on the parent shell's last reported directory.
- pi falls back to prefix matching: if a saved custom ID was deleted, a longer
  ID with that prefix can be selected. No match exits with an error. Prefer pi's
  generated UUIDs; wmux does not use `--session-id`, which can create a new session.
- IDs must start/end with an ASCII letter or number, contain only letters,
  numbers, `.`, `_`, `-`, and be at most 128 characters. IDs ending in `.jsonl`
  (case-insensitive) are not captured: pi treats those arguments as file paths
  rather than IDs, even without a path separator.

wmux does not prune pi handles by scanning the default Windows session root:
custom directories, WSL, and remote sessions would be incorrectly discarded.
If pi no longer has a conversation, choose another with `/resume` or quit pi to
remove its handle.
