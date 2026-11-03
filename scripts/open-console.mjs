#!/usr/bin/env node
/** Wait for API + UI, open browser, then stay alive (do not exit — avoids killing dev servers). */
const url = process.env.TESTPILOT_UI_URL ?? "http://127.0.0.1:5173";
const health = process.env.TESTPILOT_API_HEALTH ?? "http://127.0.0.1:8787/api/health";

async function waitFor(u, ms = 90000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(u);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`Timeout waiting for ${u}`);
}

await waitFor(health);
try {
  await waitFor(url, 60000);
} catch {
  console.warn(`UI not ready at ${url} — opening anyway`);
}

const { execSync } = await import("node:child_process");
const platform = process.platform;
const cmd =
  platform === "darwin" ? `open "${url}"` : platform === "win32" ? `start ${url}` : `xdg-open "${url}"`;
try {
  execSync(cmd, { stdio: "ignore" });
  console.log(`Opened ${url}`);
} catch {
  console.log(`Open in browser: ${url}`);
}

setInterval(() => {}, 1 << 30);
