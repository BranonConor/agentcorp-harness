import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { Disclosure, SelectField, Toggle } from "../agent-inc-live/src/controls.js";

test("select retains its controlled value, accessible name and form input", () => {
  const markup = renderToStaticMarkup(<SelectField label="Maximum approved turns" value={2}
    name="turns" required options={[{ value: 1, label: "One" }, { value: 2, label: "Two" }]}
    onValueChange={() => {}} />);
  assert.match(markup, /role="combobox"[^>]*aria-required="true"[^>]*aria-label="Maximum approved turns"/);
  assert.match(markup, /<span>Two<\/span>/);
  assert.match(markup, /name="turns" value="2"/);
});

test("select read-only and disabled states expose the corresponding semantics", () => {
  const props = { label: "Format", value: "meeting", options: [{ value: "meeting", label: "Meeting" }],
    onValueChange: () => {} };
  const readOnly = renderToStaticMarkup(<SelectField {...props} readOnly />);
  const disabled = renderToStaticMarkup(<SelectField {...props} disabled />);
  assert.match(readOnly, /aria-readonly="true"/);
  assert.match(disabled, /role="combobox"[^>]*aria-expanded="false"/);
  assert.match(disabled, /<button[^>]*disabled=""/);
});

test("switch and disclosure expose controlled state and native form value", () => {
  const markup = renderToStaticMarkup(<>
    <Toggle label="Global read" checked name="read" onCheckedChange={() => {}} />
    <Disclosure.Root defaultOpen>
      <Disclosure.Trigger>More options</Disclosure.Trigger>
      <Disclosure.Panel className="ui-disclosure-panel">Details</Disclosure.Panel>
    </Disclosure.Root>
  </>);
  assert.match(markup, /role="switch"[^>]*aria-checked="true"[^>]*aria-label="Global read"/);
  assert.match(markup, /type="checkbox"[^>]*name="read" checked=""/);
  assert.match(markup, /aria-controls="[^"]+" aria-expanded="true"/);
  assert.match(markup, /data-open=""[^>]*class="ui-disclosure-panel">Details/);
});

const chrome = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : chromium.executablePath();

test("keyboard selection, switch state, disclosure, portal and reduced motion", {
  skip: !existsSync(chrome) && "A local Chromium installation is required for browser interaction",
}, async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, {useState} from "react";
        import {createRoot} from "react-dom/client";
        import {SelectField, Toggle, Disclosure} from "./agent-inc-live/src/controls.tsx";
        function Fixture() {
          const [value, setValue] = useState("meeting");
          const [checked, setChecked] = useState(false);
          const [turns, setTurns] = useState(2);
          const [repository, setRepository] = useState("");
          return <form>
            <SelectField label="Format" name="format" value={value} onValueChange={setValue}
              options={[{value:"meeting",label:"Meeting"},{value:"review",label:"Review"}]} />
            <SelectField label="Maximum turns" name="turns" value={turns}
              onValueChange={next => { window.selectedTurnType = typeof next; setTurns(next); }}
              options={[{value:1,label:"One"},{value:2,label:"Two"}]} />
            <SelectField label="Repository" name="repository" value={repository} required
              onValueChange={setRepository}
              options={[{value:"",label:"Select a repository"},{value:"owner/repo",label:"owner/repo"}]} />
            <SelectField label="Read only" value="fixed" readOnly onValueChange={() => {}}
              options={[{value:"fixed",label:"Fixed"},{value:"other",label:"Other"}]} />
            <SelectField label="Unavailable" value="fixed" disabled onValueChange={() => {}}
              options={[{value:"fixed",label:"Fixed"}]} />
            <Toggle label="Global read" name="shared" checked={checked} onCheckedChange={setChecked} />
            <Disclosure.Root><Disclosure.Trigger>More options</Disclosure.Trigger>
              <Disclosure.Panel className="ui-disclosure-panel">Extra settings</Disclosure.Panel>
            </Disclosure.Root>
          </form>;
        }
        createRoot(document.getElementById("fixture")).render(<Fixture />);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="live-shell"><div id="fixture"></div></div>');
    await page.addStyleTag({ content: readFileSync("agent-inc-live/live.css", "utf8") +
      readFileSync("agent-inc-live/controls.css", "utf8") });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const select = page.getByRole("combobox", { name: "Format" });
    await select.focus();
    await select.press("ArrowDown");
    assert.equal(await page.getByRole("option", { name: "Review" }).count(), 1);
    assert.equal(await page.locator(".live-shell .ui-select-popup").count(), 1);
    await page.getByRole("option", { name: "Review" }).click();
    assert.equal(await page.locator('input[name="format"]').inputValue(), "review");
    await select.focus();
    await select.press("ArrowDown");
    await page.getByRole("option", { name: "Review", selected: true }).waitFor({ state: "visible" });
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator('input[name="format"]').inputValue(), "meeting");
    await page.getByRole("combobox", { name: "Maximum turns" }).click();
    await page.getByRole("option", { name: "One" }).click();
    assert.equal(await page.locator('input[name="turns"]').inputValue(), "1");
    assert.equal(await page.evaluate(() => (window as Window & { selectedTurnType?: string }).selectedTurnType), "number");
    assert.equal(await page.locator("form").evaluate(node => (node as HTMLFormElement).checkValidity()), false);
    await page.getByRole("combobox", { name: "Repository" }).click();
    await page.getByRole("option", { name: "owner/repo" }).click();
    assert.equal(await page.locator("form").evaluate(node => (node as HTMLFormElement).checkValidity()), true);
    await page.getByRole("combobox", { name: "Read only" }).click();
    await page.getByRole("option", { name: "Other" }).click({ force: true });
    assert.equal(await page.getByRole("combobox", { name: "Read only" }).getAttribute("aria-readonly"), "true");
    assert.match(await page.getByRole("combobox", { name: "Read only" }).textContent() ?? "", /Fixed/);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("combobox", { name: "Unavailable" }).isDisabled(), true);
    await page.getByRole("switch", { name: "Global read" }).focus();
    await page.keyboard.press("Space");
    assert.equal(await page.getByRole("switch", { name: "Global read" }).getAttribute("aria-checked"), "true");
    const disclosure = page.getByRole("button", { name: "More options" });
    await disclosure.focus();
    await page.keyboard.press("Enter");
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
    assert.equal(await page.getByText("Extra settings").count(), 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await disclosure.locator(".ui-disclosure-chevron").evaluate(node =>
      getComputedStyle(node).transitionDuration), "0s");
    await page.setViewportSize({ width: 320, height: 520 });
    await select.click();
    const popup = await page.locator(".ui-select-popup[data-open]").boundingBox();
    assert.ok(popup && popup.x >= 0 && popup.x + popup.width <= 320);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.documentElement.setAttribute("data-office-theme", "dark"));
    assert.equal(await select.evaluate(node => getComputedStyle(node).color), "rgb(241, 232, 214)");
  } finally {
    await browser.close();
  }
});
