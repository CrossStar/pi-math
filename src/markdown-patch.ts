import {
  Markdown,
  allocateImageId,
  getCapabilities,
  getCellDimensions,
} from "@earendil-works/pi-tui";
import { insertFormulaImages, type FormulaImagePlacement } from "./image-layout.js";
import { kittyPlaceholderSupport } from "./kitty-graphics.js";
import type { TerminalMathRenderer } from "./renderer.js";
import {
  containsPotentialMath,
  expandMathInMarkdown,
  stripGeneratedMathFenceLines,
} from "./transform.js";

const DEFAULT_FORMULA_COLOR = "#b5bd68";
const MAX_RASTER_HEIGHT_PX = 4096;

type MarkdownInternals = {
  text: string;
  paddingX?: number;
  theme?: {
    codeBlock?: (text: string) => string;
  };
};

type MarkdownRender = (this: Markdown, width: number) => string[];

interface CachedTransform {
  source: string;
  layoutKey: string;
  transformed: string;
  placements: FormulaImagePlacement[];
  finalOutput?: { raw: string[]; placeholders: boolean; lines: string[] };
}

export interface MathPatchController {
  getScale(): number;
  setScale(scale: number): void;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  clearTransformCache(): void;
  uninstall(): void;
}

function formulaColor(markdown: MarkdownInternals): string {
  const styled = markdown.theme?.codeBlock?.("x") ?? "";
  const trueColor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(styled);
  if (!trueColor) return DEFAULT_FORMULA_COLOR;

  return `#${trueColor
    .slice(1, 4)
    .map((component) => Number(component).toString(16).padStart(2, "0"))
    .join("")}`;
}

function imageMarker(
  imageId: number,
  index: number,
  columns: number,
  inline: boolean,
): string {
  if (!inline) return `__PI_MATH_IMAGE_${imageId}_${index}__`;
  const privateUseCharacter = String.fromCodePoint(0xe000 + (index % 0x1900));
  return privateUseCharacter.repeat(columns);
}

function allocateMathImageId(): number {
  return (allocateImageId() & 0xffffff) || 1;
}

/**
 * Install a reversible display-only wrapper around Pi's Markdown renderer.
 * The source Markdown is restored before render() returns, so session history
 * and provider context always retain the original LaTeX.
 */
export function installMarkdownMathPatch(renderer: TerminalMathRenderer, initialScale = 0.7): MathPatchController {
  let scale = initialScale;
  const originalRender = Markdown.prototype.render;
  let enabled = true;
  let installed = true;
  let detectionCache = new WeakMap<Markdown, { source: string; hasMath: boolean }>();
  let transformCache = new WeakMap<Markdown, CachedTransform>();
  // Keep terminal image identities across streaming updates, resizes and cache clears.
  // A new ID on every frame leaves old images in the terminal's graphics store.
  const imageIds = new WeakMap<Markdown, number[]>();

  const patchedRender: MarkdownRender = function (width: number): string[] {
    const markdown = this as unknown as MarkdownInternals;
    const source = markdown.text;
    const protocol = getCapabilities().images;
    if (
      !enabled ||
      !protocol ||
      process.env.TMUX ||
      /^(tmux|screen)/i.test(process.env.TERM ?? "") ||
      typeof source !== "string"
    ) {
      return originalRender.call(this, width);
    }

    let detection = detectionCache.get(this);
    if (detection?.source !== source) {
      detection = { source, hasMath: containsPotentialMath(source) };
      detectionCache.set(this, detection);
    }
    if (!detection.hasMath) return originalRender.call(this, width);

    const paddingX =
      typeof markdown.paddingX === "number" && Number.isFinite(markdown.paddingX)
        ? Math.max(0, markdown.paddingX)
        : 0;
    const color = formulaColor(markdown);
    const cells = getCellDimensions();
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutKey = `${scale}:${width}:${paddingX}:${color}:${protocol}:${cells.widthPx}:${cells.heightPx}`;
    const maxBlockRows = Math.max(1, Math.floor(MAX_RASTER_HEIGHT_PX / cells.heightPx));

    let transformed: string;
    let placements: FormulaImagePlacement[];
    let cached = transformCache.get(this);
    if (cached?.source === source && cached.layoutKey === layoutKey) {
      ({ transformed, placements } = cached);
    } else {
      placements = [];
      transformed = expandMathInMarkdown(source, (latex, display, context) => {
        const inline = !display && !context.standalone;
        if (inline && protocol !== "kitty") return undefined;

        const raster = renderer.render(latex, display, color, {
          scale,
          maxWidthCells: contentWidth,
          maxHeightCells: inline ? 1 : maxBlockRows,
          cellWidthPx: cells.widthPx,
          cellHeightPx: cells.heightPx,
          fitHeight: inline,
        });
        if (!raster) return undefined;

        let ids = imageIds.get(this);
        if (!ids) {
          ids = [];
          imageIds.set(this, ids);
        }
        const imageId = ids[placements.length] ?? (ids[placements.length] = allocateMathImageId());
        const marker = imageMarker(imageId, placements.length, raster.columns, inline);
        placements.push({
          marker,
          imageId,
          raster,
          inline,
          fallbackText: source.slice(context.start, context.end),
        });
        return { text: marker, forceBlock: !inline, rawInline: inline };
      });
      cached = { source, layoutKey, transformed, placements };
      transformCache.set(this, cached);
    }

    if (transformed === source || placements.length === 0) {
      return originalRender.call(this, width);
    }

    markdown.text = transformed;
    try {
      // Always consult Pi's renderer: its array identity carries invalidation.
      // Both the original and returned arrays follow Pi's read-only contract.
      const raw = originalRender.call(this, width);
      const placeholders = kittyPlaceholderSupport();
      if (cached.finalOutput?.raw === raw && cached.finalOutput.placeholders === placeholders) {
        return cached.finalOutput.lines;
      }
      const textLines = stripGeneratedMathFenceLines(raw);
      const lines = insertFormulaImages(textLines, placements, { renderWidth: width, paddingX });
      cached.finalOutput = { raw, placeholders, lines };
      return lines;
    } finally {
      markdown.text = source;
    }
  };

  Markdown.prototype.render = patchedRender;
  return {
    getScale: () => scale,
    setScale(value: number) {
      if (!Number.isFinite(value) || value < 0.25 || value > 2) {
        throw new Error("Scale must be between 0.25 and 2");
      }
      scale = value;
      transformCache = new WeakMap();
    },
    isEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
    },
    clearTransformCache() {
      detectionCache = new WeakMap();
      transformCache = new WeakMap();
    },
    uninstall() {
      enabled = false;
      detectionCache = new WeakMap();
      transformCache = new WeakMap();
      if (installed && Markdown.prototype.render === patchedRender) {
        Markdown.prototype.render = originalRender;
      }
      installed = false;
    },
  };
}
