import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HAPPY_MACHINES_DARK_MARK, HAPPY_MACHINES_MARK, HAPPY_MACHINES_WORDMARK, OFFICE_SIGN_TEXT,
  PIXEL_LETTERS, SIGN_HEIGHT, SIGN_WIDTH, drawBrandedSign, happyMachinesFavicon, layoutBrandedSign,
} from "../agent-inc/game/sprite-art.js";

function pixels(width: number, height: number) {
  const data = Array.from({ length: height }, () => Array<string>(width).fill(""));
  let clipped = false;
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

test("stroke-only wink and open grin stay legible at 16, 24 and 64 CSS pixels on either theme", () => {
  assert.deepEqual(HAPPY_MACHINES_MARK.map(layer => layer.color), ["#5a4c78", "#28322e"]);
  assert.deepEqual(HAPPY_MACHINES_DARK_MARK.map(layer => layer.color), ["#ead5f3", "#f1e8d6"]);
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert.ok((luminance("#ffffff") + 0.05) / (luminance("#28322e") + 0.05) >= 12);
  assert.ok((luminance("#f1e8d6") + 0.05) / (luminance("#0d202b") + 0.05) >= 12);
  for (const [background, mark] of [
    ["#ffffff", HAPPY_MACHINES_MARK], ["#0d202b", HAPPY_MACHINES_DARK_MARK],
  ] as const) {
    for (const size of [16, 24, 64]) {
      const image = pixels(16, 16);
      for (const { color, rects } of mark) {
        image.ctx.fillStyle = color;
        for (const [x, y, width, height] of rects) image.ctx.fillRect(x, y, width, height);
      }
      assert.equal(image.isClipped(), false);
      const displayedPixel = (x: number, y: number) =>
        image.data[Math.floor(y * 16 / size)][Math.floor(x * 16 / size)] || background;
      const center = (coordinate: number) => Math.floor((coordinate + 0.5) * size / 16);
      const sample = (x: number, y: number) => displayedPixel(center(x), center(y));
      const [accent, ink] = mark.map(layer => layer.color);
      assert.equal(sample(3, 3), ink, "left squinted eye upper stroke");
      assert.equal(sample(6, 4), ink, "left squinted eye tip");
      assert.equal(sample(3, 5), ink, "left squinted eye lower stroke");
      assert.equal(sample(5, 3), background, "wink is not a solid eye");
      assert.equal(sample(10, 2), ink, "right eye starts above the wink");
      assert.equal(sample(11, 5), ink, "right eye remains open and tall");
      assert.equal(sample(9, 3), background, "space beside the open eye");
      assert.equal(sample(2, 8), ink, "left raised corner");
      assert.equal(sample(13, 8), ink, "right raised corner");
      assert.equal(sample(4, 11), ink, "left grin curve");
      assert.equal(sample(11, 11), ink, "right grin curve");
      assert.equal(sample(6, 13), ink, "left bottom grin stroke");
      assert.equal(sample(7, 13), accent, "small purple grin accent");
      assert.equal(sample(9, 13), ink, "right bottom grin stroke");
      for (const y of [8, 9, 10, 11, 12]) {
        assert.equal(sample(7, y), background, `mouth interior row ${y} is transparent`);
      }
      assert.equal(sample(8, 7), background, "no upper border enclosing the smile");
      assert.equal(sample(0, 8), background, "transparent left margin");
      assert.equal(sample(15, 8), background, "transparent right margin");
      assert.equal(sample(8, 0), background, "transparent top margin");
      assert.equal(sample(8, 15), background, "transparent bottom margin");
      assert.equal(image.data[1][8], "", "no painted square behind the eyes");
      assert.equal(image.data[6][8], "", "no painted square between eyes and mouth");
      assert.ok(image.data.flat().filter(Boolean).length <= 40, "face contains strokes, not a filled badge");
    }
  }
});

test("HQ sign draws the shared sprite at 2x without changing its text", () => {
  const sign = pixels(SIGN_WIDTH, SIGN_HEIGHT);
  drawBrandedSign(sign.ctx, OFFICE_SIGN_TEXT);
  const sprite = pixels(16, 16);
  for (const { color, rects } of HAPPY_MACHINES_DARK_MARK) {
    sprite.ctx.fillStyle = color;
    for (const [x, y, width, height] of rects) sprite.ctx.fillRect(x, y, width, height);
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (sprite.data[y][x]) assert.equal(sign.data[32 + y * 2][21 + x * 2], sprite.data[y][x]);
  }
  assert.equal(sign.isClipped(), false);
});

test("favicon matches the shared winking sprite pixel for pixel", () => {
  const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.match(svg, /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
  const paths = [...svg.matchAll(/<path class="([^"]+)" d="([^"]+)"\/>/g)];
  assert.equal(paths.length, HAPPY_MACHINES_MARK.length);
  for (const [index, layer] of HAPPY_MACHINES_MARK.entries()) {
    const className = ["accent", "ink"][index];
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
  assert.doesNotMatch(svg, /<rect|class="cavity"|class="teeth"|<path[^>]+fill="#fff"/);
  for (const [dark, mark] of [[false, HAPPY_MACHINES_MARK], [true, HAPPY_MACHINES_DARK_MARK]] as const) {
    const dynamic = happyMachinesFavicon(dark);
    const dynamicPaths = [...dynamic.matchAll(/<path fill="([^"]+)" d="([^"]+)"\/>/g)];
    assert.equal(dynamicPaths.length, mark.length);
    for (const [index, layer] of mark.entries()) {
      assert.equal(dynamicPaths[index][1], layer.color);
      assert.equal(dynamicPaths[index][2], paths[index][2]);
    }
  }
});
