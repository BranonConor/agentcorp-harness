import assert from "node:assert/strict";
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

test("pixel smile keeps eyes, grin, cheeks and glint at 16 and 24 CSS pixels", () => {
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
    assert.equal(displayedPixel(center(5), center(6)), "#314058", "left eye");
    assert.equal(displayedPixel(center(9), center(6)), "#314058", "right eye");
    assert.equal(displayedPixel(center(7), center(12)), "#314058", "grin");
    assert.equal(displayedPixel(center(3), center(9)), "#eaa99c", "cheek");
    assert.equal(displayedPixel(center(12), center(1)), "#fff2bd", "glint");
  }
});
