# Around the office

[Home](../README.md) · [Getting started](getting-started.md) · [Safety & recovery](safety-and-data.md)

## Desks and conversations

There are **16 desks**. Click **+** over an empty one or the header's
**+ Add agent**, then name the agent and enter a working style or instructions
in **NEW HIRE → Configure this agent**. Choose **Save & start chat**.
Closing setup keeps the agent for later. Click its sprite or open
**Manage agents → Agents** to chat; plain floor clicks don't hire anyone.
Agents work at their desks and visit the lounge after two uninterrupted idle
minutes. Their chat, portrait, and assignment are independent of other agents.

The header's **+ Add agent** opens a 16-desk chooser; **+** above an empty
desk hires there directly. In **Manage agents → Agents**, open an agent's
**⋮ → Move desk…** (or use **Agent settings → Move desk…**) to choose an empty desk or preview and confirm a swap with
the named occupant. A home desk stays assigned through chat, idle breaks,
and reloads; moving or swapping doesn't stop either SDK session or task.
Arrange nearby desks for a visual grouping (it does not grant shared access).
Archiving frees the seat. On restore, choose an empty desk: the former desk is
marked if available, and an occupied former desk is never silently replaced
or reassigned. A full office must free a seat first.

**Edit agent** updates its persona for the *next* assignment, not the current
conversation. **New assignment** makes a fresh SDK session while retaining
the old transcript and worktree. **Archive** frees the desk and pauses the
agent without deleting its history; **Restore** reconnects it when a desk is
free. **Fire permanently…** confirms the SDK-session retention choice but
does **not** clean up scratch files, cloned repos, or worktrees. Permissions
and pending turns must finish before archive or fire.

## Read a project, then maybe edit it

An agent may request a GitHub repository in chat, or you can select
**Find a GitHub repository…** in its chat menu. Inspect the verified
**owner/repo** and select **Read this task**, **Read this session**,
**Read for persona**, or **Read for office**. Deny clones nothing.
Ambiguous matches need your selection; **Wrong repo?** corrects the hint.
Only verified GitHub repositories, not arbitrary local paths, are accepted.
An approved snapshot is a shallow clone of the remote default branch; it
doesn't contain unpushed local changes. The read tool only exposes bounded,
tracked text files, though those files can still contain sensitive data.

To set access ahead of time, use **Manage agents → Overview → Global project
access → Assign projects globally** and **Share read with all agents**.
Global **Eligible for task worktrees** is separate and off by default.
For one agent, use **Agent settings → More options → Assign projects**.
Policies can be revoked or an agent excluded from office sharing.
An edit request still needs your **Review Edit worktree for this task** and
**Edit worktree** approval in chat. The branch is named
`agentcorp/<agent-id>/<uuid>` for historical compatibility and lives in an
ignored worktree under `.local/worktrees/`. You must inspect, merge, and
clean up edits yourself. A worktree is **not a sandbox**.
[Full grant and cache semantics](technical-reference.md#install-and-run).

## Meetings, careers, and the Store

**Manage agents → Meetings** lets you select 2–4 active agents, set an agenda,
and provide an excerpt or diff (required for reviews). Approve each turn
with **Approve next turn**; the cap is 1–8 turns. Only material you explicitly
enter for a turn is forwarded. Repository material requires effective read
access for every participant and never confers tool permission. Meeting turns
deny tool requests. **This is not a clean-room review:** agents keep private
context from earlier work in their own sessions. Finish with a decision
summary and owner tasks, or cancel the handoff.

You can confirm an assignment outcome, a recorded manual review, or an
attributed merged GitHub PR to earn XP and credits; an assignment gets its
outcome *or* PR reward, not both. Merged PRs need authenticated GitHub
verification. Promotions at 40/100/200 XP are cosmetic, not permissions.
**Manage agents → Overview → Open Store** offers decor purchased with earned
credits. SDK usage is shown separately and is **not money or credits**.
[Reward rules and usage details](technical-reference.md#install-and-run).
