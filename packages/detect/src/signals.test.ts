import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCapabilities } from "./rules.js";
import { classifySignals, type DomObservation, type NetworkObservation } from "./signals.js";
import type { Signal } from "./types.js";

function assertEvidence(signals: Signal[], route: string): void {
  assert.ok(signals.length > 0);
  for (const signal of signals) {
    assert.ok(signal.evidence.length > 0, signal.id);
    for (const evidence of signal.evidence) {
      assert.equal(evidence.route, route, signal.id);
      assert.equal(evidence.summary.includes("?"), false, evidence.summary);
      assert.ok(evidence.id.startsWith(`route:${route}#${signal.id}:`), evidence.id);
    }
  }
}

test("table, add action, and dialog classify crud", () => {
  const route = "/users";
  const signals = classifySignals({
    route,
    dom: [
      { tag: "table", visible: true, name: "用户列表" },
      { tag: "button", visible: true, name: "添加用户" },
      { tag: "div", role: "dialog", visible: true, name: "创建用户" },
      { tag: "input", visible: true, inputType: "text", name: "邮箱" },
    ],
    network: [],
  });
  assert.deepEqual(
    signals.map((signal) => signal.id).sort(),
    ["dom.entity-actions", "dom.form-dialog", "dom.table"],
  );
  assert.equal(signals.find((signal) => signal.id === "dom.table")?.strength, 1);
  assert.equal(signals.find((signal) => signal.id === "dom.entity-actions")?.strength, 0.9);
  assert.equal(signals.find((signal) => signal.id === "dom.form-dialog")?.strength, 0.9);
  assertEvidence(signals, route);
  const result = evaluateCapabilities({ signals, surfaces: [{ route, elements: [] }] });
  assert.ok(result.capabilities.some((item) => item.id === "crud"));
});

test("message list, composer, and websocket classify realtime messaging", () => {
  const route = "/inbox";
  const signals = classifySignals({
    route,
    dom: [
      { tag: "div", role: "log", visible: true, ariaLabel: "消息" },
      { tag: "textarea", visible: true, name: "写一条消息" },
      { tag: "button", visible: true, name: "发送" },
    ],
    network: [
      {
        url: "wss://chat.example/socket?access_token=secret",
        method: "GET",
        resourceType: "websocket",
        websocket: true,
      },
    ],
  });
  assert.deepEqual(
    signals.map((signal) => signal.id).sort(),
    ["dom.message-composer", "dom.message-list", "network.websocket"],
  );
  assert.equal(signals.find((signal) => signal.id === "network.websocket")?.evidence[0]?.kind, "websocket");
  assert.equal(signals.find((signal) => signal.id === "network.websocket")?.strength, 1);
  assertEvidence(signals, route);
  const socket = signals.find((signal) => signal.id === "network.websocket");
  assert.equal(socket?.evidence[0]?.summary.includes("secret"), false);
  assert.match(socket?.evidence[0]?.summary ?? "", /wss:\/\/chat\.example\/socket$/);
  const result = evaluateCapabilities({ signals, surfaces: [{ route, elements: [] }] });
  assert.ok(result.capabilities.some((item) => item.id === "realtime-messaging"));
});

test("file input is a file signal", () => {
  const route = "/files";
  const signals = classifySignals({
    route,
    dom: [{ tag: "input", inputType: "file", visible: true, name: "附件" }],
    network: [],
  });
  assert.deepEqual(signals.map((signal) => signal.id), ["dom.file-input"]);
  assert.equal(signals[0]?.strength, 1);
  assertEvidence(signals, route);
});

test("upload control, status counter, and state actions are distinguished", () => {
  const route = "/tickets";
  const signals = classifySignals({
    route,
    dom: [
      { tag: "button", visible: true, name: "拖放现场图片或文档到这里 文件将从浏览器直传" },
      { tag: "div", role: "status", visible: true, name: "0 / 1000 characters" },
      { tag: "button", visible: true, name: "消息通知" },
      { tag: "button", visible: true, name: "取消工单" },
    ],
    network: [],
  });
  const ids = new Set(signals.map((signal) => signal.id));
  assert.ok(ids.has("dom.file-input"));
  assert.ok(ids.has("dom.state-actions"));
  assert.equal(ids.has("dom.status-column"), false);
  assert.equal(ids.has("dom.message-list"), false);
  assertEvidence(signals, route);
});

test("password field and login button are a login form", () => {  const route = "/account";
  const signals = classifySignals({
    route,
    dom: [
      { tag: "input", inputType: "password", visible: true, name: "密码" },
      { tag: "button", visible: true, name: "登录" },
    ],
    network: [],
  });
  assert.deepEqual(signals.map((signal) => signal.id), ["dom.login-form"]);
  assert.equal(signals[0]?.strength, 1);
  assertEvidence(signals, route);
});

test("login path is a login form without controls", () => {
  const signals = classifySignals({ route: "/login", dom: [], network: [] });
  assert.deepEqual(signals.map((signal) => signal.id), ["dom.login-form"]);
  assert.equal(signals[0]?.evidence[0]?.route, "/login");
});

test("no matching observations produce no signals", () => {
  const dom: DomObservation[] = [
    { tag: "p", visible: true, name: "欢迎" },
    { tag: "table", visible: false, name: "隐藏表格" },
  ];
  const network: NetworkObservation[] = [
    {
      url: "https://app.example/profile?upload=1&file=1&token=secret",
      method: "GET",
      resourceType: "fetch",
      status: 200,
    },
  ];
  assert.deepEqual(classifySignals({ route: "/home", dom, network }), []);
});

test("network evidence drops query strings", () => {
  const route = "/files";
  const signals = classifySignals({
    route,
    dom: [],
    network: [
      {
        url: "https://cdn.example/upload/file?token=secret",
        method: "POST",
        status: 201,
        resourceType: "fetch",
        contentType: "application/octet-stream",
      },
      {
        url: "https://cdn.example/api/blob?sig=1",
        method: "POST",
        resourceType: "xhr",
        contentType: "multipart/form-data; boundary=abc",
      },
    ],
  });
  const upload = signals.find((signal) => signal.id === "network.upload");
  assert.ok(upload);
  assert.equal(upload.strength, 0.8);
  assertEvidence([upload], route);
  for (const evidence of upload.evidence) {
    assert.equal(evidence.summary.includes("token"), false);
    assert.equal(evidence.summary.includes("sig"), false);
    assert.equal(evidence.kind, "network");
  }
});

test("multipart request content type is an upload even without a keyword path", () => {
  const route = "/api";
  const signals = classifySignals({
    route,
    dom: [],
    network: [
      {
        url: "https://api.example/v1/resources?token=secret",
        method: "POST",
        resourceType: "fetch",
        requestContentType: "multipart/form-data; boundary=abc",
      },
    ],
  });
  const upload = signals.find((signal) => signal.id === "network.upload");
  assert.ok(upload);
  assertEvidence([upload], route);
  for (const evidence of upload.evidence) {
    assert.equal(evidence.summary.includes("token"), false);
  }
});

test("remaining passive signals keep route and omit query", () => {
  const route = "/work";
  const signals = classifySignals({
    route,
    dom: [
      { tag: "a", visible: true, name: "角色管理" },
      { tag: "th", visible: true, name: "状态" },
      { tag: "button", visible: true, name: "审批通过" },
      { tag: "input", visible: true, inputType: "search", name: "搜索" },
      { tag: "a", visible: true, name: "下一页" },
      { tag: "div", visible: true, role: "polite", name: "正在生成" },
      { tag: "div", visible: true, name: "工具调用" },
      { tag: "div", visible: true, name: "参考资料" },
      { tag: "div", visible: true, contentEditable: true },
      { tag: "textarea", visible: true, name: "AI 助手" },
      { tag: "button", visible: true, name: "发送" },
    ],
    network: [
      {
        url: "https://api.example/v1/chat/completions?key=secret",
        method: "POST",
        resourceType: "fetch",
        contentType: "text/event-stream",
      },
      {
        url: "https://api.example/media/upload?token=secret",
        method: "POST",
        resourceType: "fetch",
        contentType: "multipart/form-data",
      },
    ],
  });
  const ids = new Set(signals.map((signal) => signal.id));
  for (const id of [
    "dom.role-menu",
    "dom.status-column",
    "dom.approval-actions",
    "dom.search-input",
    "dom.pagination",
    "dom.streaming-output",
    "dom.tool-call-block",
    "dom.citation-block",
    "dom.contenteditable",
    "dom.message-composer",
    "dom.agent-chat",
    "network.sse",
    "network.chat-completion",
    "network.upload",
  ]) {
    assert.ok(ids.has(id as Signal["id"]), id);
  }
  assert.equal(signals.find((signal) => signal.id === "network.sse")?.evidence[0]?.kind, "sse");
  assertEvidence(signals, route);
  const blob = signals.flatMap((signal) => signal.evidence.map((evidence) => evidence.summary)).join("\n");
  assert.equal(blob.includes("secret"), false);
  assert.equal(blob.includes("token"), false);
});
