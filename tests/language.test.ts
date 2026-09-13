import { test } from "bun:test";
import assert from "node:assert/strict";
import { detectLanguage, normalizeUserLanguage } from "../src/core/language.js";

const CASES = [
  ["Fix the broken login redirect", "en"],
  ["Add validation to the endpoint", "en"],
  ["Update a shared library and its consumers", "en"],
  ["Refactor the selector while preserving memoization", "en"],
  ["Change a component prop without breaking clients", "en"],
  ["Rotate refresh tokens and preserve existing behavior", "en"],
  ["Implement this task with tests", "en"],
  ["Show the current progress and spend", "en"],
  ["The user should see an error", "en"],
  ["Keep the public contract unchanged", "en"],
  ["Corrige el estado de carga del formulario", "es"],
  ["Añade una consulta conservando las convenciones", "es"],
  ["Actualiza una librería compartida y sus consumidores", "es"],
  ["Implementar todo esto por favor", "es"],
  ["Termina con la implementación restante", "es"],
  ["Haz un plan muy bien detallado", "es"],
  ["El usuario debe ver el error", "es"],
  ["Añade pruebas para esta tarea", "es"],
  ["Corrige la invalidación después de guardar", "es"],
  ["Mantén el contrato sin cambios", "es"],
  ["Corrija o redirecionamento de login quebrado", "pt"],
  ["Adicione testes para o usuário", "pt"],
  ["Corregeix la redirecció d'inici de sessió", "ca"],
  ["Afegeix proves per aquesta tasca", "ca"],
  ["Corrigez la redirection de connexion cassée", "fr"],
  ["Ajoutez des tests pour cette tâche", "fr"],
] as const;

for (const [text, expected] of CASES) {
  test(`detectLanguage: ${text}`, () => {
    assert.equal(detectLanguage(text), expected);
  });
}

test("detectLanguage falls back to Spanish and can preserve an explicit prior language", () => {
  assert.equal(detectLanguage("JWT-204"), "es");
  assert.equal(detectLanguage("JWT-204", "en"), "en");
  assert.equal(normalizeUserLanguage("unsupported", "fr"), "fr");
});
