import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { collectSystemProfile } from "./collector.js";

const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>采集夹具</title></head>
  <body>
    <table>
      <tr><th>名称</th><td>示例</td></tr>
    </table>
    <button type="button" onclick="window.__mutated=true">保存</button>
    <button type="button" onclick="window.__mutated=true">提交</button>
    <button type="button" onclick="window.__mutated=true">确认</button>
    <button type="button" onclick="window.__mutated=true">确定</button>
    <button type="button" onclick="window.__mutated=true">删除</button>
    <button type="button" onclick="window.__mutated=true">移除</button>
    <button type="button" onclick="window.__mutated=true">save</button>
    <button type="button" onclick="window.__mutated=true">submit</button>
    <button type="button" onclick="window.__mutated=true">confirm</button>
    <button type="button" onclick="window.__mutated=true">delete</button>
    <button type="button" onclick="window.__mutated=true">remove</button>
    <button type="button" onclick="window.__mutated=true">确认提交</button>
    <button type="button" onclick="window.__opened=true">添加</button>
    <form hidden>
      <label>邮箱 <input name="email" /></label>
      <button type="submit">保存</button>
    </form>
    <input type="file" aria-label="附件" style="display:block;width:240px;height:24px" />
  </body>
</html>`;

test("collects crud signals from a local page without mutating it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(FIXTURE, { waitUntil: "domcontentloaded" });
    const profile = await collectSystemProfile(page, { maxRoutes: 1 });
    assert.ok(profile.surfaces.length >= 1);
    const ids = new Set(profile.signals.map((signal) => signal.id));
    assert.ok(ids.has("dom.table"), [...ids].join(","));
    assert.ok(ids.has("dom.entity-actions"), [...ids].join(","));
    assert.ok(ids.has("dom.file-input"), [...ids].join(","));
    assert.ok(profile.capabilities.some((item) => item.id === "crud"));
    assert.ok(Array.isArray(profile.questions));
    assert.equal(profile.target.mode, "passive");
    assert.equal(profile.version, 1);
    assert.equal(await page.evaluate("window.__opened === true"), true);
    const mutated = await page.evaluate("window.__mutated === true");
    assert.equal(mutated, false);
  } finally {
    await browser.close();
  }
});

test("does not click a default submit button inside a form", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!DOCTYPE html><html><body>
        <form onsubmit="window.__submitted=true; return false;">
          <button>添加</button>
        </form>
      </body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    await collectSystemProfile(page, { maxRoutes: 1, settleMs: 50 });
    assert.equal(await page.evaluate("window.__submitted === true"), false);
  } finally {
    await browser.close();
  }
});

test("does not click a default submit cancel button inside a dialog", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!DOCTYPE html><html><body>
        <button type="button" onclick="document.getElementById('dlg').hidden=false; window.__opened=true">添加</button>
        <div id="dlg" role="dialog" hidden>
          <form onsubmit="window.__submitted=true; return false;">
            <input name="email" />
            <button>取消</button>
          </form>
        </div>
      </body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    await collectSystemProfile(page, { maxRoutes: 1, settleMs: 50 });
    assert.equal(await page.evaluate("window.__opened === true"), true);
    assert.equal(await page.evaluate("window.__submitted === true"), false);
  } finally {
    await browser.close();
  }
});
