# Getting started

[Home](../README.md) · [Office guide](office-guide.md) · [Safety & recovery](safety-and-data.md)

## Prerequisites

Install Git, npm, Node.js **22.12+ or 20.19+**, and use a WebGL-capable browser
on the same computer as the server. HappyMachines is local-only and binds to
`127.0.0.1`; it has no in-app OAuth.

For the default **Copilot account** profile, install Copilot CLI using the
[Copilot SDK setup guide](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md)
and sign in with `copilot login` if needed. A **BYOM** profile uses the bundled
SDK runtime instead, without Copilot sign-in; the endpoint must support the
model's required streaming and tool calls. For private GitHub repositories
and authenticated merged-PR verification, sign in separately with `gh auth login`.

## Run the office

```sh
git clone https://github.com/BranonConor/happymachines.git
cd happymachines
npm install
npm run dev -- --workspace ./sandbox
```

Open the printed loopback URL, normally `http://127.0.0.1:4173`. The selected
workspace must be a **new empty scratch folder** or one this app previously
marked; never choose your home directory, a current work checkout, or your
Copilot home. The example `sandbox/` and the app's `.local/` state are
gitignored. For a different path inside the repo, exclude it locally from Git.

`npm run dev` builds the UI and starts the server (restart after UI edits).
`npm start -- --workspace ./sandbox` serves an already-built UI.
Use `--port 4173` to change the port or `--state .local/other-state.json`
for an isolated state file. Don't run two servers on the same state path.

## Choose a model

Open **Manage agents → Overview → Model provider → Add a model profile or see
provider details**. Add a named Copilot, OpenAI-compatible HTTPS, Anthropic
HTTPS, Azure HTTPS, or local Ollama profile, then select a default for **new
agents**. Ollama's default loopback endpoint is
`http://127.0.0.1:11434/v1` and needs no key by default. Remote endpoints
must use HTTPS, without URL credentials or query parameters.

For other providers, set the API key securely in the **server process
environment** and enter only the **environment variable name** in the form.
Never paste a key into a profile, chat, tracked file, or shell history. Model
IDs, wire deployment/API settings, token limits, and supported capabilities
must match your provider; listing Copilot models requires CLI login. Profiles
are immutable. A changed default affects new agents; use **New assignment**
to choose a different profile for an existing agent. External endpoints receive
the prompt, context, and tool content.

## Optional web search

The office's `search_web` tool is **off by default**. To use it, obtain a
[Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)
key and configure `AGENTCORP_SEARCH_PROVIDER=brave` and
`AGENTCORP_BRAVE_API_KEY` securely in the server environment, then restart.
Both names are historical compatibility settings. There is no automatic
keyless hosted search fallback. Without the configuration the tool is absent;
an unknown provider fails startup explicitly.

**Every agent-initiated query goes to Brave without a separate permission
prompt** and may cost money. Don't put secrets in queries. Results are
snippets and links, not fetched pages or guaranteed facts. The server limits
queries to 200 characters, five results, one request per two seconds, and
50 requests per run. [Details and limits](technical-reference.md#install-and-run).

## If something doesn't connect

- Check the printed URL on the same machine, and check **Manage agents →
  Overview** for an **SDK needs attention** message and retry button when
  disconnected. There is no permanent Overview "Connection" section.
- For Copilot, check CLI installation and `copilot login`; for BYOM, check
  endpoint reachability, credentials, streaming, and tool-call support.
- For private repos, check `gh auth login` and access to that exact repo;
  public repo metadata and clone do not require `gh`.
- If the workspace is refused, choose a fresh empty directory or the exact
  previously marked workspace. For resume errors, see [recovery](safety-and-data.md#state-backups-and-recovery).
