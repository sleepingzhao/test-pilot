import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { seedIfEmpty, syncCatalogTests } from "./seed.js";
import { FileStore } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot = join(repoRoot, "data");
const artifactsRoot = join(repoRoot, "artifacts");
const consoleDist = join(repoRoot, "apps/console/dist");

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(sensible);

const store = new FileStore(dataRoot);
await store.init();
const seeded = await seedIfEmpty(store);
if (seeded > 0) app.log.info(`Seeded ${seeded} demo tests`);

const synced = await syncCatalogTests(store);
if (synced > 0) app.log.info(`Synced ${synced} catalog tests`);

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
