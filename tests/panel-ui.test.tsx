import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { UPGRADES } from "../server/progression.js";

const chrome = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : chromium.executablePath();

async function checkDeskChooser() {
    const bundle = await build({
      entryPoints: ["agent-inc-live/src/office.tsx"], bundle: true, write: false,
      platform: "browser", format: "iife", loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const now = Date.now();
    const agent = (id: string, deskIndex: number | null, archived = false) => ({
      id, personaId: id, assignmentId: id, sessionId: id, deskIndex, lastDeskIndex: archived ? 2 : undefined,
      archived, workspace: "/tmp/fixture", workspaceKind: "scratch",
      createdAt: now, updatedAt: now, idleSince: now, phase: "idle", activity: "Ready", messages: [],
    });
    const fixture = {
      schemaVersion: 6, revision: 1, workspace: "/tmp/fixture", connected: true, error: null,
      agents: [agent("a", 0), agent("b", 1), agent("c", null, true)],
      personas: ["a", "b", "c"].map((id, index) => ({
        id, name: ["Avery", "Blair", "Casey"][index], artId: index, createdAt: now, updatedAt: now,
        setupCompleted: true, profile: { instructions: "", workingStyle: "", specialties: [],
          title: "", rank: "" }, memories: [],
      })),
      assignments: [], progression: [], projects: [], meetings: [], worktrees: [],
    };
    const requests: string[] = [];
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript({ content: `window.EventSource = class {
        onmessage = null; addEventListener() {} close() {}
      };` });
      await page.route("http://office.test/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/") return route.fulfill({
          contentType: "text/html", body: '<link rel="icon" href="data:,"><div id="root"></div><script src="/office.js"></script>',
        });
        if (path === "/office.js") return route.fulfill({
          contentType: "text/javascript", body: bundle.outputFiles[0].text,
        });
        if (path === "/api/state") return route.fulfill({ json: fixture });
        if (path === "/api/search-capability") return route.fulfill({
          json: { available: false, reason: "Search off" },
        });
        const body = route.request().postDataJSON() as { agentId: string; deskIndex: number; expectedDeskIndex: number;
          expectedOccupantId: string | null };
        requests.push(`${path}:${JSON.stringify(body)}`);
        if (path === "/api/move-desk") {
          const moving = fixture.agents.find(item => item.id === body.agentId)!;
          assert.equal(moving.deskIndex, body.expectedDeskIndex);
          const occupied = fixture.agents.find(item => !item.archived && item.deskIndex === body.deskIndex);
          assert.equal(occupied?.id ?? null, body.expectedOccupantId);
          if (occupied) occupied.deskIndex = moving.deskIndex;
          moving.deskIndex = body.deskIndex;
        } else if (path === "/api/restore") {
          const restoring = fixture.agents.find(item => item.id === body.agentId)!;
          assert.equal(fixture.agents.some(item => !item.archived && item.deskIndex === body.deskIndex), false);
          restoring.deskIndex = body.deskIndex;
          restoring.archived = false;
        } else if (path === "/api/create") {
          fixture.agents.push(agent("d", body.deskIndex));
          fixture.personas.push({ ...fixture.personas[0], id: "d", name: "Drew", artId: 3 });
        } else return route.fulfill({ status: 404, body: path });
        fixture.revision++;
        return route.fulfill({ json: fixture });
      });
      await page.goto("http://office.test/");
      await page.addStyleTag({ content: ["agent-inc/app/styles.css", "agent-inc-live/live.css",
        "agent-inc-live/sdk-chat.css", "agent-inc-live/overview.css", "agent-inc-live/controls.css"]
        .map(file => readFileSync(file, "utf8")).join("\n") });
      await page.waitForTimeout(300);
      assert.ok(await page.getByRole("button", { name: /Manage agents/ }).count(),
        `Office failed to render: ${errors.join("; ")}; ${await page.locator("body").innerHTML()}`);
      await page.getByRole("button", { name: /Manage agents/ }).click();
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: "Actions for Avery" }).click();
      await page.getByRole("menuitem", { name: "Move desk…" }).click();
      const chooser = page.getByRole("dialog", { name: "Move Avery" });
      await chooser.waitFor();
      assert.ok(await chooser.evaluate(element => element.getBoundingClientRect().right <= innerWidth &&
        element.getBoundingClientRect().left >= 0), "Desk chooser fits the mobile viewport");
      assert.equal(await chooser.getByRole("button", { name: "Desk 1: current desk" }).isDisabled(), true);
      await page.keyboard.press("Escape");
      await chooser.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Actions for Avery");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Actions for Avery");
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move desk…" }).click();
      await chooser.getByRole("button", { name: "Desk 2: occupied by Blair" }).focus();
      await page.keyboard.press("Enter");
      await chooser.getByRole("button", { name: "Cancel swap" }).click();
      assert.equal(requests.length, 0);
      await chooser.getByRole("button", { name: "Desk 2: occupied by Blair" }).focus();
      await page.keyboard.press("Enter");
      await chooser.getByRole("button", { name: "Confirm swap" }).focus();
      await page.keyboard.press("Enter");
      await chooser.waitFor({ state: "hidden" });
      assert.equal(fixture.agents[0].deskIndex, 1);
      assert.equal(fixture.agents[1].deskIndex, 0);
      await page.getByRole("button", { name: "Actions for Casey" }).click();
      await page.getByRole("menuitem", { name: "Restore to office…" }).click();
      const restoring = page.getByRole("dialog", { name: "Restore Casey" });
      await restoring.getByRole("button", { name: "Desk 3: empty, former desk" }).click();
      await restoring.waitFor({ state: "hidden" });
      assert.equal(fixture.agents[2].deskIndex, 2);
      await page.getByRole("button", { name: "Close Manage" }).click();
      await page.getByRole("button", { name: "Add agent: choose a desk" }).click();
      const creating = page.getByRole("dialog", { name: "Choose a desk for the new agent" });
      await creating.getByRole("button", { name: "Desk 4: empty" }).click();
      await creating.waitFor({ state: "hidden" });
      assert.equal(fixture.agents[3].deskIndex, 3);
      assert.deepEqual(requests.map(item => item.split(":")[0]), ["/api/move-desk", "/api/restore", "/api/create"]);
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
}

test("mobile keyboard desk chooser selects seats, confirms swaps, and restores explicitly", {
  skip: !existsSync(chrome) && "A local Chromium installation is required",
}, checkDeskChooser);

test("Store drilldown, purchase, agent portraits and overlay copy remain usable", {
  skip: !existsSync(chrome) && "A local Chromium installation is required",
}, async () => {
  const bundle = await build({
    entryPoints: ["agent-inc-live/src/office.tsx"],
    bundle: true, write: false, platform: "browser", format: "iife",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const now = Date.now() - 100_000;
  const messages = [
    { id: "agent-1", role: "assistant", content: "Hello from the agent." },
    { id: "user-1", role: "user", content: "Please check the office." },
    { id: "agent-2", role: "assistant", content: Array(18).fill("The office is ready. All clear.").join("\n\n") },
    { id: "system-1", role: "system", content: "Office event recorded." },
  ];
  const assignment = (id: string, time: number) => ({
    id, personaId: "persona-1", sessionId: `session-${id}`, workspace: "/tmp/fixture",
    startedAt: time - 1000, endedAt: time - 500, status: "completed",
    messages: [{ id: `u-${id}`, role: "user", content: "Do a task" },
      { id: `a-${id}`, role: "assistant", content: "Task complete" }],
  });
  const assignments = [assignment("old-1", now), assignment("old-2", now + 1000)];
  const room = {
    revision: 1, workspace: "/tmp/fixture", connected: true, error: null,
    agents: [{
      id: "agent-1", personaId: "persona-1", sessionId: "session-1", deskIndex: 0,
      archived: false, workspace: "/tmp/fixture", workspaceKind: "scratch",
      createdAt: now, updatedAt: now + 2000, phase: "idle", activity: "Available", messages,
    }],
    personas: [{
      id: "persona-1", name: "Avery", artId: 2, createdAt: now, updatedAt: now,
      setupCompleted: true, profile: { instructions: "", workingStyle: "",
        specialties: [], title: "Engineer", rank: "Associate" }, memories: [],
    }, {
      id: "retired-1", name: "Morgan", artId: 3, createdAt: now, updatedAt: now,
      setupCompleted: true, profile: { instructions: "", workingStyle: "",
        specialties: [], title: "Researcher", rank: "Associate" }, memories: [],
    }],
    assignments, progression: assignments.map((item, index) => ({
      id: `assignment:${item.id}:`, kind: "reward", source: "assignment", sourceId: item.id,
      personaId: "persona-1", evidence: "Confirmed completed task", specialty: "Engineering",
      xp: 20, credits: 8, at: now + index * 1000,
    })),
    projects: [{
      repository: { fullName: "owner/repo", url: "https://github.com/owner/repo.git",
        defaultBranch: "main", privacy: "public", sizeKiB: 20 },
      sharedRead: true, sharedWrite: true,
    }], meetings: [], worktrees: [],
  };
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    for (const width of [390, 320, 900]) {
      const fixture = structuredClone(room);
      const context = await browser.newContext({ viewport: { width, height: 740 }, colorScheme: "light" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript({ content: `
        Object.defineProperty(navigator, "clipboard", { value: {
          writeText: async text => { window.copiedMarkdown = text; }
        } });
        window.EventSource = class {
          onmessage = null;
          addEventListener() {}
          close() {}
        };
      ` });
      await page.route("http://office.test/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/") return route.fulfill({
          contentType: "text/html", body: '<link rel="icon" href="data:,"><div id="root"></div><script src="/office.js"></script>',
        });
        if (path === "/office.js") return route.fulfill({
          contentType: "text/javascript", body: bundle.outputFiles[0].text,
        });
        if (path === "/api/state") return route.fulfill({ json: fixture });
        if (path === "/api/search-capability") return route.fulfill({
          json: { available: false, reason: "Search unavailable in fixture" },
        });
        if (path === "/api/upgrade-purchase") {
          const request = route.request().postDataJSON() as { upgradeId: string; confirmed: boolean };
          assert.equal(request.confirmed, true);
          assert.equal(request.upgradeId, "garden");
          fixture.progression.push({
            id: "purchase:garden", kind: "purchase", upgradeId: "garden", credits: -12, at: Date.now(),
          } as (typeof room.progression)[number]);
          fixture.revision++;
          return route.fulfill({ json: fixture });
        }
        return route.fulfill({ status: 404, body: path });
      });
      await page.goto("http://office.test/");
      await page.addStyleTag({ content: ["agent-inc/app/styles.css", "agent-inc-live/live.css",
        "agent-inc-live/sdk-chat.css", "agent-inc-live/overview.css", "agent-inc-live/controls.css"]
        .map(file => readFileSync(file, "utf8")).join("\n") });
      await page.waitForTimeout(300);
      assert.ok(await page.locator(".system-toggle").count(),
        `Office did not render: ${errors.join("; ")}; ${await page.locator("body").innerHTML()}`);
      await page.getByRole("button", { name: /Manage agents/ }).click();
      assert.equal(await page.locator(".sidebar.activity-panel").evaluate(element =>
        getComputedStyle(element).getPropertyValue("--panel-inline").trim()), width > 700 ? "22px" : "16px");
      const overview = page.getByRole("region", { name: "Office overview" });
      await overview.waitFor();
      assert.equal(await overview.getByText("Your office", { exact: true }).count(), 0);
      assert.equal(await overview.getByText("The office", { exact: true }).count(), 0);
      assert.equal(await overview.getByText("Connection", { exact: true }).count(), 0);
      assert.equal(await overview.getByText("SDK-reported usage, not cost, XP or credits.", { exact: false }).count(), 0);
      assert.equal(await overview.getByRole("button", { name: "Preview & buy" }).count(), 0);
      assert.equal(await overview.locator(".overview-metrics strong").first().textContent(), "1");
      await overview.getByRole("button", { name: "Open Store" }).click();
      const store = page.getByRole("region", { name: "Office Store" });
      await store.waitFor();
      assert.equal(await page.getByRole("navigation", { name: "Manage views" }).count(), 0);
      assert.equal(await store.getByRole("button", { name: /Preview & buy/ }).count(), UPGRADES.length);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Back to Overview");
      await page.keyboard.press("Escape");
      await overview.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open Store →");
      await overview.getByRole("button", { name: "Open Store" }).click();
      page.once("dialog", dialog => dialog.accept());
      await store.getByRole("button", { name: /Preview & buy · 12/ }).click();
      await store.getByText("Installed", { exact: true }).waitFor();
      assert.match(await store.textContent() ?? "", /4 credits/);
      await page.getByRole("button", { name: "Back to Overview" }).click();
      assert.match(await overview.textContent() ?? "", /1 installed/);
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      assert.equal(await page.getByText("Retired agents", { exact: true }).count(), 1);
      const rowInset = await page.locator(".agent-row-main .worker-avatar").first()
        .evaluate(element => element.getBoundingClientRect().left);
      const retiredInset = await page.locator(".former-persona .ui-disclosure-trigger img").first()
        .evaluate(element => element.getBoundingClientRect().left);
      assert.ok(Math.abs(rowInset - retiredInset) < 1, `Retired row inset ${retiredInset} differs from ${rowInset}`);
      await page.getByRole("button", { name: /Open Avery conversation/ }).click();
      const conversation = page.getByRole("region", { name: "SDK conversation" });
      await conversation.waitFor();
      await page.locator(".conversation-scroll").evaluate(element => { element.scrollTop = 0; });
      assert.ok(await page.locator(".conversation-scroll").evaluate(element => element.scrollHeight > element.clientHeight));
      assert.equal(await conversation.locator(".persona-details").count(), 0);
      assert.equal(await conversation.locator(".assignment-history").count(), 0);
      assert.equal(await conversation.locator(".conversation-messages .conversation-message").count(), messages.length);
      const editButton = page.getByRole("button", { name: "Edit agent" });
      assert.equal(await editButton.getAttribute("title"), "Edit agent");
      assert.equal(await editButton.locator("svg").count(), 1);
      assert.equal((await editButton.textContent())?.trim(), "");
      const menu = page.getByRole("button", { name: "Options for Avery" });
      await page.locator(".conversation-scroll").evaluate(element => { element.scrollTop = 70; });
      await menu.click();
      await page.getByRole("button", { name: "Agent settings & more options" }).click();
      const settings = page.getByRole("region", { name: "Avery settings" });
      await settings.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Back to conversation");
      assert.equal(await conversation.count(), 0);
      assert.equal(await settings.getByText("Engineer", { exact: false }).count() > 0, true);
      const more = settings.getByRole("button", { name: "More options · notes, career, projects & assignments" });
      await more.click();
      assert.equal(await settings.getByText("Curated notes", { exact: true }).count(), 1);
      assert.equal(await settings.getByText("Assign projects", { exact: true }).count(), 1);
      assert.equal(await settings.getByText("Assignment history", { exact: true }).count(), 1);
      assert.equal(await settings.getByRole("button", { name: "New assignment" }).count(), 1);
      assert.equal(await settings.getByRole("button", { name: "Review Edit worktree for this task" }).count(), 1);
      assert.ok(await settings.evaluate(element => element.scrollWidth <= element.clientWidth));
      if (process.env.OFFICE_SCREENSHOT_DIR && width <= 390) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${process.env.OFFICE_SCREENSHOT_DIR}/agent-settings-more-${width}.png` });
      }
      await page.keyboard.press("Escape");
      await conversation.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Options for Avery");
      assert.equal(await page.locator(".conversation-scroll").evaluate(element => element.scrollTop), 70);
      await menu.click();
      assert.equal(await page.getByRole("button", { name: "Find a GitHub repository" }).count(), 1);
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Options for Avery");
      await editButton.click();
      const editView = page.getByRole("region", { name: "Avery profile setup" });
      await editView.waitFor();
      assert.equal(await page.getByRole("button", { name: "Back to conversation" }).count(), 1);
      assert.equal(await editView.getByRole("button", { name: "Save profile" }).count(), 1);
      await page.getByRole("button", { name: "Back to conversation" }).click();
      await conversation.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Edit agent");
      assert.equal(await page.locator(".conversation-scroll").evaluate(element => element.scrollTop), 70);
      if (process.env.OFFICE_SCREENSHOT_DIR && width <= 390) {
        await page.locator(".conversation-scroll").evaluate(element => { element.scrollTop = 0; });
        await page.screenshot({ path: `${process.env.OFFICE_SCREENSHOT_DIR}/chat-top-${width}.png` });
        await menu.click();
        await page.getByRole("button", { name: "Agent settings & more options" }).click();
        await page.screenshot({ path: `${process.env.OFFICE_SCREENSHOT_DIR}/agent-settings-${width}.png` });
        await page.getByRole("button", { name: "Back to conversation" }).click();
      }
      assert.equal(await conversation.locator(".conversation-message.assistant > .message-avatar").count(), 2);
      assert.equal(await conversation.locator(".conversation-message.user > .message-avatar").count(), 0);
      assert.equal(await conversation.locator(".conversation-message.system > .message-avatar").count(), 0);
      const portraits = await conversation.locator(".conversation-message.assistant > .message-avatar")
        .evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).src));
      assert.ok(portraits.every(portrait => portrait === portraits[0]));
      const bubble = conversation.locator(".conversation-message.assistant .message-bubble").first();
      const copy = bubble.getByRole("button", { name: "Copy assistant message as Markdown" });
      const beforeCopy = await bubble.boundingBox();
      await copy.click({ force: true });
      await page.waitForTimeout(100);
      assert.ok(await page.evaluate(() => (window as Window & { copiedMarkdown?: string }).copiedMarkdown),
        `Clipboard callback failed: ${errors.join("; ")}; ${await page.locator(".storage-error").allTextContents()}; ${await page.evaluate(() => typeof navigator.clipboard)}`);
      assert.equal(await page.evaluate(() => (window as Window & { copiedMarkdown?: string }).copiedMarkdown), messages[0].content);
      assert.equal(await bubble.getByRole("button", { name: "Copied assistant message as Markdown" }).count(), 1);
      const geometry = await bubble.evaluate(element => {
        const button = element.querySelector<HTMLElement>(".copy-message")!;
        const text = element.querySelector<HTMLElement>(".message-markdown")!;
        const bounds = element.getBoundingClientRect();
        const control = button.getBoundingClientRect();
        return { position: getComputedStyle(button).position, bubbleLeft: bounds.left, bubbleRight: bounds.right,
          left: control.left, right: control.right, width: text.clientWidth,
          padding: parseFloat(getComputedStyle(text).paddingRight) };
      });
      assert.equal(geometry.position, "absolute");
      assert.ok(geometry.left >= geometry.bubbleLeft && geometry.right <= geometry.bubbleRight);
      assert.ok(geometry.padding >= 40);
      const afterCopy = await bubble.boundingBox();
      assert.equal(afterCopy?.x, beforeCopy?.x);
      assert.equal(afterCopy?.width, beforeCopy?.width);
      const userBubble = conversation.locator(".conversation-message.user .message-bubble");
      await userBubble.getByRole("button", { name: "Copy user message as Markdown" }).click({ force: true });
      assert.equal(await page.evaluate(() => (window as Window & { copiedMarkdown?: string }).copiedMarkdown), messages[1].content);
      assert.ok(await userBubble.evaluate(element => {
        const button = element.querySelector(".copy-message")!.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return button.left >= bounds.left && button.right <= bounds.right;
      }));
      const systemBubble = conversation.locator(".conversation-message.system .message-bubble");
      await systemBubble.getByRole("button", { name: "Copy system message as Markdown" }).click({ force: true });
      assert.equal(await page.evaluate(() => (window as Window & { copiedMarkdown?: string }).copiedMarkdown), messages[3].content);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      const screenshotDir = process.env.OFFICE_SCREENSHOT_DIR;
      await page.getByRole("button", { name: "Back to agents" }).click();
      await page.getByRole("button", { name: "Overview" }).click();
      if (screenshotDir && width <= 390) {
        await page.screenshot({ path: `${screenshotDir}/overview-${width}.png` });
      }
      await overview.getByRole("button", { name: "Open Store" }).click();
      if (screenshotDir && width <= 390) {
        await page.screenshot({ path: `${screenshotDir}/store-${width}.png` });
      }
      await page.getByRole("button", { name: "Close Manage" }).click();
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await page.getByRole("button", { name: /Manage agents/ }).click();
      await overview.getByRole("button", { name: "Open Store" }).click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.officeTheme), "dark");
      assert.equal(await page.locator(".sidebar.activity-panel").evaluate(element =>
        getComputedStyle(element).transitionDuration), "0s");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshotDir && width <= 390) await page.screenshot({ path: `${screenshotDir}/store-dark-${width}.png` });
      await page.getByRole("button", { name: "Back to Overview" }).click();
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: /Open Avery conversation/ }).click();
      await page.locator(".conversation-scroll").evaluate(element => { element.scrollTop = 0; });
      if (screenshotDir && width <= 390) await page.screenshot({ path: `${screenshotDir}/chat-top-dark-${width}.png` });
      await page.getByRole("button", { name: "Options for Avery" }).click();
      await page.getByRole("button", { name: "Agent settings & more options" }).click();
      assert.equal(await page.getByRole("region", { name: "Avery settings" }).count(), 1);
      await page.getByRole("region", { name: "Avery settings" }).getByRole("button", { name: "Move desk…" }).click();
      await page.getByRole("dialog", { name: "Move Avery" }).getByRole("button", { name: "Cancel" }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshotDir && width <= 390) await page.screenshot({ path: `${screenshotDir}/agent-settings-dark-${width}.png` });
      Object.assign(fixture.agents[0], { review: {
        id: "review-1", kind: "shell", detail: "echo safe", tool: "shell",
      } });
      fixture.revision++;
      await page.reload();
      await page.getByRole("alertdialog", { name: "Tool permission request for Avery" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Deny" }).count(), 1);
      assert.equal(await page.getByRole("region", { name: "SDK conversation" }).count(), 1);
      delete (fixture.agents[0] as typeof fixture.agents[number] & { review?: unknown }).review;
      Object.assign(fixture.agents[0], { accessRequest: {
        id: "access-1", repoHint: "owner/repo", purpose: "Read source", scope: "read",
        status: "review", candidates: [],
      } });
      fixture.revision++;
      await page.reload();
      await page.getByRole("group", { name: "Repository access request from Avery" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Deny" }).count(), 1);
      assert.equal(await page.getByRole("region", { name: "SDK conversation" }).count(), 1);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
