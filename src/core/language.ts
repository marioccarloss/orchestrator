import { z } from "zod";

export const UserLanguageSchema = z.enum(["es", "en", "pt", "ca", "fr"]);
export type UserLanguage = z.infer<typeof UserLanguageSchema>;

export const DEFAULT_USER_LANGUAGE: UserLanguage = "es";

const LANGUAGE_PRIORITY: readonly UserLanguage[] = ["es", "en", "pt", "ca", "fr"];

const WORD_WEIGHTS: Readonly<Record<UserLanguage, Readonly<Record<string, number>>>> = {
  es: {
    el: 1, la: 1, los: 1, las: 1, un: 1, una: 1, de: 1, del: 2, para: 1, por: 1,
    con: 1, sin: 1, que: 1, este: 1, esta: 1, debe: 1, añade: 3, agregar: 2,
    corrige: 3, arregla: 3, actualiza: 3, implementa: 3, implementar: 3, manteniendo: 2,
    guardar: 2, después: 2, tarea: 2, pruebas: 2, usuario: 2, restante: 2, haz: 3,
  },
  en: {
    the: 2, a: 1, an: 1, and: 1, or: 1, to: 1, for: 1, from: 1, with: 1,
    without: 2, this: 1, that: 1, must: 2, should: 2, add: 3, fix: 3, update: 3,
    change: 3, refactor: 3, implement: 3, preserve: 3, keeping: 2, broken: 2,
    task: 2, tests: 2, user: 2, existing: 2, behavior: 2, show: 2, spend: 2,
  },
  pt: {
    o: 1, os: 1, as: 1, uma: 1, de: 1, do: 2, da: 2, para: 1, por: 1,
    com: 1, sem: 1, que: 1, este: 1, esta: 1, deve: 1, adicione: 3, adicionar: 3,
    corrija: 3, atualize: 3, implemente: 3, manter: 2, mantendo: 2, usuário: 3,
    tarefa: 2, testes: 2, quebrado: 2, comportamento: 2, não: 3,
  },
  ca: {
    el: 1, la: 1, els: 2, les: 2, una: 1, de: 1, del: 1, per: 2, amb: 3,
    sense: 3, que: 1, aquest: 3, aquesta: 3, ha: 1, afegeix: 3, corregeix: 3,
    actualitza: 3, implementa: 2, mantenint: 3, usuari: 3, tasca: 3, proves: 3,
    comportament: 3, inici: 2, sessió: 2,
  },
  fr: {
    le: 1, la: 1, les: 2, un: 1, une: 1, de: 1, du: 2, des: 2, pour: 2,
    par: 1, avec: 2, sans: 2, que: 1, cette: 2, doit: 2, ajoutez: 3,
    corrigez: 3, mettez: 3, implémentez: 3, conserver: 2, utilisateur: 3,
    tâche: 3, tests: 1, cassée: 3, comportement: 2, connexion: 2,
  },
};

function normalizeText(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .replace(/[’']/gu, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function orthographyScore(text: string, language: UserLanguage): number {
  switch (language) {
    case "es":
      return /[¿¡ñ]/u.test(text) ? 4 : 0;
    case "pt":
      return /[ãõ]/u.test(text) ? 4 : /\b(?:ção|ções)\b/iu.test(text) ? 3 : 0;
    case "ca":
      return /[·]/u.test(text) ? 5 : /\b\w*(?:eix|ix)\b/iu.test(text) ? 2 : 0;
    case "fr":
      return /\b(?:l|d|qu)[’']/iu.test(text) ? 2 : /[œ]/u.test(text) ? 4 : 0;
    case "en":
      return 0;
  }
}

/**
 * Detects the user's language without network or model calls. The optional
 * fallback lets later ticket content preserve a language already chosen from
 * the initial task when the new text is too short or mostly code identifiers.
 */
export function detectLanguage(text: string, fallback: UserLanguage = DEFAULT_USER_LANGUAGE): UserLanguage {
  const tokens = normalizeText(text);
  const scores = new Map<UserLanguage, number>();
  for (const language of LANGUAGE_PRIORITY) {
    const words = WORD_WEIGHTS[language];
    const wordScore = tokens.reduce((score, token) => score + (words[token] ?? 0), 0);
    scores.set(language, wordScore + orthographyScore(text, language));
  }

  const highest = Math.max(...scores.values());
  if (highest <= 0) return fallback;
  const winners = LANGUAGE_PRIORITY.filter((language) => scores.get(language) === highest);
  const firstWinner = winners[0];
  if (firstWinner === undefined) return fallback;
  return winners.length === 1 ? firstWinner : winners.includes(fallback) ? fallback : firstWinner;
}

export function normalizeUserLanguage(value: unknown, fallback: UserLanguage = DEFAULT_USER_LANGUAGE): UserLanguage {
  const parsed = UserLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
