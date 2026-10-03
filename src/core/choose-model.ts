import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly tags: readonly string[];
  readonly context: number;
  readonly input: number | null;
  readonly output: number | null;
  readonly description: string;
}

export interface ModelNeeds {
  readonly tools: number;
  readonly vision: number;
  readonly reasoning: number;
  readonly longContext: number;
  readonly cheap: number;
}

export interface ChooseModelRanking {
  readonly id: string;
  readonly probability: number;
}

export type ChooseFormat = "scoring" | "boolean" | "json" | "table";

export interface ChooseModelResult {
  readonly format: ChooseFormat;
  readonly needs: ModelNeeds;
  readonly winnerId: string | null;
  readonly confidence: number | null;
  readonly ranking: readonly ChooseModelRanking[];
  readonly scoring: readonly { readonly id: string; readonly score: number }[];
  readonly boolean: readonly { readonly id: string; readonly probability: number }[];
  readonly considered: number;
  readonly jevModel: string | null;
}

interface JevAnswer {
  readonly choice?: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly noul?: number;
  readonly score?: number;
}

type JevCall = (state: unknown, questions: Readonly<Record<string, unknown>>) => Promise<{
  readonly model?: string;
  readonly answers?: Readonly<Record<string, JevAnswer>>;
}>;

export function parseGatewayCatalog(json: unknown): CatalogModel[] {
  const record = isRecord(json) ? json : undefined;
  const list = Array.isArray(json) ? json : record?.["data"] ?? record?.["models"];
  if (!Array.isArray(list)) throw new Error("El catálogo no tiene un array de modelos.");
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item) || typeof item["id"] !== "string" || seen.has(item["id"])) continue;
    seen.add(item["id"]);
    const pricing = isRecord(item["pricing"]) ? item["pricing"] : {};
    models.push({
      id: item["id"],
      name: typeof item["name"] === "string" ? item["name"] : item["id"],
      type: typeof item["type"] === "string" ? item["type"] : "language",
      tags: Array.isArray(item["tags"]) ? item["tags"].filter((tag): tag is string => typeof tag === "string") : [],
      context: finite(item["context_window"] ?? item["context"]) ?? 0,
      input: finite(pricing["input"]),
      output: finite(pricing["output"]),
      description: clip(typeof item["description"] === "string" ? item["description"] : "", 180),
    });
  }
  if (models.length === 0) throw new Error("El catálogo no contiene modelos utilizables.");
  return models;
}

export function shortlist(models: readonly CatalogModel[], needs: ModelNeeds, limit = 8): CatalogModel[] {
  const language = models.filter((model) => model.type === "language" || model.type === "chat");
  const source = language.length > 0 ? language : models;
  return [...source].sort((a, b) => localScore(b, needs) - localScore(a, needs)).slice(0, limit);
}

export function modelsFromCandidates(
  candidates: readonly { readonly id: string; readonly note?: string }[],
): CatalogModel[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.id,
    type: "language",
    tags: [],
    context: 0,
    input: null,
    output: null,
    description: clip(candidate.note ?? "", 180),
  }));
}

export async function chooseGatewayModel(
  brief: string,
  models: readonly CatalogModel[],
  callJev: JevCall,
  format: ChooseFormat = "json",
): Promise<ChooseModelResult> {
  const needsResponse = await callJev(brief, {
    tools: { type: "noul", instructions: "The task needs tool calling or an agent that acts." },
    vision: { type: "noul", instructions: "The task needs image, screenshot, PDF, or other visual input." },
    reasoning: { type: "noul", instructions: "The task needs hard reasoning, planning, or multi-step judgment." },
    longContext: { type: "noul", instructions: "The task needs a large context window or a big codebase." },
    cheap: { type: "noul", instructions: "The task should prefer low cost over maximum quality." },
  });
  const needs = needsFrom(needsResponse);
  const candidates = shortlist(models, needs);
  const pick = await callJev(
    {
      task: brief,
      needs,
      candidates: candidates.map((model) => ({
        id: model.id,
        tags: model.tags,
        context: model.context,
        input: model.input,
        output: model.output,
        note: model.description,
      })),
    },
    questionsFor(format, candidates),
  );
  const answer = pick.answers?.["best"];
  const ranking = Object.entries(answer?.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, probability]) => ({ id, probability }));
  const scoring = format === "scoring"
    ? candidates.map((model) => ({ id: model.id, score: pick.answers?.[model.id]?.score ?? 0 })).sort((a, b) => b.score - a.score)
    : [];
  const flags = format === "boolean"
    ? candidates.map((model) => ({ id: model.id, probability: unit(pick.answers?.[model.id]?.noul) })).sort((a, b) => b.probability - a.probability)
    : [];
  return {
    format,
    needs,
    winnerId: format === "scoring" ? scoring[0]?.id ?? null : format === "boolean" ? flags[0]?.id ?? null : answer?.choice ?? ranking[0]?.id ?? null,
    confidence: typeof answer?.confidence === "number" ? answer.confidence : null,
    ranking,
    scoring,
    boolean: flags,
    considered: models.length,
    jevModel: pick.model ?? null,
  };
}

function questionsFor(format: ChooseFormat, candidates: readonly CatalogModel[]): Record<string, unknown> {
  if (format === "scoring") {
    return Object.fromEntries(candidates.map((model) => [model.id, {
      type: "score",
      instructions: `How well ${model.id} fits the task`,
      criteria: ["Poor fit", "Acceptable", "Strong fit"],
    }]));
  }
  if (format === "boolean") {
    return Object.fromEntries(candidates.map((model) => [model.id, {
      type: "noul",
      instructions: `${model.id} is a good fit for the task`,
    }]));
  }
  return {
    best: {
      type: "choice",
      instructions: "Which candidate best fits the task. Prefer capability match. If cheap is required, reject expensive models unless nothing else can do the job.",
      criteria: Object.fromEntries(candidates.map((model) => [model.id, card(model)])),
    },
  };
}

function needsFrom(response: Awaited<ReturnType<JevCall>>): ModelNeeds {
  const answers = response.answers ?? {};
  return {
    tools: unit(answers["tools"]?.noul),
    vision: unit(answers["vision"]?.noul),
    reasoning: unit(answers["reasoning"]?.noul),
    longContext: unit(answers["longContext"]?.noul),
    cheap: unit(answers["cheap"]?.noul),
  };
}

function localScore(model: CatalogModel, needs: ModelNeeds): number {
  const tags = new Set(model.tags.map((tag) => tag.toLowerCase()));
  let score = 0;
  if (needs.tools > 0.5) score += tags.has("tool-use") || tags.has("tools") ? 3 : -2;
  if (needs.vision > 0.5) score += tags.has("vision") || tags.has("file-input") ? 3 : -3;
  if (needs.reasoning > 0.5 && tags.has("reasoning")) score += 2;
  if (needs.longContext > 0.5) score += model.context >= 200_000 ? 3 : model.context >= 100_000 ? 1 : -2;
  if (needs.cheap > 0.5 && model.input != null) {
    score += model.input <= 0.000001 ? 3 : model.input <= 0.000003 ? 1 : -2;
  }
  return score;
}

function card(model: CatalogModel): string {
  const price = model.input == null ? "precio desconocido" : `in ${model.input} out ${model.output ?? "?"}`;
  return `${model.name}. ${model.tags.slice(0, 6).join(", ")}; ctx ${model.context}; ${price}. ${model.description}`;
}

function unit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function finite(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GATEWAY_MODELS = "https://ai-gateway.vercel.sh/v1/models";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadGatewayCatalog(cacheFile: string, env: NodeJS.ProcessEnv = process.env): Promise<CatalogModel[]> {
  try {
    const info = await stat(cacheFile);
    if (Date.now() - info.mtimeMs < DAY_MS) return parseGatewayCatalog(JSON.parse(await readFile(cacheFile, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = env["AI_GATEWAY_API_KEY"]?.trim();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const response = await fetch(GATEWAY_MODELS, { headers });
  if (!response.ok) throw new Error(`AI Gateway /v1/models respondió ${response.status}`);
  const json: unknown = await response.json();
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(json));
  return parseGatewayCatalog(json);
}

export async function callTypeSafe(
  env: NodeJS.ProcessEnv,
  state: unknown,
  questions: Readonly<Record<string, unknown>>,
): Promise<{
  readonly model?: string;
  readonly answers?: Readonly<Record<string, { readonly choice?: string; readonly confidence?: number; readonly probabilities?: Readonly<Record<string, number>>; readonly noul?: number }>>;
}> {
  const apiKey = [env["TYPESAFE_API_KEY"], env["JEV_API_KEY"]].map((value) => value?.trim()).find((value) => value !== undefined && value !== "");
  if (apiKey === undefined || apiKey === "") throw new Error("Falta TYPESAFE_API_KEY o JEV_API_KEY.");
  const root = (env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai").replace(/\/$/, "");
  const response = await fetch(`${root}/v1/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env["TYPESAFE_DEFAULT_MODEL"]?.trim() === undefined || env["TYPESAFE_DEFAULT_MODEL"].trim() === "" ? "jev-latest" : env["TYPESAFE_DEFAULT_MODEL"].trim(), state, questions }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = isRecord(body) && typeof body["message"] === "string" ? body["message"] : response.statusText;
    throw new Error(`Jev ${response.status}: ${message}`);
  }
  return isRecord(body) ? body as Awaited<ReturnType<typeof callTypeSafe>> : {};
}
