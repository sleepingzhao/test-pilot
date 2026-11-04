import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { seedIfEmpty, syncCatalogTests, syncPilotCatalogTests } from "./seed.js";
import { bootstrapPilotIntakes } from "./bootstrap-pilot-intakes.js";
import { isPilotTest } from "./run-env.js";
import { assertSafeBindHost, corsOrigin, registerSecurity } from "./security.js";
import { FileStore } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot = join(repoRoot, "data");
const artifactsRoot = join(repoRoot, "artifacts");
const consoleDist = join(repoRoot, "apps/console/dist");

try {
  const { config } = await import("dotenv");
  config({ path: join(repoRoot, ".env") });
} catch {
  /* optional */
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

try {
  assertSafeBindHost(host);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const app = Fastify({ logger: true });
await app.register(cors, {
  origin: corsOrigin,
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-TestPilot-Token"],
});
await app.register(sensible);
registerSecurity(app);

const store = new FileStore(dataRoot);
await store.init();
const seeded = await seedIfEmpty(store);
if (seeded > 0) app.log.info(`Seeded ${seeded} demo tests`);

const synced = await syncCatalogTests(store);
if (synced > 0) app.log.info(`Synced ${synced} catalog tests`);

const pilotSynced = await syncPilotCatalogTests(store);
if (pilotSynced > 0) app.log.info(`Synced ${pilotSynced} pilot catalog tests`);

  void bootstrapPilotIntakes(store, app.log).then((n) => {
  if (n > 0) app.log.info(`Auto-generated ${n} pilot draft test(s) from presets`);
});

/** One-time style fix: pilot tests without approvedAt revert to draft (human gate). */
async function reconcilePilotDraftGate(store: FileStore): Promise<number> {
  const tests = await store.listTests();
  let n = 0;
  for (const t of tests) {
    const pilot = isPilotTest(t);
    if (!pilot || t.approvedAt) continue;
    if (t.approvalStatus === "draft") continue;
    await store.saveTest({ ...t, approvalStatus: "draft", updatedAt: new Date().toISOString() });
    n += 1;
  }
  return n;
}

const reconciled = await reconcilePilotDraftGate(store);
if (reconciled > 0) app.log.info(`Reverted ${reconciled} pilot test(s) to draft pending approval`);

registerRoutes(app, store, artifactsRoot, dataRoot);
await mkdir(artifactsRoot, { recursive: true });

if (existsSync(consoleDist)) {
  await app.register(fastifyStatic, { root: consoleDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.notFound();
    return reply.sendFile("index.html");
  });
} else {
  app.log.warn("Console not built — use `pnpm dev` (Vite on :5173) or build console");
}

await app.listen({ port, host });
console.log(`
╔══════════════════════════════════════════════════════════╗
║  TestPilot  →  http://${host}:${port}/                     ║
║  Demo app   →  http://127.0.0.1:4173                     ║
╚══════════════════════════════════════════════════════════╝
`);
