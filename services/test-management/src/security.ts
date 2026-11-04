import { timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DEMO_BASE_URL, pilotBaseUrl } from "./run-env.js";

const TEST_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeTestId(value: string): boolean {
  return TEST_ID_RE.test(value);
}

export function isSafeRunId(value: string): boolean {
  return RUN_ID_RE.test(value);
}

/** Artifact names are single path segments; no traversal, dotfiles, or separators. */
export function isSafeArtifactName(value: string): boolean {
  return ARTIFACT_NAME_RE.test(value) && value !== "." && value !== "..";
}

export function isWithin(root: string, target: string): boolean {
  const base = resolve(root);
  const next = resolve(target);
  return next === base || next.startsWith(base + sep);
}

/** Resolve a relative path inside root; absolute paths and ".." escapes return null. */
export function resolveWithin(root: string, relative: string): string | null {
  if (!relative || relative.includes("\0") || isAbsolute(relative)) return null;
  const next = resolve(root, relative);
  return isWithin(root, next) ? next : null;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

function splitEnvList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function allowedCorsOrigins(): Set<string> {
  const port = process.env.PORT?.trim() || "8787";
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  for (const origin of splitEnvList("TESTPILOT_ALLOWED_ORIGINS")) origins.add(origin);
  return origins;
}

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return allowedCorsOrigins().has(origin.replace(/\/$/, ""));
}

type CorsOriginValue = boolean | string | RegExp | CorsOriginValue[];

/** @fastify/cors origin callback. */
export function corsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allowed: CorsOriginValue) => void,
): void {
  callback(null, isAllowedCorsOrigin(origin));
}

function configuredTargetOrigins(): Set<string> {
  const origins = new Set<string>();
  const candidates = [DEMO_BASE_URL, pilotBaseUrl(), ...splitEnvList("TESTPILOT_ALLOWED_TARGETS")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      /* ignore malformed config */
    }
  }
  return origins;
}

/**
 * Only loopback targets, the configured pilot environment, and explicitly
 * allow-listed origins may be browsed/fetched by the server.
 */
export function isAllowedTargetUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (isLoopbackHost(url.hostname)) return true;
  return configuredTargetOrigins().has(url.origin);
}

export function apiToken(): string | undefined {
  const token = process.env.TESTPILOT_API_TOKEN?.trim();
  return token || undefined;
}

/** A non-loopback bind is refused unless an API token is configured. */
export function assertSafeBindHost(host: string): void {
  if (isLoopbackHost(host) || apiToken()) return;
  throw new Error(
    `Refusing to bind to non-loopback host "${host}" without TESTPILOT_API_TOKEN. ` +
      "Set TESTPILOT_API_TOKEN or use HOST=127.0.0.1.",
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestToken(req: FastifyRequest): string | undefined {
  const explicit = headerValue(req.headers["x-testpilot-token"]);
  if (explicit) return explicit;
  const authorization = headerValue(req.headers.authorization);
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || undefined;
  }
  return undefined;
}

function tokensEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Installs token auth (when configured) plus CSRF/Origin protection for writes. */
export function registerSecurity(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;

    const token = apiToken();
    if (token && req.url.startsWith("/api") && !req.url.startsWith("/api/health")) {
      const given = requestToken(req);
      if (!given || !tokensEqual(given, token)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    if (!SAFE_METHODS.has(req.method)) {
      const origin = headerValue(req.headers.origin);
      if (origin && !isAllowedCorsOrigin(origin)) {
        return reply.code(403).send({ error: "cross-origin request blocked" });
      }
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    if (req.url.startsWith("/api")) reply.header("Cache-Control", "no-store");
    return payload;
  });
}
