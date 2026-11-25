import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { loadMathScale, loadSvgMathRendererOptions } from "./config.js";
import { installMarkdownMathPatch } from "./markdown-patch.js";
import { createTerminalMathRenderer, type TerminalMathRenderer } from "./renderer.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default async function piMathExtension(pi: ExtensionAPI): Promise<void> {
  let renderer: TerminalMathRenderer | undefined;
  let loadFailure: string | undefined;
  let initialScale = 0.7;
  try {
    initialScale = loadMathScale();
    renderer = await createTerminalMathRenderer(loadSvgMathRendererOptions());
  } catch (error) {
    loadFailure = errorMessage(error);
  }

  const patch = renderer ? installMarkdownMathPatch(renderer, initialScale) : undefined;

  pi.on("session_start", (_event, ctx) => {
    if (loadFailure && ctx.mode === "tui") {
      ctx.ui.notify(`pi-math failed to load: ${loadFailure}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    patch?.uninstall();
  });

  pi.registerCommand("math-render", {
    description: "Control LaTeX rendering: on, off, status, clear, or scale <0.25–2>",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (!patch || !renderer) {
        ctx.ui.notify(`pi-math is unavailable: ${loadFailure ?? "renderer did not load"}`, "error");
        return;
      }
      if (action === "scale" || action.startsWith("scale ")) {
        const parts = action.split(/\s+/);
        if (parts.length === 1) {
          ctx.ui.notify(`pi-math scale: ${patch.getScale()}× (range 0.25–2)`, "info");
          return;
        }
        const value = parts[1] === "reset" ? initialScale : Number(parts[1]);
        if (parts.length !== 2 || !Number.isFinite(value) || value < 0.25 || value > 2) {
          ctx.ui.notify("Usage: /math-render scale <0.25–2|reset>", "warning");
          return;
        }
        patch.setScale(value);
        ctx.ui.notify(`pi-math scale set to ${value}×`, "info");
        return;
      }
      if (action === "on" || action === "enable") {
        patch.setEnabled(true);
        ctx.ui.notify("pi-math enabled", "info");
        return;
      }
      if (action === "off" || action === "disable") {
        patch.setEnabled(false);
        ctx.ui.notify("pi-math disabled", "info");
        return;
      }
      if (action === "clear") {
        renderer.clear();
        patch.clearTransformCache();
        ctx.ui.notify("pi-math render caches cleared", "info");
        return;
      }
      if (action === "status") {
        const status = patch.isEnabled() ? "enabled" : "disabled";
        const protocol = getCapabilities().images ?? "unsupported terminal";
        const lastFailure = renderer.lastFailure ? `, last failure: ${renderer.lastFailure.code}` : "";
        ctx.ui.notify(
          `pi-math is ${status} (${protocol}, scale ${patch.getScale()}×, ${renderer.cacheSize} rasters, ${formatBytes(renderer.cacheBytes)}${lastFailure})`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /math-render on|off|status|clear|scale <0.25–2|reset>", "warning");
    },
  });
}
