#!/usr/bin/env node
/**
 * Static demo + mock APIs for the practice environment.
 * File uploads stay in memory (POST/GET/DELETE /api/files). Nothing is written to disk.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Busboy from "busboy";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const MAX_FILE_BYTES = 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function mediaType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function envFlag(name) {
  return process.env[name] === "1";
}

function readMultipartFile(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: { files: 1, fileSize: MAX_FILE_BYTES + 1, fields: 20, parts: 20 },
      });
    } catch {
      req.resume();
      reject(new Error("invalid_multipart"));
      return;
    }

    let settled = false;
    const pending = [];
    /** @type {{ filename: string, mimeType: string, bytes: Buffer } | undefined} */
    let file;

    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    }

    parser.on("file", (_field, stream, info) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      pending.push(
        new Promise((done, fail) => {
          stream.on("end", () => {
            file = {
              filename: String(info.filename ?? ""),
              mimeType: String(info.mimeType ?? ""),
              bytes: Buffer.concat(chunks),
            };
            done();
          });
          stream.on("error", fail);
        }),
      );
    });
    parser.on("error", (err) => finish(err instanceof Error ? err : new Error("invalid_multipart")));
    parser.on("finish", () => {
      Promise.all(pending).then(() => finish(undefined, file), (err) => finish(err));
    });
    req.on("error", (err) => finish(err instanceof Error ? err : new Error("invalid_multipart")));
    req.pipe(parser);
  });
}

async function handleFileUpload(req, res, files) {
  let uploaded;
  try {
    uploaded = await readMultipartFile(req);
  } catch {
    sendJson(res, 400, { error: "invalid_multipart" });
    return;
  }
  if (!uploaded || !uploaded.filename.trim()) {
    sendJson(res, 400, { error: "invalid_multipart" });
    return;
  }
  if (uploaded.bytes.length > MAX_FILE_BYTES) {
    sendJson(res, 413, { error: "payload_too_large" });
    return;
  }
  const type = mediaType(uploaded.mimeType);
  if (!ALLOWED_FILE_TYPES.has(type)) {
    if (!envFlag("DEMO_FILES_ACCEPT_INVALID")) {
      sendJson(res, 415, { error: "unsupported_type" });
      return;
    }
  }
  if (envFlag("DEMO_FILES_REJECT_VALID")) {
    sendJson(res, 500, { error: "injected_failure" });
    return;
  }
  const name = uploaded.filename.split(/[/\\]/).pop() || uploaded.filename;
  const id = randomUUID();
  const stored = { id, name, type: type || uploaded.mimeType, size: uploaded.bytes.length, bytes: uploaded.bytes };
  files.set(id, stored);
  sendJson(res, 201, {
    id,
    name,
    type: stored.type,
    size: stored.size,
    url: `/api/files/${id}/content`,
  });
}

function fileSummary(stored) {
  return {
    id: stored.id,
    name: stored.name,
    type: stored.type,
    size: stored.size,
    url: `/api/files/${stored.id}/content`,
  };
}

export function createDemoServer() {
  const knownEmails = new Set(["duplicate@example.com", "admin@example.com"]);
  const files = new Map();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && url.pathname === "/api/tickets") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const region = body.region;
      if (!Array.isArray(region) || region.length < 4) {
        sendJson(res, 400, { error: "missing_region" });
        return;
      }
      sendJson(res, 201, { ok: true, id: body.runRef ?? body.address ?? "ticket" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/users") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let email = "";
      try {
        email = String(JSON.parse(raw || "{}").email ?? "").trim();
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (!email) {
        sendJson(res, 400, { error: "missing_email" });
        return;
      }
      if (knownEmails.has(email)) {
        sendJson(res, 409, { error: "duplicate", email });
        return;
      }
      knownEmails.add(email);
      sendJson(res, 201, { ok: true, email });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/files") {
      await handleFileUpload(req, res, files);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/files") {
      sendJson(res, 200, { files: [...files.values()].map(fileSummary) });
      return;
    }

    const contentMatch = /^\/api\/files\/([^/]+)\/content$/.exec(url.pathname);
    if (contentMatch && req.method === "GET") {
      let id;
      try {
        id = decodeURIComponent(contentMatch[1]);
      } catch {
        sendJson(res, 400, { error: "invalid_id" });
        return;
      }
      const stored = files.get(id);
      if (!stored) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": stored.type,
        "Content-Length": String(stored.size),
      });
      res.end(stored.bytes);
      return;
    }

    const itemMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    if (itemMatch && req.method === "DELETE") {
      let id;
      try {
        id = decodeURIComponent(itemMatch[1]);
      } catch {
        sendJson(res, 400, { error: "invalid_id" });
        return;
      }
      if (!files.delete(id)) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path === "/files" || path === "/files/") path = "/files.html";
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
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const server = createDemoServer();
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    console.log(`demo-webapp http://127.0.0.1:${actual}`);
  });
}
