import * as p from "@clack/prompts";
import {
  CAPABILITY_IDS,
  detectInstalledCapabilities,
  defaultCapabilitySelection,
  loadCapabilitySelection,
  type CapabilityId,
  type CapabilitySelection,
  type CredentialStatus,
} from "../core/capabilities.js";
import type { MrPaths } from "../core/paths.js";

export interface CapabilityGuideEntry {
  readonly id: CapabilityId;
  readonly label: string;
  readonly importance: "Esencial" | "Importante";
  readonly benefit: string;
}

export const CAPABILITY_GUIDE: readonly CapabilityGuideEntry[] = [
  { id: "i-have-adhd", label: "i-have-adhd", importance: "Importante", benefit: "Hace que solo Orchestrator explique el trabajo con acciones breves, visibles y fáciles de seguir." },
  { id: "codebase-memory", label: "Codebase Memory", importance: "Esencial", benefit: "Localiza símbolos, relaciones y cobertura sin releer todo el repositorio ni inventar estructura." },
  { id: "codegraph", label: "CodeGraph", importance: "Importante", benefit: "Aporta contexto quirúrgico y rutas de impacto desde un índice local complementario." },
  { id: "context7", label: "Context7", importance: "Importante", benefit: "Consulta documentación actual de librerías y evita implementar contra APIs obsoletas." },
  { id: "engram", label: "Engram", importance: "Esencial", benefit: "Conserva decisiones, errores y convenciones entre sesiones y después de compactaciones." },
  { id: "github", label: "GitHub", importance: "Esencial", benefit: "Permite leer tickets, ramas, checks y PR con evidencia del repositorio remoto." },
  { id: "jira", label: "Jira", importance: "Importante", benefit: "Carga tickets y criterios de aceptación cuando el workspace trabaja con Atlassian." },
  { id: "figma-live", label: "Figma Live MCP", importance: "Importante", benefit: "Lee la selección viva de Figma y exporta tokens y assets sin API key." },
] as const;

export function formatCapabilityGuide(
  selection: CapabilitySelection,
  installed: ReadonlySet<CapabilityId> = new Set(),
): string {
  const selected = new Set(selection.selected);
  return CAPABILITY_GUIDE.map((item) => {
    const state = installed.has(item.id) ? "✓ listo" : selected.has(item.id) ? "◐ seleccionado" : "— pendiente";
    const credential = item.id === "github" || item.id === "jira"
      ? `; credenciales: ${selection.credentials[item.id]}`
      : "";
    return `${state} · ${item.importance} · ${item.label}${credential}\n  ${item.benefit}`;
  }).join("\n");
}

async function credentialChoice(id: "github" | "jira", current: CredentialStatus): Promise<CredentialStatus | "skip"> {
  p.note(
    id === "github"
      ? "Inicia el MCP de GitHub desde tu cliente y completa su OAuth. El instalador nunca lee ni copia el token."
      : "Inicia el MCP de Jira desde tu cliente y completa el OAuth de Atlassian. El instalador nunca lee ni copia el token.",
    `${id === "github" ? "GitHub" : "Jira"}: credenciales`,
  );
  const result = await p.select<CredentialStatus | "skip">({
    message: `Estado de ${id === "github" ? "GitHub" : "Jira"}`,
    initialValue: current,
    options: [
      { value: "ready", label: "Ya está credencializado", hint: "activar y continuar" },
      { value: "pending", label: "Lo haré más tarde", hint: "continuar ahora y mostrar recordatorio" },
      { value: "skip", label: "No instalar este MCP" },
    ],
  });
  return p.isCancel(result) ? current : result;
}

export async function interactiveCapabilitySelector(paths: MrPaths): Promise<CapabilitySelection | null> {
  const current = await loadCapabilitySelection(paths).catch(() => defaultCapabilitySelection());
  const installed = await detectInstalledCapabilities(paths, current);
  p.intro("Skills y MCP de mr-orchestrator");
  p.note(formatCapabilityGuide(current, installed), "Qué aporta cada capacidad y qué está listo");
  const action = await p.select<"all" | "choose" | "continue" | "later" | "cancel">({
    message: "¿Cómo quieres continuar?",
    options: [
      { value: "all", label: "Instalarlos todos", hint: "recomendado; credenciales pendientes no bloquean" },
      { value: "choose", label: "Elegir uno por uno", hint: "personalizar la instalación" },
      { value: "continue", label: "Continuar con la selección actual", hint: `${String(current.selected.length)} seleccionados` },
      { value: "later", label: "Continuar y hacerlo más tarde", hint: "mr-orchestrator se instala y mostrará un aviso" },
      { value: "cancel", label: "Cancelar toda la instalación" },
    ],
  });
  if (p.isCancel(action) || action === "cancel") {
    p.cancel("Instalación cancelada; no se modificó la selección de capacidades.");
    return null;
  }

  let selected: CapabilityId[];
  if (action === "all") selected = [...CAPABILITY_IDS];
  else if (action === "later") selected = [];
  else if (action === "continue") selected = [...current.selected];
  else {
    const chosen = await p.multiselect<CapabilityId>({
      message: "Selecciona skills y MCP",
      initialValues: [...current.selected],
      required: false,
      options: CAPABILITY_GUIDE.map((item) => ({
        value: item.id,
        label: `${item.label} · ${item.importance}`,
        hint: item.benefit,
      })),
    });
    if (p.isCancel(chosen)) return current;
    selected = [...chosen];
  }

  const credentials: Record<"github" | "jira", CredentialStatus> = { ...current.credentials };
  for (const id of ["github", "jira"] as const) {
    if (!selected.includes(id)) continue;
    const state = await credentialChoice(id, credentials[id]);
    if (state === "skip") selected = selected.filter((item) => item !== id);
    else credentials[id] = state;
  }

  return { schemaVersion: 1, selected, credentials, updatedAt: new Date().toISOString() };
}
