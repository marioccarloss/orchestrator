import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { detectLanguage, type UserLanguage } from "./language.js";

/**
 * Narration: user-facing explanations of /task, /flow and /blueprint end with a
 * clickable `[▶ play]` link. Clicking it opens a localhost URL served by the
 * plugin, which reads that text aloud with macOS `say`. Nothing plays without a
 * click, no text travels in the URL (only an opaque id + per-process token), and
 * no model tokens are spent.
 */

export const NARRATED_COMMANDS: ReadonlySet<string> = new Set(["task", "flow", "blueprint"]);
export const NARRATION_LINK_LABEL = "▶ play";
/** Matches the appended link so it can be stripped from history before LLM calls. */
export const NARRATION_LINK_PATTERN = /\n*\[▶ play\]\(http:\/\/127\.0\.0\.1:\d+\/n\/[a-f0-9]+\?k=[a-f0-9]+\)\s*$/u;
const MIN_NARRATABLE_CHARS = 40;
const MAX_SPOKEN_CHARS = 4_000;
const MAX_ENTRIES = 200;

/** Preferred macOS voices per language, best first; the first installed one wins. */
const PREFERRED_VOICES: Readonly<Record<UserLanguage, readonly string[]>> = {
  es: ["Mónica", "Paulina", "Jorge", "Marisol", "Flo", "Eddy"],
  en: ["Samantha", "Daniel", "Alex", "Flo", "Eddy"],
  pt: ["Luciana", "Joana", "Flo", "Eddy"],
  ca: ["Montse", "Jordi"],
  fr: ["Thomas", "Amélie", "Flo", "Eddy"],
};
const LOCALE_PREFIX: Readonly<Record<UserLanguage, string>> = { es: "es_", en: "en_", pt: "pt_", ca: "ca_", fr: "fr_" };

export interface NarrationConfig {
  readonly enabled: boolean;
  readonly voice?: string;
  readonly rate: number;
  readonly reason?: string;
}

export function loadNarrationConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, hasSay: () => boolean = sayAvailable): NarrationConfig {
  const rateValue = Number(env["MR_NARRATION_RATE"] ?? "190");
  const rate = Number.isFinite(rateValue) && rateValue >= 90 && rateValue <= 400 ? Math.round(rateValue) : 190;
  const voice = env["MR_NARRATION_VOICE"]?.trim();
  const base = { rate, ...(voice === undefined || voice.length === 0 ? {} : { voice }) };
  if (["off", "0", "false"].includes(env["MR_NARRATION"]?.trim().toLowerCase() ?? "")) return { ...base, enabled: false, reason: "MR_NARRATION=off" };
  if (platform !== "darwin") return { ...base, enabled: false, reason: "narration uses macOS say" };
  if (!hasSay()) return { ...base, enabled: false, reason: "`say` is not available" };
  return { ...base, enabled: true };
}

function sayAvailable(): boolean {
  return spawnSync("which", ["say"], { encoding: "utf8" }).status === 0;
}

/** Voice list from `say -v ?`: "Name (Variant)   xx_YY    # sample". */
export function parseVoices(output: string): readonly { readonly name: string; readonly locale: string }[] {
  return output.split("\n").flatMap((line) => {
    const match = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/u.exec(line) ?? /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/u.exec(line);
    if (match === null) return [];
    const name = (match[1] ?? "").replace(/\s*\(.*\)\s*$/u, "").trim();
    return name.length === 0 ? [] : [{ name, locale: match[2] ?? "" }];
  });
}

export function pickVoice(language: UserLanguage, voices: readonly { readonly name: string; readonly locale: string }[]): string | undefined {
  const localeVoices = voices.filter((voice) => voice.locale.startsWith(LOCALE_PREFIX[language]));
  for (const preferred of PREFERRED_VOICES[language]) {
    if (localeVoices.some((voice) => voice.name === preferred)) return preferred;
  }
  return localeVoices[0]?.name;
}

/** Turns markdown into something pleasant to hear: no code, URLs, tables pipes or symbols. */
export function markdownToSpeech(markdown: string): string {
  return markdown
    .replace(NARRATION_LINK_PATTERN, "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gmu, " ")
    .replace(/\|/gu, ", ")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~>#]+/gu, " ")
    .replace(/[→←⇒]/gu, ", ")
    .replace(/\s*\n\s*/gu, ". ")
    .replace(/\s{2,}/gu, " ")
    .replace(/(?:\.\s*){2,}/gu, ". ")
    .trim()
    .slice(0, MAX_SPOKEN_CHARS);
}

export type SpeakProcess = (voice: string | undefined, rate: number, text: string) => Pick<ChildProcess, "kill">;

const defaultSpeak: SpeakProcess = (voice, rate, text) => {
  const args = [...(voice === undefined ? [] : ["-v", voice]), "-r", String(rate)];
  const child = spawn("say", args, { stdio: ["pipe", "ignore", "ignore"], detached: false });
  child.stdin?.end(text);
  child.on("error", () => undefined);
  return child;
};

interface Entry {
  readonly text: string;
  readonly language: UserLanguage;
}

export interface NarrationOptions {
  readonly config: NarrationConfig;
  readonly speak?: SpeakProcess;
  readonly listVoices?: () => string;
  readonly port?: number;
}

function page(title: string, body: string, token: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:3rem;color:#222}a{display:inline-block;margin-top:1rem;padding:.4rem .9rem;border:1px solid #888;border-radius:6px;text-decoration:none;color:#222}</style></head>
<body><p>${body}</p><a href="/stop?k=${token}">⏹ Detener</a></body></html>`;
}

export class NarrationService {
  private server: Server | undefined;
  private starting: Promise<number> | undefined;
  private current: Pick<ChildProcess, "kill"> | undefined;
  private readonly token = randomBytes(16).toString("hex");
  private readonly entries = new Map<string, Entry>();
  private voices: readonly { readonly name: string; readonly locale: string }[] | undefined;
  private readonly speak: SpeakProcess;

  constructor(private readonly options: NarrationOptions) {
    this.speak = options.speak ?? defaultSpeak;
  }

  get enabled(): boolean {
    return this.options.config.enabled;
  }

  /**
   * Registers a narratable text and returns the markdown link, or undefined when narration does not apply.
   * `language` is the developer's language (from the command input); it beats detection on mixed technical text.
   */
  async link(text: string, language?: UserLanguage): Promise<string | undefined> {
    if (!this.enabled || NARRATION_LINK_PATTERN.test(text)) return undefined;
    const spoken = markdownToSpeech(text);
    if (spoken.length < MIN_NARRATABLE_CHARS) return undefined;
    const port = await this.ensureServer();
    const id = randomBytes(8).toString("hex");
    this.entries.set(id, { text: spoken, language: language ?? detectLanguage(spoken) });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return `[${NARRATION_LINK_LABEL}](http://127.0.0.1:${String(port)}/n/${id}?k=${this.token})`;
  }

  /** Plays a registered entry; exposed for tests and the HTTP handler. */
  play(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.stop();
    this.current = this.speak(this.voiceFor(entry.language), this.options.config.rate, entry.text);
    return true;
  }

  stop(): void {
    this.current?.kill("SIGTERM");
    this.current = undefined;
  }

  close(): void {
    this.stop();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
  }

  private voiceFor(language: UserLanguage): string | undefined {
    if (this.options.config.voice !== undefined) return this.options.config.voice;
    if (this.voices === undefined) {
      try {
        this.voices = parseVoices(this.options.listVoices?.() ?? spawnSync("say", ["-v", "?"], { encoding: "utf8" }).stdout);
      } catch {
        this.voices = [];
      }
    }
    return pickVoice(language, this.voices);
  }

  private authorized(url: URL): boolean {
    const given = Buffer.from(url.searchParams.get("k") ?? "");
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, html: string): void => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(html);
    };
    if (request.method !== "GET" || !this.authorized(url)) {
      send(403, "<p>Forbidden</p>");
      return;
    }
    if (url.pathname === "/stop") {
      this.stop();
      send(200, page("mr-orchestrator", "⏹ Narración detenida. Puedes cerrar esta pestaña.", this.token));
      return;
    }
    const match = /^\/n\/([a-f0-9]{16})$/u.exec(url.pathname);
    if (match === null || !this.play(match[1] ?? "")) {
      send(404, page("mr-orchestrator", "Esta narración ya no está disponible (se reinició OpenCode o es muy antigua).", this.token));
      return;
    }
    send(200, page("▶ mr-orchestrator", "▶ Reproduciendo la explicación… Puedes cerrar esta pestaña.", this.token));
  }

  private async ensureServer(): Promise<number> {
    if (this.server !== undefined) return (this.server.address() as AddressInfo).port;
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => { this.handle(request, response); });
      server.once("error", reject);
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        server.unref();
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.starting;
  }
}

export function stripNarrationLink(text: string): string {
  return text.replace(NARRATION_LINK_PATTERN, "");
}
