import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildResolverContext, resolveJsSpecifier, resolvePhpClass } from "../src/core/atlas-resolve.js";

test("resolver reads inherited tsconfig paths and workspace package names", async () => {
  const files = ["tsconfig.base.json", "apps/web/tsconfig.json", "packages/ui/package.json"];
  const sources = new Map([
    ["tsconfig.base.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })],
    ["apps/web/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { baseUrl: "../.." } })],
    ["packages/ui/package.json", JSON.stringify({ name: "@acme/ui" })],
  ]);
  const context = await buildResolverContext(files, async (file) => sources.get(file));
  assert.ok(resolveJsSpecifier("@/domain/user", "apps/web/src/page.ts", context).includes("src/domain/user"));
  assert.ok(resolveJsSpecifier("@acme/ui/button", "apps/web/src/page.ts", context).includes("packages/ui/src/button"));
});

test("resolver maps PSR-4 class names", async () => {
  const sources = new Map([["composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } })]]);
  const context = await buildResolverContext(["composer.json"], async (file) => sources.get(file));
  assert.equal(resolvePhpClass("App\\Domain\\Order", context), "src/Domain/Order.php");
});
