# HappyMachines

<img src="public/favicon.svg" alt="HappyMachines pixel mark" width="64" height="64">

**A little 3D office for your local AI helpers.** Give each agent a desk, a
conversation, and a job; you stay in charge of what it can read or change.
HappyMachines runs on your machine with independent GitHub Copilot SDK sessions,
in the original [AgentCorp](https://github.com/BranonConor/agentcorp) office.
It does not connect to agents already running in the Copilot app or CLI.

### Take a look around

| In the office | What you can do |
| --- | --- |
| **Desks & chats** | Hire up to 16 agents, choose their home desks, move or swap seats, and archive or restore without losing conversations. |
| **Projects & assignments** | Share verified GitHub repos for reading, or explicitly approve a separate edit worktree for one task. Start a fresh assignment without erasing the old one. |
| **Meetings & reviews** | Hand selected agents an agenda and excerpts, approving each turn yourself. Record decisions and follow-ups. |
| **A little progress** | Confirm outcomes or verified merged PRs to earn career XP and office credits; spend credits on decor. |
| **Your choice of model** | Use your Copilot CLI sign-in or configure a BYOM profile (including local Ollama). Optional Brave-powered web search is opt-in. |

## Get the doors open

You'll need **Git, npm, Node.js 22.12+ (or 20.19+), and a WebGL-capable browser**.
For the default Copilot profile, install and sign in to
[Copilot CLI](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md)
(`copilot login` if needed). There is **no in-app OAuth**. BYOM users can instead
set up a model profile after starting the app; BYOM does not require Copilot sign-in.

```sh
git clone https://github.com/BranonConor/happymachines.git
cd happymachines
npm install
npm run dev -- --workspace ./sandbox
```

Open the printed URL (normally **http://127.0.0.1:4173**) on the **same machine**.
`./sandbox` must be empty or previously created by this app. Pick a new,
dedicated scratch directory, not your home directory or an existing checkout.
The default workspace and `.local/` state are gitignored. [Setup and model
profiles](docs/getting-started.md) covers alternate paths, ports, and credentials.

## Your first five minutes

1. Click **+** above an empty desk (or **+ Add agent** in the header).
2. Name your new hire, add a working style or instructions, and choose **Save & start chat**.
3. Ask a small question. Each agent has its own chat and SDK session.
4. To work with code, ask for a GitHub repo. Check the **verified owner/repo**
   and choose a read scope; editing needs a separate **Edit worktree** approval.
5. Try **Manage agents → Meetings** for a turn-by-turn handoff, or
   **Overview → Open Store** after you've confirmed earned rewards.

**Before granting access:** This is a **local, single-user, loopback-only** app,
not a remote service or an OS sandbox. A Git worktree keeps edits separate from
your checkout but **does not confine a shell**. Built-in tool requests need
individual **Allow once / Deny** decisions by default. Optional
**Allow autonomous local work for this task** is explicit, task-scoped consent
for selected built-in tools; an approved shell can still reach anything your
host account can. Choose repositories and model endpoints you trust, and don't
paste secrets into chat. [Read the safety and recovery guide](docs/safety-and-data.md)
before enabling autonomy or sharing sensitive work.

## The handbook

- [Setup, sign-in & model profiles](docs/getting-started.md) — CLI vs BYOM, ports, and optional Brave search.
- [Office & project workflows](docs/office-guide.md) — agents, grants, worktrees, meetings, rewards, and limits.
- [Safety, state & recovery](docs/safety-and-data.md) — permissions, privacy, backups, and the real boundaries.
- [Technical reference](docs/technical-reference.md) — exact behavior, limits, and implementation notes.
- [License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.txt)

The room and procedural art are adapted with the owner's permission from
[BranonConor/agentcorp](https://github.com/BranonConor/agentcorp) at
`724d9031530c81618bf32007fbaa17ac412af7a2`. The original extension is a
separate project, not installed here. The MIT license covers the owner's code
and art; third-party dependencies retain their own licenses. See the
[provenance and public-release caveat](docs/technical-reference.md#original-scene-provenance)
before redistributing.
