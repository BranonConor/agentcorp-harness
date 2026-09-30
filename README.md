# AgentCorp SDK office

A local, single-user spatial Copilot SDK prototype using the **actual AgentCorp 3D office**: its original room geometry, procedural pixel art, shaders, lighting/day cycle, desks, camera controls, activity chrome, and sprite movement. Click empty office space to create an agent, click its pixel sprite to focus the camera and open an interactive chat, and send a prompt to a **new** GitHub Copilot SDK session. SDK events drive speech, working, idle, and permission states. This does not attach to existing Copilot app sessions.

## Install and run

Requires Node.js 22.12+ (or 20.19+), npm, a WebGL-capable browser, and an authenticated GitHub Copilot CLI account. Follow the [official Copilot SDK setup guide](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md) for CLI installation, then run `copilot login` if necessary; the app uses that sign-in and never collects credentials.

```sh
npm install
npm run dev -- --workspace ./sandbox
```

`./sandbox` is the explicitly selected, dedicated tool working directory. It must be initially empty; the backend creates and marks it on first use. You can pass a different new absolute path with `--workspace`; if you choose another directory *inside this repository*, add it to your local Git exclude file so tool output is not committed. **Do not choose a home directory or an existing work repository.** Start the browser at the printed URL, normally **http://127.0.0.1:4173**. The browser must be on the same machine. `npm run dev` rebuilds the frontend; restart it after UI changes. `npm start -- --workspace ./sandbox` serves the already-built frontend. Set `--port 4173` to change the port; `--state .local/other-state.json` allows an isolated test room.

In the office, **click empty floor or a desk** to invite one agent, then **click the pixel agent** to focus the camera and open the conversation. Send a prompt with Enter (Shift+Enter inserts a newline); the reply streams into the chat while the sprite reflects real thinking/tool activity. When a tool asks permission, inspect its full path or command and choose **Allow once** or **Deny**. Reload the browser or restart the backend with the same `--workspace` to recover the conversation. Keep the browser open while awaiting a permission decision.

Use `npm run typecheck`, `npm test`, and `npm run build` to validate the app.

## Safety and recovery

HTTP is bound to `127.0.0.1` with loopback host, same-origin write, and local browser-cookie checks; do not expose it through a proxy. Every SDK permission request—including reads, commands, writes, and unknown tool kinds—requires **Allow once** or **Deny** in the panel. No approvals are automatic or persisted. Outstanding requests are denied when the last browser leaves or after 90 seconds. The chosen working directory and an instruction to the model are **not OS isolation**: a permitted tool can reach outside it, so read paths and commands before allowing. Stronger containment requires a sandbox/container.

The UI transcript and session ID persist in ignored `.local/state.json`, and the SDK also stores session history under the signed-in user's Copilot home. Prompts go to the GitHub Copilot service under that account; there is no BYOK, private app RPC, terminal scraping, hosted backend, or analytics added by this app. A backend restart resumes the **same** SDK session; an interrupted turn is labeled interrupted, and a failed resume leaves the transcript visible with Retry connection rather than silently replacing it. The SDK may not persist an *empty, never-messaged* session; if it reports that exact session missing, the app reinitializes only that empty session under the same ID and says so in the UI. A session containing any messages is never silently replaced. The first slice supports **one agent/session**, a local browser, and an explicitly selected working directory; it does not manage existing Copilot app sessions, host a network service, coordinate multiple agents, or offer account switching.

## Original scene provenance

With the repository owner's explicit permission, the scene was ported from [BranonConor/agentcorp](https://github.com/BranonConor/agentcorp) at commit `724d9031530c81618bf32007fbaa17ac412af7a2`. The copied `agent-inc/game/{animation,lighting,live-layout,simulation,sprite-art,world}.ts`, `agent-inc/app/styles.css`, `agent-inc-live/src/office.tsx`, `agent-inc-live/src/room.ts`, and `agent-inc-live/live.css` originate there. The simulation, art, lighting, layout, room projection, and original styles are reused; `world.ts` adds empty-space selection and `office.tsx` replaces the read-only extension feed with this app's SDK backend and chat. `agent-inc-live/sdk-chat.css` contains the additional conversation/permission UI styling. The original browser extension (`.github/extensions/agent-inc-live`) and its session-activity data source are **not** installed or copied into this app, and its original token/usage metrics are intentionally omitted because this SDK slice does not provide them. The room remains the original renderer, not an approximation.

## License and public-release caveat

The code and procedural office art that BranonConor owns are offered under the [MIT License](LICENSE) in this repository. This includes the adapted AgentCorp source copied with the owner's explicit authorization; the upstream repository itself did not have a repository-wide license at the source commit above. **No employer or other ownership clearance has been independently verified**; the owner should resolve any obligations that may apply before distribution. There are no copied image, font, audio, or model files, and the scene art is generated in source rather than fetched from another asset pack.

Third-party runtime dependencies remain under **their own MIT licenses**, not this project's copyright: React 19.3.0, React DOM 19.3.0, scheduler 0.28.0, and three.js 0.180.0. Their full original text is preserved in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), whose header names the upstream extension's bundle; the same versions are used here. The separate GitHub Copilot SDK and its bundled CLI runtime are installed by npm rather than vendored into this source tree; consult their package notices and applicable GitHub terms. No non-MIT third-party art/assets are included in this repository.
