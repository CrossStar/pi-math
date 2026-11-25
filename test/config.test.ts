import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { loadMathScale, loadSvgMathRendererOptions } from "../src/config.js";

test("loads and validates the default formula scale", () => {
  assert.equal(loadMathScale({}), 0.7);
  assert.equal(loadMathScale({ PI_MATH_SCALE: " " }), 0.7);
  assert.equal(loadMathScale({ PI_MATH_SCALE: "1" }), 1);
  for (const value of ["0", "-1", "2.1", "NaN", "Infinity", "abc"]) {
    assert.throws(() => loadMathScale({ PI_MATH_SCALE: value }), /PI_MATH_SCALE/);
  }
});

test("loads cross-platform renderer options without fixed font paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-math-config-"));
  const firstFont = join(directory, "math.ttf");
  const secondFont = join(directory, "text.otf");
  writeFileSync(firstFont, "fixture");
  writeFileSync(secondFont, "fixture");

  try {
    const options = loadSvgMathRendererOptions({
      PI_MATH_MACROS: JSON.stringify({ RR: String.raw`\mathbb{R}`, "\\vect": [String.raw`\mathbf{#1}`, 1] }),
      PI_MATH_ENVIRONMENTS: JSON.stringify({ braced: [String.raw`\left\{`, String.raw`\right\}`] }),
      PI_MATH_FONT_FILES: `${firstFont}${delimiter}${secondFont}`,
      PI_MATH_SYSTEM_FONTS: "false",
    });
    assert.deepEqual(options.macros, {
      RR: String.raw`\mathbb{R}`,
      vect: [String.raw`\mathbf{#1}`, 1],
    });
    assert.deepEqual(options.environments, {
      braced: [String.raw`\left\{`, String.raw`\right\}`],
    });
    assert.deepEqual(options.fontFiles, [firstFont, secondFont]);
    assert.equal(options.loadSystemFonts, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("enables system font discovery by default and rejects malformed options", () => {
  assert.equal(loadSvgMathRendererOptions({}).loadSystemFonts, true);
  assert.throws(
    () => loadSvgMathRendererOptions({ PI_MATH_MACROS: "[]" }),
    /PI_MATH_MACROS must be a JSON object/u,
  );
  assert.throws(
    () =>
      loadSvgMathRendererOptions({
        PI_MATH_FONT_FILES: join(tmpdir(), "pi-math-font-does-not-exist.ttf"),
      }),
    /does not exist/u,
  );
});
