import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasIndexer, getImpactAnalysis, type AtlasGraph } from "../src/core/atlas.js";

test("framework extractors add Symfony routes, Doctrine entities and CQRS relations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-framework-php-"));
  try {
    await mkdir(join(root, "repos", "api", "src"), { recursive: true });
    await mkdir(join(root, "repos", "api", "config", "doctrine"), { recursive: true });
    await writeFile(join(root, "repos", "api", "src", "Order.php"), `<?php
namespace App;
#[ORM\\Entity(repositoryClass: OrderRepository::class)]
class Order {}
class OrderRepository {}

class CreateOrderCommand {}

#[AsMessageHandler]
class CreateOrderHandler {
  public function __invoke(CreateOrderCommand $command): void {}
}

#[Route('/api/orders')]
class OrderController {}
`);
    await writeFile(join(root, "repos", "api", "config", "services.yaml"), "services:\n  App\\CreateOrderHandler:\n  App\\OrderRepository:\n");
    await writeFile(join(root, "repos", "api", "config", "doctrine", "Legacy.xml"), "<doctrine-mapping><entity name=\"App\\LegacyOrder\" /></doctrine-mapping>\n");
    const graph = await new AtlasIndexer().indexWorkspace(root);
    const route = graph.nodes.find((node) => node.kind === "route" && node.name === "/api/orders");
    const entity = graph.nodes.find((node) => node.kind === "entity" && node.name === "Order");
    assert.ok(route);
    assert.ok(entity);
    assert.ok(graph.edges.some((edge) => edge.type === "route" && edge.to === route.id));
    assert.ok(graph.edges.some((edge) => edge.type === "entity" && edge.to === entity.id));
    assert.ok(graph.nodes.some((node) => node.kind === "entity" && node.name === "LegacyOrder"));
    assert.ok(graph.nodes.some((node) => node.kind === "contract" && node.name === "App\\CreateOrderHandler" && node.metadata["contractKind"] === "di-binding"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls"
      && graph.nodes.find((node) => node.id === edge.from)?.name === "CreateOrderHandler"
      && graph.nodes.find((node) => node.id === edge.to)?.name === "CreateOrderCommand"));
    assert.ok(graph.contracts?.some((contract) => contract.kind === "route" && contract.name === "/api/orders"));
    assert.equal(graph.coverage.semantic, "syntactic-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("framework extractors and contracts connect federation and HTTP consumers across repos", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-framework-contracts-"));
  try {
    await mkdir(join(root, "repos", "api", "src"), { recursive: true });
    await mkdir(join(root, "repos", "catalog", "src"), { recursive: true });
    await mkdir(join(root, "repos", "host", "src"), { recursive: true });
    await writeFile(join(root, "repos", "api", "src", "OrderController.php"), "<?php\n#[Route('/api/orders')]\nclass OrderController {}\n");
    await writeFile(join(root, "repos", "api", "src", "OrderControllerTest.php"), "<?php\nclass OrderControllerTest { public function testOrders(): void { OrderController(); } }\n");
    await writeFile(join(root, "repos", "host", "src", "client.ts"), "export async function loadOrders(){ return fetch('/api/orders'); }\n");
    await writeFile(join(root, "repos", "catalog", "src", "Widget.ts"), "export const Widget = 1;\n");
    await writeFile(join(root, "repos", "catalog", "vite.config.ts"), `import federation from "federation";
export default federation({ name: "catalog", exposes: { "./Widget": "./src/Widget.ts" } });
`);
    await writeFile(join(root, "repos", "host", "vite.config.ts"), `import federation from "federation";
export default federation({ name: "host", remotes: { catalog: "http://catalog/remoteEntry.js" } });
`);
    const graph = await new AtlasIndexer().indexWorkspace(root);
    const route = graph.nodes.find((node) => node.kind === "route" && node.name === "/api/orders");
    const client = graph.nodes.find((node) => node.kind === "module" && node.filePath === "repos/host/src/client.ts");
    assert.ok(route);
    assert.ok(client);
    assert.ok(graph.edges.some((edge) => edge.type === "consumes" && edge.from === client.id && edge.to === route.id));
    const controller = graph.nodes.find((node) => node.name === "OrderController" && node.kind === "class");
    assert.ok(controller);
    const impact = getImpactAnalysis(graph, controller.id, 1);
    assert.ok(impact.some((node) => node.filePath === "repos/host/src/client.ts"));
    assert.ok(impact.some((node) => node.filePath.endsWith("OrderControllerTest.php")));
    const exposed = graph.nodes.find((node) => node.kind === "federation-contract" && node.metadata["role"] === "expose");
    const remote = graph.nodes.find((node) => node.kind === "federation-contract" && node.metadata["role"] === "remote");
    assert.ok(exposed);
    assert.ok(remote);
    assert.ok(graph.edges.some((edge) => edge.type === "consumes" && edge.from === remote.id && edge.to === exposed.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontend extractors identify query keys, Redux slices, Zod schemas and app routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-framework-web-"));
  try {
    await mkdir(join(root, "apps", "web", "src"), { recursive: true });
    await mkdir(join(root, "apps", "web", "app", "users"), { recursive: true });
    await mkdir(join(root, "apps", "mobile", "app"), { recursive: true });
    await mkdir(join(root, "packages", "contracts", "src"), { recursive: true });
    await writeFile(join(root, "apps", "web", "src", "state.ts"), `import { z } from "zod";
export const UserSchema = z.object({ id: z.string() });
export const users = createSlice({ name: "users", initialState: [], reducers: {} });
export const loadUsersThunk = createAsyncThunk("users/load", async () => []);
export const selectUsers = createSelector((state) => state.users, (users) => users);
export function useUsers(){ return useQuery({ queryKey: ["users"], queryFn: loadUsers }); }
export function useSaveUser(){ return useMutation({ mutationKey: ["save-user"], mutationFn: saveUser }); }
`);
    await writeFile(join(root, "apps", "web", "app", "users", "page.tsx"), "export default function Page(){ return <main>Users</main>; }\n");
    await writeFile(join(root, "apps", "web", "app", "actions.ts"), "'use server';\nexport async function saveUser() {}\n");
    await writeFile(join(root, "apps", "mobile", "app", "profile.tsx"), "export default function Profile(){ return null; }\n");
    await writeFile(join(root, "packages", "contracts", "package.json"), JSON.stringify({ name: "@acme/contracts", exports: { ".": "./src/schema.ts" } }));
    await writeFile(join(root, "packages", "contracts", "src", "schema.ts"), "import { z } from 'zod';\nexport const SharedSchema = z.object({ id: z.string() });\n");
    await writeFile(join(root, "packages", "contracts", "src", "index.ts"), "export { SharedSchema } from './schema.js';\n");
    await writeFile(join(root, "apps", "web", "src", "shared.ts"), "import { SharedSchema } from '@acme/contracts';\nexport const parseShared = SharedSchema.parse;\n");
    await writeFile(join(root, "apps", "web", "src", "_tokens.scss"), "$brand: red;\n@mixin focus-ring { outline: 1px solid $brand; }\n");
    await writeFile(join(root, "apps", "web", "src", "button.scss"), "@use 'tokens';\n.button { color: $brand; @include focus-ring; }\n");
    const graph = await new AtlasIndexer().indexWorkspace(root);
    assert.ok(graph.nodes.some((node) => node.kind === "query-key" && node.name === "users"));
    assert.ok(graph.nodes.some((node) => node.kind === "query-key" && node.name === "save-user"));
    assert.ok(graph.nodes.some((node) => node.kind === "slice" && node.name === "users"));
    assert.ok(graph.nodes.some((node) => node.kind === "slice" && node.name === "loadUsersThunk"));
    assert.ok(graph.nodes.some((node) => node.kind === "function" && node.name === "selectUsers" && node.metadata["role"] === "selector"));
    assert.ok(graph.nodes.some((node) => node.kind === "contract" && node.name === "UserSchema"));
    assert.ok(graph.nodes.some((node) => node.kind === "route" && node.filePath.endsWith("app/users/page.tsx")));
    assert.ok(graph.nodes.some((node) => node.kind === "server-action" && node.name === "saveUser"));
    assert.ok(graph.nodes.some((node) => node.kind === "route" && node.filePath === "apps/mobile/app/profile.tsx"));
    assert.ok(graph.contracts?.some((contract) => contract.kind === "schema" && contract.name === "UserSchema"));
    const sharedModule = graph.nodes.find((node) => node.kind === "module" && node.filePath === "apps/web/src/shared.ts");
    const sharedSchema = graph.nodes.find((node) => node.kind === "contract" && node.name === "SharedSchema");
    assert.ok(sharedModule);
    assert.ok(sharedSchema);
    assert.ok(graph.edges.some((edge) => edge.type === "consumes" && edge.from === sharedModule.id && edge.to === sharedSchema.id));
    assert.ok(graph.edges.some((edge) => edge.type === "style-use"
      && graph.nodes.find((node) => node.id === edge.from)?.filePath.endsWith("button.scss")
      && ["brand", "focus-ring"].includes(graph.nodes.find((node) => node.id === edge.to)?.name ?? "")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("weighted impact traverses strong relations farther than weak imports", () => {
  const node = (id: string) => ({ id, name: id, kind: "function" as const, filePath: `${id}.ts`, line: 1, column: 0, exports: [], imports: [], dependencies: [], dependents: [], metadata: {} });
  const strongGraph: AtlasGraph = {
    schemaVersion: 2, generatedAt: "2026-09-13T00:00:00.000Z", workspaceRoot: "/repo",
    nodes: [node("target"), node("caller1"), node("caller2")],
    edges: [{ from: "caller1", to: "target", type: "calls" }, { from: "caller2", to: "caller1", type: "calls" }],
    files: [], coverage: { indexerVersion: "2.2.0", supportedLanguages: [], unsupportedFiles: [], parseErrors: [], unresolvedImports: [] },
    stats: { totalFiles: 0, totalNodes: 3, totalEdges: 2, indexDurationMs: 1 },
  };
  assert.deepEqual(getImpactAnalysis(strongGraph, "target", 1).map((item) => item.id), ["target", "caller1", "caller2"]);
  const weakGraph: AtlasGraph = { ...strongGraph, edges: strongGraph.edges.map((edge) => ({ ...edge, type: "import" as const })) };
  assert.deepEqual(getImpactAnalysis(weakGraph, "target", 1).map((item) => item.id), ["target", "caller1"]);
});
