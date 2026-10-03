import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginInput } from "@opencode-ai/plugin";
import {
  NarrationService,
  loadNarrationConfig,
  markdownToSpeech,
  parseVoices,
  pickVoice,
  stripNarrationLink,
  type SpeakProcess,
} from "../src/core/narration.js";
import { resolvePaths } from "../src/core/paths.js";
import { seedModels } from "../src/core/config.js";
import { createMrOrchestrator } from "../src/plugin.js";

const VOICES = `Mónica (Español (España)) es_ES    # ¡Hola! Me llamo Mónica.
Paulina             es_MX    # ¡Hola! Me llamo Paulina.
Samantha (Inglés (EE. UU.)) en_US    # Hello! My name is Samantha.
Montse              ca_ES    # Hola! Em dic Montse.`;

const EXPLANATION = "## Plan, en breve\n\n1. Cambiar `promoBanner` a **false** en [flags](src/config/flags.ts).\n2. Ejecutar los tests.\n\n```ts\nconst x = 1;\n```\n| a | b |\n|---|---|\n| uno | dos |";

function recorder(): { readonly speak: SpeakProcess; readonly calls: { voice: string | undefined; rate: number; text: string }[]; killed: () => number } {
  const calls: { voice: string | undefined; rate: number; text: string }[] = [];
  let kills = 0;
  return {
    calls,
    killed: () => kills,
    speak: (voice, rate, text) => {
      calls.push({ voice, rate, text });
      return { kill: () => { kills += 1; return true; } };
    },
  };
}

void test("markdown becomes speakable text without code, links, tables or symbols", () => {
  const spoken = markdownToSpeech(EXPLANATION);
  assert.doesNotMatch(spoken, /```|const x|\(src\/|\||\*\*|#/u);
  assert.match(spoken, /Plan, en breve/u);
  assert.match(spoken, /Cambiar promoBanner a false en flags/u);
  assert.match(spoken, /uno , dos|uno, dos/u);
});

void test("voices are chosen per language from what macOS has installed", () => {
  const voices = parseVoices(VOICES);
  assert.deepEqual(voices.map((voice) => voice.name), ["Mónica", "Paulina", "Samantha", "Montse"]);
  assert.equal(pickVoice("es", voices), "Mónica");
  assert.equal(pickVoice("ca", voices), "Montse");
  assert.equal(pickVoice("fr", voices), undefined, "falls back to the system default voice");
});

void test("narration is disabled off macOS, without say, or with MR_NARRATION=off", () => {
  assert.equal(loadNarrationConfig({}, "linux", () => true).enabled, false);
  assert.equal(loadNarrationConfig({}, "darwin", () => false).enabled, false);
  assert.equal(loadNarrationConfig({ MR_NARRATION: "off" }, "darwin", () => true).enabled, false);
  const enabled = loadNarrationConfig({ MR_NARRATION_RATE: "220", MR_NARRATION_VOICE: "Paulina" }, "darwin", () => true);
  assert.deepEqual(enabled, { enabled: true, rate: 220, voice: "Paulina" });
});

void test("the [▶ play] link plays only on click, requires the token, and stop interrupts", async () => {
  const fake = recorder();
  const service = new NarrationService({ config: { enabled: true, rate: 190 }, speak: fake.speak, listVoices: () => VOICES });
  try {
    assert.equal(await service.link("ok"), undefined, "short texts get no link");
    const link = await service.link(EXPLANATION, "es");
    assert.ok(link !== undefined);
    assert.match(link, /^\[▶ play\]\(http:\/\/127\.0\.0\.1:\d+\/n\/[a-f0-9]{16}\?k=[a-f0-9]{32}\)$/u);
    assert.equal(fake.calls.length, 0, "nothing plays before the click");
    const url = /\((.+)\)/u.exec(link)?.[1] ?? "";
    const forbidden = await fetch(url.replace(/k=[a-f0-9]+/u, "k=bad"));
    assert.equal(forbidden.status, 403);
    const played = await fetch(url);
    assert.equal(played.status, 200);
    assert.match(await played.text(), /Reproduciendo/u);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.voice, "Mónica");
    assert.doesNotMatch(fake.calls[0]?.text ?? "", /```/u);
    const stop = await fetch(url.replace(/\/n\/[a-f0-9]+/u, "/stop"));
    assert.equal(stop.status, 200);
    assert.equal(fake.killed(), 1);
    assert.equal(stripNarrationLink(`${EXPLANATION}\n\n${link}`), EXPLANATION);
  } finally {
    service.close();
  }
});

void test("plugin appends [▶ play] only in /task, /flow and /blueprint sessions and strips it from model history", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-narration-plugin-"));
  const fake = recorder();
  const narration = new NarrationService({ config: { enabled: true, rate: 190 }, speak: fake.speak, listVoices: () => VOICES });
  try {
    const paths = resolvePaths({ HOME: home });
    await seedModels(paths, process.cwd());
    const ctx = {
      client: {}, project: {}, directory: home, worktree: home,
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL("http://localhost"), $: {},
    } as unknown as PluginInput;
    const hooks = await createMrOrchestrator(ctx, paths, undefined, narration);
    const complete = hooks["experimental.text.complete"];
    const command = hooks["command.execute.before"];
    assert.ok(complete !== undefined && command !== undefined);
    const plain = { text: EXPLANATION };
    await complete({ sessionID: "s-work", messageID: "m", partID: "p" }, plain);
    assert.equal(plain.text, EXPLANATION, "no link outside narrated commands");
    for (const name of ["task", "flow", "blueprint"]) {
      await command({ command: name, sessionID: `s-${name}`, arguments: "cambia el banner de la página de inicio" }, { parts: [] });
      const output = { text: EXPLANATION };
      await complete({ sessionID: `s-${name}`, messageID: "m", partID: "p" }, output);
      assert.match(output.text, /\[▶ play\]\(http:\/\/127\.0\.0\.1/u, `/${name} gets a play link`);
    }
    const narrated = { text: EXPLANATION };
    await complete({ sessionID: "s-task", messageID: "m", partID: "p" }, narrated);
    const transform = hooks["experimental.chat.messages.transform"];
    assert.ok(transform !== undefined);
    const messages = [{ info: { role: "assistant", sessionID: "s-task" }, parts: [{ type: "text", text: narrated.text }] }];
    await transform({}, { messages } as unknown as Parameters<typeof transform>[1]);
    assert.equal(messages[0]?.parts[0]?.text, EXPLANATION, "the link never reaches the model");
    const playUrl = /\((http:[^)]+)\)/u.exec(narrated.text)?.[1] ?? "";
    await fetch(playUrl);
    assert.equal(fake.calls.at(-1)?.voice, "Mónica", "the developer's language picks the voice");
  } finally {
    narration.close();
    await rm(home, { recursive: true, force: true });
  }
});
