#!/usr/bin/env node
/**
 * Static demo + mock POST /api/users (design §8 API assertions in练习环境).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const knownEmails = new Set(["duplicate@example.com", "admin@example.com"]);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (req.method === "POST" && url.pathname === "/api/users") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let email = "";
    try {
      email = String(JSON.parse(raw || "{}").email ?? "").trim();
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
    if (!email) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing_email" }));
      return;
    }
    if (knownEmails.has(email)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "duplicate", email }));
      return;
    }
    knownEmails.add(email);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, email }));
    return;
  }

  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(root, path);
  try {
    const body = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`demo-webapp http://127.0.0.1:${port}`);
});
