# Safety, state, and recovery

[Home](../README.md) · [Getting started](getting-started.md) · [Office guide](office-guide.md)

## The trust boundary

HappyMachines runs for **one local user** at `127.0.0.1`, with same-origin
write and browser-cookie checks. Don't expose it through a proxy or treat it
as a hosted multi-user service. Default manual mode asks you to **Allow once**
or **Deny** built-in tool requests individually. A read grant enables bounded
repository research for that repo; it is not approval for built-in shell or
write tools. Permission requests expire or are denied when the last browser
leaves. Keep the browser open while making decisions.

GitHub repo grants require a verified identity. A separate Git worktree
isolates Git changes from your main checkout, **not OS access**. Built-in tools,
especially shell commands, can reach outside it using the host account's
files, credentials, and network. Choose repositories you trust and inspect
requests before allowing them.

**Allow autonomous local work for this task** appears only after explicit
edit-worktree approval. It starts **off**. With your consent the server
autoapproves matching built-in `bash`, `apply_patch`, `view`, `rg`, and `glob`
requests for that agent, assignment, SDK session, and worktree. It does not
check shell commands for safety: a shell has **full host-account reach**.
Other, unknown, or mismatched requests still need review. Turn it off during
the turn if needed (already-running commands cannot be undone). Consent ends
on worktree change, revocation, stop, archive, fire, new assignment, last
browser disconnect, or restart; it is **not persisted**. Neither Git
worktrees nor this consent enable a verified OS sandbox.

## Data and privacy

The default Copilot profile sends prompts to GitHub Copilot; BYOM sends
prompts, context, and tool content to the endpoint **you** configure. There
is **no in-app OAuth**. Optional Brave web search sends **each query** to
Brave without an individual search prompt, and the query joins SDK tool-call
history; leave it disabled if that is not acceptable. Private repo lookup
may use your separate `gh` login. Do not paste secrets into prompts, notes,
model-profile fields, or tracked files. Readable repo files may themselves
contain sensitive information.

Meetings only forward excerpts you explicitly supply for each turn; prior
replies and complete transcripts are not automatically forwarded. However,
the participants' existing sessions retain previously seen private context.
**A meeting is a human-approved handoff, not an isolated clean room.**

## State, backups, and recovery

By default, the versioned JSON room state is in **`.local/state.json`**
(override with `--state`). It records agents, personas, assignments, grants,
meetings, progression, worktree metadata, and nonsecret model profiles.
Scratch work lives under the chosen `--workspace`, clones under
`.local/repos/`, and edit worktrees under `.local/worktrees/`; the SDK also
stores history under your Copilot home. These locations are not automatically
deleted by archive, fire, or revoke. Back them up together before moving
installations or changing workspace paths; don't commit them.

The schema is **version 6**. A migration from unversioned state or v2–v5
keeps a non-overwritten versioned backup alongside the state file
(`.v1.bak` through `.v5.bak`). Unknown versions and invalid ledgers are
refused. To roll back: stop the server, copy newer state somewhere safe,
restore the matching backup to the state path, and run the older release.
Later edits cannot be backported automatically. Never run two servers on
the same state file. Resume with the **same workspace**; an interrupted turn
is marked, and a failed SDK resume keeps its transcript visible rather than
silently replacing it. New assignments intentionally start fresh without
inheriting task/session/edit grants.

For exact limits, migration behavior, and provenance, see the
[technical reference](technical-reference.md#safety-and-recovery).
