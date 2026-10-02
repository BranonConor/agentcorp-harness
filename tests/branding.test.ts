import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HAPPY_MACHINES_MARK, HAPPY_MACHINES_WORDMARK, OFFICE_SIGN_TEXT, PIXEL_LETTERS,
  SIGN_HEIGHT, SIGN_WIDTH, drawBrandedSign, layoutBrandedSign,
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

test("two-color pixel smile stays recognizable at 16 and 24 CSS pixels", () => {
  assert.deepEqual([...new Set(HAPPY_MACHINES_MARK.map(layer => layer.color))], ["#263247", "#a7ffe6"]);
  assert.ok(HAPPY_MACHINES_MARK.reduce((count, layer) => count + layer.rects.length, 0) <= 15);
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert.ok((luminance("#a7ffe6") + 0.05) / (luminance("#263247") + 0.05) >= 10);
  for (const size of [16, 24]) {
    const image = pixels(16, 16);
    for (const { color, rects } of HAPPY_MACHINES_MARK) {
      image.ctx.fillStyle = color;
      for (const [x, y, width, height] of rects) image.ctx.fillRect(x, y, width, height);
    }
    assert.equal(image.isClipped(), false);
    const displayedPixel = (x: number, y: number) =>
      image.data[Math.floor(y * 16 / size)][Math.floor(x * 16 / size)];
    const center = (coordinate: number) => Math.floor((coordinate + 0.5) * size / 16);
    assert.equal(displayedPixel(center(5), center(5)), "#263247", "left eye");
    assert.equal(displayedPixel(center(10), center(5)), "#263247", "right eye");
    assert.equal(displayedPixel(center(7), center(8)), "#a7ffe6", "open space between eyes and smile");
    assert.equal(displayedPixel(center(4), center(9)), "#263247", "left smile corner");
    assert.equal(displayedPixel(center(11), center(9)), "#263247", "right smile corner");
    assert.equal(displayedPixel(center(7), center(12)), "#263247", "center of smile");
    assert.equal(displayedPixel(center(1), center(8)), "#263247", "contrasting outline");
    assert.equal(displayedPixel(center(0), center(8)), "", "transparent margin");
  }
});

test("favicon matches the shared smile sprite pixel for pixel", () => {
  const svg = readFileSync(new URL("../favicon.svg", import.meta.url), "utf8");
  assert.match(svg, /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
  const paths = [...svg.matchAll(/<path fill="([^"]+)" d="([^"]+)"\/>/g)];
  assert.equal(paths.length, HAPPY_MACHINES_MARK.length);
  for (const [index, layer] of HAPPY_MACHINES_MARK.entries()) {
    assert.equal(paths[index][1], layer.color);
    const rects = [...paths[index][2].matchAll(/M(\d+) (\d+)h(\d+)v(\d+)H(\d+)z/g)]
      .map(([, x, y, width, height, endX]) => {
        assert.equal(endX, x, "favicon rectangles close on their left edge");
        return [Number(x), Number(y), Number(width), Number(height)];
      });
    assert.deepEqual(rects, layer.rects);
    assert.equal(rects.reduce((length, rect) => length + `M${rect[0]} ${rect[1]}h${rect[2]}v${rect[3]}H${rect[0]}z`.length, 0),
      paths[index][2].length, "favicon contains only the shared rectangles");
  }
});
