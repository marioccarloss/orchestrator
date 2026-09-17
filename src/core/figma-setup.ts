import { access, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process.js";
import { capabilityPaths } from "./capabilities.js";
import type { MrPaths } from "./paths.js";

export interface FigmaSetupStatus {
  readonly binaryInstalled: boolean;
  readonly manifestSource: string;
  readonly manifestPublished: string;
  readonly manifestPublishedOk: boolean;
  readonly mcpResponds: boolean;
  readonly detail: string;
}

export function figmaPublishedManifestPath(paths: MrPaths): string {
  return join(paths.configRoot, "figma-live", "manifest.json");
}

export async function publishFigmaManifest(paths: MrPaths): Promise<string> {
  const source = capabilityPaths(paths).figmaPluginManifest;
  const target = figmaPublishedManifestPath(paths);
  await mkdir(join(paths.configRoot, "figma-live"), { recursive: true });
  await copyFile(source, target);
  return target;
}

export async function assessFigmaSetup(paths: MrPaths): Promise<FigmaSetupStatus> {
  const capability = capabilityPaths(paths);
  const published = figmaPublishedManifestPath(paths);
  let binaryInstalled = false;
  let manifestPublishedOk = false;
  try {
    await access(capability.figmaLive);
    binaryInstalled = true;
  } catch {
    binaryInstalled = false;
  }
  try {
    await access(published);
    manifestPublishedOk = true;
  } catch {
    manifestPublishedOk = false;
  }
  let mcpResponds = false;
  if (binaryInstalled) {
    const probe = runCommand(capability.figmaLive, ["--help"]);
    mcpResponds = probe.ok || probe.stderr.length > 0 || probe.stdout.length > 0;
  }
  const detail = !binaryInstalled
    ? "figma-live-mcp binary missing; run mr capabilities install → figma-live"
    : !manifestPublishedOk
      ? `Import Figma plugin from ${capability.figmaPluginManifest} (or run mr figma setup)`
      : mcpResponds
        ? `Ready. Plugin manifest: ${published}`
        : `Binary present; MCP probe inconclusive. Manifest: ${published}`;
  return {
    binaryInstalled,
    manifestSource: capability.figmaPluginManifest,
    manifestPublished: published,
    manifestPublishedOk,
    mcpResponds,
    detail,
  };
}

export function figmaSetupInstructions(status: FigmaSetupStatus, language: "es" | "en" = "es"): string {
  if (language === "en") {
    return [
      "Figma Live MCP setup:",
      `1. In Figma: Plugins → Development → Import plugin from manifest…`,
      `2. Select: ${status.manifestPublishedOk ? status.manifestPublished : status.manifestSource}`,
      "3. Open the plugin while designing; mr-orchestrator reads the live selection via figma-live-mcp.",
      "Non-blocking: /flow continues without design if MCP is unavailable.",
    ].join("\n");
  }
  return [
    "Configuración Figma Live MCP:",
    "1. En Figma: Plugins → Development → Import plugin from manifest…",
    `2. Selecciona: ${status.manifestPublishedOk ? status.manifestPublished : status.manifestSource}`,
    "3. Abre el plugin mientras diseñas; mr-orchestrator lee la selección vía figma-live-mcp.",
    "No bloqueante: /flow continúa sin diseño si el MCP no responde.",
  ].join("\n");
}
