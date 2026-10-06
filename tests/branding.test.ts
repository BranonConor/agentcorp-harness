import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HAPPY_MACHINES_BADGE, HAPPY_MACHINES_DARK_MARK, HAPPY_MACHINES_MARK, HAPPY_MACHINES_WORDMARK, OFFICE_SIGN_TEXT,
  PIXEL_LETTERS, SIGN_HEIGHT, SIGN_WIDTH, drawBrandedSign, happyMachinesFavicon, layoutBrandedSign,
} from "../agent-inc/game/sprite-art.js";

function pixels(width: number, height: number) {
  const data = Array.from({ length: height }, () => Array<string>(width).fill(""));
  let clipped = false;
  let rounded: [number, number, number, number, number] | null = null;
  const ctx = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      if (x < 0 || y < 0 || x + w > width || y + h > height) clipped = true;
      for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
        for (let column = Math.max(0, x); column < Math.min(width, x + w); column++) {
          data[row][column] = String(this.fillStyle);
        }
      }
    },
    beginPath() { rounded = null; },
    roundRect(x: number, y: number, w: number, h: number, radius: number) {
      rounded = [x, y, w, h, radius];
    },
    fill() {
      if (!rounded) throw new Error("Expected rounded badge path.");
      const [x, y, w, h, radius] = rounded;
      for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) {
        const nearestX = Math.max(x + radius, Math.min(column + 0.5, x + w - radius));
        const nearestY = Math.max(y + radius, Math.min(row + 0.5, y + h - radius));
        if ((column + 0.5 - nearestX) ** 2 + (row + 0.5 - nearestY) ** 2 <= radius ** 2) {
          this.fillRect(column, row, 1, 1);
        }
      }
    },
  } as CanvasRenderingContext2D;
  return { ctx, data, isClipped: () => clipped };
}

test("the full HappyMachines HQ sign has covered glyphs and fits inside its texture", () => {
  assert.equal(OFFICE_SIGN_TEXT, "HappyMachines HQ");
  assert.equal(HAPPY_MACHINES_WORDMARK, "HappyMachines");
  const { glyphs, width } = layoutBrandedSign(OFFICE_SIGN_TEXT);
  assert.equal(glyphs.length, OFFICE_SIGN_TEXT.length);
  assert.equal(width, 285);
  assert.ok(80 + width < SIGN_WIDTH - 14);
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -") {
    const rows = PIXEL_LETTERS[letter];
    assert.equal(rows.length, 7, `missing ${letter}`);
    assert.ok(rows.every(row => /^[01]{5}$/.test(row)), `invalid ${letter}`);
    if (letter !== " ") assert.ok(rows.some(row => row.includes("1")), `blank ${letter}`);
  }
  const image = pixels(SIGN_WIDTH, SIGN_HEIGHT);
  drawBrandedSign(image.ctx, OFFICE_SIGN_TEXT);
  assert.equal(image.isClipped(), false);
  for (const [i, letter] of [...OFFICE_SIGN_TEXT.toUpperCase()].entries()) {
    const color = i < 5 ? "#a7ffe6" : "#e3caf7";
    for (const [row, bits] of PIXEL_LETTERS[letter].entries()) {
      for (const [column, bit] of [...bits].entries()) {
        if (bit === "1") assert.equal(image.data[37 + row * 3][80 + i * 18 + column * 3], color,
          `missing ${letter} at glyph ${i}, row ${row}, column ${column}`);
      }
    }
  }
  assert.equal(SIGN_WIDTH / SIGN_HEIGHT, 4);
  assert.ok(image.data[77][365], "right-hand sign trim remains inside the texture");
});

test("future sign text accepts only bounded locally rendered ASCII glyphs", () => {
  assert.equal(layoutBrandedSign("Studio 42").glyphs.length, 9);
  for (const value of ["", "A".repeat(17), " Hi", "Hi ", "Two  Words", "Hello!", "Smile🙂", "<img>"]) {
    assert.throws(() => layoutBrandedSign(value), /Office sign text/);
  }
});

test("inverted rounded badge preserves the same ;D at 16, 24 and 64 CSS pixels", () => {
  assert.deepEqual(HAPPY_MACHINES_BADGE, { light: "#0d202b", dark: "#eee8dc", radius: 3 });
  assert.deepEqual(HAPPY_MACHINES_MARK.map(layer => layer.color), ["#f1e8d6"]);
  assert.deepEqual(HAPPY_MACHINES_DARK_MARK.map(layer => layer.color), ["#28322e"]);
  const css = readFileSync(new URL("../agent-inc-live/live.css", import.meta.url), "utf8");
  assert.match(css, new RegExp(`:root \\{\\s*--office-canvas-bg: ${HAPPY_MACHINES_BADGE.dark};`));
  assert.match(css, new RegExp(`:root\\[data-office-theme="dark"\\] \\{[^}]*--office-canvas-bg: ${HAPPY_MACHINES_BADGE.light};`));
  assert.match(css, new RegExp(`\\.live-shell \\{[^}]*--office-text: ${HAPPY_MACHINES_DARK_MARK[0].color};`));
  assert.match(css, new RegExp(`:root\\[data-office-theme="dark"\\] \\.live-shell \\{[^}]*--office-text: ${HAPPY_MACHINES_MARK[0].color};`));
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const [badge, mark] of [
    [HAPPY_MACHINES_BADGE.light, HAPPY_MACHINES_MARK],
    [HAPPY_MACHINES_BADGE.dark, HAPPY_MACHINES_DARK_MARK],
  ] as const) {
    const light = Math.max(luminance(badge), luminance(mark[0].color));
    const dark = Math.min(luminance(badge), luminance(mark[0].color));
    assert.ok((light + 0.05) / (dark + 0.05) >= 10, "badge foreground contrast");
    for (const size of [16, 24, 64]) {
      const image = pixels(16, 16);
      image.ctx.fillStyle = badge;
      image.ctx.beginPath();
      image.ctx.roundRect(0, 0, 16, 16, HAPPY_MACHINES_BADGE.radius);
      image.ctx.fill();
      for (const { color, rects } of mark) {
        image.ctx.fillStyle = color;
        for (const [x, y, width, height] of rects) image.ctx.fillRect(x, y, width, height);
      }
      assert.equal(image.isClipped(), false);
      const bitmap = (x: number, y: number, width: number, height: number) =>
        Array.from({ length: height }, (_, row) =>
          Array.from({ length: width }, (_, column) =>
            image.data[y + row][x + column] === mark[0].color ? "1" : "0").join(""));
      assert.deepEqual(bitmap(2, 4, 3, 8),
        ["011", "011", "000", "000", "011", "011", "010", "100"], "semicolon dot and comma grid");
      assert.deepEqual(bitmap(7, 4, 6, 8),
        ["111100", "100010", "100001", "100001", "100001", "100001", "100010", "111100"],
        "uppercase D with transparent counter");
      const displayedPixel = (x: number, y: number) =>
        image.data[Math.floor(y * 16 / size)][Math.floor(x * 16 / size)];
      const center = (coordinate: number) => Math.floor((coordinate + 0.5) * size / 16);
      const sample = (x: number, y: number) => displayedPixel(center(x), center(y));
      const ink = mark[0].color;
      assert.equal(sample(3, 4), ink, "semicolon upper dot");
      assert.equal(sample(4, 5), ink, "semicolon upper dot has width");
      assert.equal(sample(3, 8), ink, "semicolon lower comma");
      assert.equal(sample(3, 10), ink, "comma descender");
      assert.equal(sample(2, 11), ink, "comma curves left");
      assert.equal(sample(3, 6), badge, "gap separates semicolon marks");
      assert.equal(sample(3, 7), badge, "gap remains open");
      assert.equal(sample(7, 4), ink, "D top-left joins vertical stem");
      assert.equal(sample(10, 4), ink, "D upper bar");
      assert.equal(sample(12, 8), ink, "D right bowl");
      assert.equal(sample(7, 11), ink, "D stem reaches lower bar");
      assert.equal(sample(10, 11), ink, "D lower bar");
      for (const y of [5, 6, 7, 8, 9, 10]) {
        assert.equal(sample(9, y), badge, `D counter row ${y} exposes badge`);
      }
      assert.equal(sample(5, 8), badge, "semicolon and D stay separated on one line");
      assert.equal(sample(6, 8), badge, "two-column glyph gap");
      assert.equal(sample(8, 2), badge, "nothing is stacked above the text");
      assert.equal(sample(0, 8), badge, "solid left badge margin");
      assert.equal(sample(15, 8), badge, "solid right badge margin");
      assert.equal(sample(8, 0), badge, "solid top badge margin");
      assert.equal(sample(8, 15), badge, "solid bottom badge margin");
      assert.equal(sample(0, 0), "", "rounded badge corners remain transparent");
      assert.equal(image.data.flat().filter(color => color === ink).length, 30, "glyph geometry is unchanged");
    }
  }
});

test("HQ sign draws the shared sprite at 2x without changing its text", () => {
  const sign = pixels(SIGN_WIDTH, SIGN_HEIGHT);
  drawBrandedSign(sign.ctx, OFFICE_SIGN_TEXT);
  const sprite = pixels(16, 16);
  sprite.ctx.fillStyle = HAPPY_MACHINES_BADGE.dark;
  sprite.ctx.beginPath();
  sprite.ctx.roundRect(0, 0, 16, 16, HAPPY_MACHINES_BADGE.radius);
  sprite.ctx.fill();
  for (const { color, rects } of HAPPY_MACHINES_DARK_MARK) {
    sprite.ctx.fillStyle = color;
    for (const [x, y, width, height] of rects) sprite.ctx.fillRect(x, y, width, height);
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (sprite.data[y][x] === HAPPY_MACHINES_DARK_MARK[0].color ||
      (x >= 3 && x <= 12 && y >= 3 && y <= 12)) {
      assert.equal(sign.data[33 + y * 2][22 + x * 2], sprite.data[y][x], `badge pixel (${x}, ${y})`);
    }
  }
  assert.equal(sign.data[32][21], "#172637", "HQ sign badge has rounded, not square corners");
  assert.equal(sign.isClipped(), false);
});

test("favicon matches the shared ;D pixel glyphs", () => {
  const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.match(svg, /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
  assert.match(svg, /<rect class="badge" width="16" height="16" rx="3"\/>/);
  assert.match(svg, /\.badge \{ fill: #0d202b; \}/);
  assert.match(svg, /\.badge \{ fill: #eee8dc; \}/);
  const paths = [...svg.matchAll(/<path class="([^"]+)" d="([^"]+)"\/>/g)];
  assert.equal(paths.length, HAPPY_MACHINES_MARK.length);
  for (const [index, layer] of HAPPY_MACHINES_MARK.entries()) {
    const className = "ink";
    assert.equal(paths[index][1], className);
    assert.match(svg, new RegExp(`\\.${className} \\{ fill: ${layer.color}; \\}`));
    assert.match(svg, new RegExp(`\\.${className} \\{ fill: ${HAPPY_MACHINES_DARK_MARK[index].color}; \\}`));
    const rects = [...paths[index][2].matchAll(/M(\d+) (\d+)h(\d+)v(\d+)H(\d+)z/g)]
      .map(([, x, y, width, height, endX]) => {
        assert.equal(endX, x, "favicon rectangles close on their left edge");
        return [Number(x), Number(y), Number(width), Number(height)];
      });
    assert.deepEqual(rects, layer.rects);
    assert.equal(rects.reduce((length, rect) => length + `M${rect[0]} ${rect[1]}h${rect[2]}v${rect[3]}H${rect[0]}z`.length, 0),
      paths[index][2].length, "favicon contains only the shared rectangles");
  }
  assert.match(svg, /@media \(prefers-color-scheme: dark\)/);
  assert.equal([...svg.matchAll(/<rect/g)].length, 1, "only the badge is filled");
  assert.doesNotMatch(svg, /class="cavity"|class="teeth"|class="accent"/);
  for (const [dark, mark] of [[false, HAPPY_MACHINES_MARK], [true, HAPPY_MACHINES_DARK_MARK]] as const) {
    const dynamic = happyMachinesFavicon(dark);
    assert.match(dynamic, new RegExp(`<rect width="16" height="16" rx="3" fill="${dark ? HAPPY_MACHINES_BADGE.dark : HAPPY_MACHINES_BADGE.light}"/>`));
    const dynamicPaths = [...dynamic.matchAll(/<path fill="([^"]+)" d="([^"]+)"\/>/g)];
    assert.equal(dynamicPaths.length, mark.length);
    for (const [index, layer] of mark.entries()) {
      assert.equal(dynamicPaths[index][1], layer.color);
      assert.equal(dynamicPaths[index][2], paths[index][2]);
    }
  }
});
