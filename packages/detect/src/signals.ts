import type { EvidenceKind, Signal, SignalId } from "./types.js";

/** DOM facts the collector observed. Not part of the public profile contract. */
export type DomObservation = {
  tag: string;
  role?: string;
  name?: string;
  testId?: string;
  inputType?: string;
  ariaLabel?: string;
  placeholder?: string;
  contentEditable?: boolean;
  visible: boolean;
};

/** Network facts with query strings already removed. */
export type NetworkObservation = {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  contentType?: string;
  requestContentType?: string;
  websocket?: boolean;
};

export type ClassifySignalsInput = {
  route: string;
  dom: DomObservation[];
  network: NetworkObservation[];
};

const ENTITY_ACTION =
  /新增|添加|创建|编辑|修改|删除|移除|保存|\badd\b|\bcreate\b|\bedit\b|\bdelete\b|\bsave\b/i;
const STATE_ACTION =
  /取消工单|取消订单|关闭工单|关闭订单|撤回|归档|停用|启用|\barchive\b|\bdeactivate\b|\bactivate\b/i;
const STATUS_TEXT =
  /正常|待处理|处理中|进行中|已完成|已关闭|已取消|已超时|开启|关闭|启用|停用|pending|active|done|closed|canceled|cancelled|open|in.?progress/i;
const APPROVAL_ACTION = /审批|通过|驳回|同意|\bapprove\b|\breject\b/i;
const ROLE_MENU =
  /角色|权限|租户|组织|团队|\broles?\b|\bpermissions?\b|\btenants?\b|\bteams?\b/i;
const LOGIN_SUBMIT = /登录|登入|sign[\s-]?in|log[\s-]?in|\blogin\b|\bsubmit\b|^提交$/i;
const SEND_BUTTON = /发送|\bsend\b/i;
const SEARCH_TEXT = /搜索|\bsearch\b/i;
const PAGINATION = /上一页|下一页|页码|分页|pagination/i;
const STREAM_STOP = /停止生成|停止输出|stop generating|stop generation/i;
const TOOL_CALL = /工具调用|tool call|调用工具|function call/i;
const CITATION = /引用|来源|参考资料|\bcitation\b|\bsource\b/i;
const AGENT_LABEL = /助手|\bagent\b|\bassistant\b|(?:^|[^a-z])ai(?:[^a-z]|$)/i;
const CHAT_AREA = /消息|聊天|\bchat\b|\bmessages?\b/i;

/** origin + pathname only. Query, hash, and userinfo are dropped. */
export function normalizeNetworkUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return `${url.origin}${url.pathname}`;
  } catch {
    return trimmed.split("#")[0]?.split("?")[0] ?? trimmed;
  }
}

export function classifySignals(input: ClassifySignalsInput): Signal[] {
  const route = input.route;
  const dom = input.dom.filter((el) => el.visible);
  const network = input.network.map((item) => ({ ...item, url: normalizeNetworkUrl(item.url) }));
  const signals: Signal[] = [];

  const tables = dom.filter((el) => el.tag === "table" || el.role === "grid" || el.role === "table");
  push(signals, route, "dom.table", 1, "dom", tables.map((el) => named("可见表格", el)));

  const actions = dom.filter((el) => isAction(el) && ENTITY_ACTION.test(textOf(el)));
  push(signals, route, "dom.entity-actions", 0.9, "dom", actions.map((el) => named("可见实体操作", el)));

  const stateActions = dom.filter((el) => isAction(el) && STATE_ACTION.test(textOf(el)));
  push(signals, route, "dom.state-actions", 0.8, "dom", stateActions.map((el) => named("可见状态操作", el)));

  const fields = dom.filter(isFormControl);
  const dialogs = dom.filter((el) => el.role === "dialog" || el.tag === "dialog");
  const forms = dom.filter((el) => el.tag === "form" || el.role === "form");
  const meaningfulFields = fields.filter((el) => (el.inputType ?? "").toLowerCase() !== "search");
  if (meaningfulFields.length > 0 && (dialogs.length > 0 || forms.length > 0)) {
    push(
      signals,
      route,
      "dom.form-dialog",
      0.9,
      "dom",
      [...dialogs, ...forms].map((el) => named("可见表单", el)),
    );
  }

  const passwords = dom.filter((el) => el.tag === "input" && (el.inputType ?? "").toLowerCase() === "password");
  const loginButtons = dom.filter((el) => isLoginSubmit(el));
  const loginRoute = isLoginRoute(route);
  if ((passwords.length > 0 && loginButtons.length > 0) || loginRoute) {
    const summaries = [
      ...passwords.map(() => "可见密码输入"),
      ...loginButtons.map((el) => named("可见登录提交", el)),
    ];
    if (loginRoute) summaries.push("路径像登录页");
    push(signals, route, "dom.login-form", 1, "dom", summaries);
  }

  const menus = dom.filter((el) => isMenuLike(el) && ROLE_MENU.test(textOf(el)));
  push(signals, route, "dom.role-menu", 0.8, "dom", menus.map((el) => named("可见角色或租户入口", el)));

  const statusHeaders = dom.filter(
    (el) => (el.tag === "th" || el.role === "columnheader") && /状态|\bstatus\b/i.test(textOf(el)),
  );
  const statusBadges = dom.filter((el) => el.role === "status" && STATUS_TEXT.test(textOf(el)));
  push(
    signals,
    route,
    "dom.status-column",
    0.8,
    "dom",
    [...statusHeaders.map((el) => named("表头含状态", el)), ...statusBadges.map((el) => named("可见状态", el))],
  );

  const approvals = dom.filter((el) => isAction(el) && APPROVAL_ACTION.test(textOf(el)));
  push(signals, route, "dom.approval-actions", 0.9, "dom", approvals.map((el) => named("可见审批操作", el)));

  const messageLists = dom.filter(isMessageList);
  push(signals, route, "dom.message-list", 0.9, "dom", messageLists.map((el) => named("可见消息列表", el)));

  const composers = dom.filter(isComposer);
  const senders = dom.filter((el) => isAction(el) && SEND_BUTTON.test(textOf(el)));
  if (composers.length > 0 && senders.length > 0) {
    push(signals, route, "dom.message-composer", 0.9, "dom", [
      ...composers.map((el) => named("可见消息输入区", el)),
      ...senders.map((el) => named("可见发送按钮", el)),
    ]);
  }

  const files = dom.filter((el) => isFileInput(el) || isUploadControl(el));
  push(signals, route, "dom.file-input", 1, "dom", files.map((el) => named("可见文件选择或上传控件", el)));

  const searches = dom.filter(isSearchField);
  push(signals, route, "dom.search-input", 0.9, "dom", searches.map((el) => named("可见搜索框", el)));

  const pages = dom.filter((el) => PAGINATION.test(textOf(el)) || PAGINATION.test(el.ariaLabel ?? ""));
  push(signals, route, "dom.pagination", 0.8, "dom", pages.map((el) => named("可见分页", el)));

  const liveRegions = dom.filter((el) => el.role === "polite");
  const stopButtons = dom.filter((el) => isAction(el) && STREAM_STOP.test(textOf(el)));
  push(
    signals,
    route,
    "dom.streaming-output",
    0.7,
    "dom",
    [...liveRegions.map((el) => named("可见流式输出", el)), ...stopButtons.map((el) => named("可见停止生成", el))],
  );

  const tools = dom.filter((el) => TOOL_CALL.test(textOf(el)));
  push(signals, route, "dom.tool-call-block", 0.9, "dom", tools.map((el) => named("可见工具调用", el)));

  const citations = dom.filter((el) => CITATION.test(textOf(el)));
  push(signals, route, "dom.citation-block", 0.8, "dom", citations.map((el) => named("可见引用", el)));

  const editors = dom.filter((el) => el.contentEditable === true);
  push(signals, route, "dom.contenteditable", 0.7, "dom", editors.map((el) => named("可见富文本", el)));

  const chatSurface = dom.some(isChatSurface);
  const agentCue = liveRegions.length > 0 || tools.length > 0 || citations.length > 0 || stopButtons.length > 0;
  const agentFields = dom.filter((el) => (isComposer(el) || isSearchField(el) || el.tag === "input" || el.tag === "textarea") && AGENT_LABEL.test(textOf(el)));
  if ((chatSurface && agentCue) || agentFields.length > 0) {
    const summaries = [
      ...agentFields.map((el) => named("可见 Agent 输入区", el)),
      ...(chatSurface && agentCue ? ["可见聊天区与流式、工具或引用指示"] : []),
    ];
    push(signals, route, "dom.agent-chat", 0.8, "dom", summaries);
  }

  const sockets = network.filter((item) => item.websocket === true || item.resourceType === "websocket");
  push(
    signals,
    route,
    "network.websocket",
    1,
    "websocket",
    sockets.map((item) => `WebSocket ${item.url}`),
  );

  const streams = network.filter((item) => mediaType(item.contentType).includes("text/event-stream"));
  push(
    signals,
    route,
    "network.sse",
    1,
    "sse",
    streams.map((item) => `SSE ${item.method} ${item.url}`),
  );

  const uploads = network.filter(isUploadRequest);
  push(
    signals,
    route,
    "network.upload",
    0.8,
    "network",
    uploads.map((item) => `上传请求 ${item.method} ${item.url}`),
  );

  const chats = network.filter(isChatRequest);
  push(
    signals,
    route,
    "network.chat-completion",
    0.8,
    "network",
    chats.map((item) => `聊天补全请求 ${item.method} ${item.url}`),
  );

  return signals;
}

function push(
  out: Signal[],
  route: string,
  id: SignalId,
  strength: number,
  kind: EvidenceKind,
  summaries: string[],
): void {
  const unique = [...new Set(summaries.map((summary) => summary.trim()).filter(Boolean))].slice(0, 5);
  if (unique.length === 0) return;
  out.push({
    id,
    strength,
    evidence: unique.map((summary, index) => ({
      id: `route:${route}#${id}:${index}`,
      kind,
      summary,
      route,
    })),
  });
}

function textOf(el: DomObservation): string {
  return [el.name, el.ariaLabel, el.placeholder].filter(Boolean).join(" ");
}

function named(prefix: string, el: DomObservation): string {
  const name = (el.name ?? el.ariaLabel ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return name ? `${prefix}「${name}」` : prefix;
}

function isAction(el: DomObservation): boolean {
  return el.tag === "button" || el.tag === "a" || el.role === "button" || el.role === "link" || el.role === "menuitem";
}

function isMenuLike(el: DomObservation): boolean {
  return (
    el.tag === "a" ||
    el.tag === "nav" ||
    el.role === "link" ||
    el.role === "menuitem" ||
    el.role === "menu" ||
    el.role === "navigation" ||
    el.role === "tab"
  );
}

function isFormControl(el: DomObservation): boolean {
  if (el.contentEditable) return true;
  if (el.tag === "textarea" || el.tag === "select") return true;
  if (el.role === "combobox" || el.role === "checkbox" || el.role === "radio") return true;
  if (el.tag !== "input") return false;
  const inputType = (el.inputType ?? "text").toLowerCase();
  return !["hidden", "button", "submit", "reset", "image"].includes(inputType);
}

function isLoginSubmit(el: DomObservation): boolean {
  if ((el.inputType ?? "").toLowerCase() === "submit") return true;
  return isAction(el) && LOGIN_SUBMIT.test(textOf(el));
}

function isLoginRoute(route: string): boolean {
  return /(^|\/)(login|signin|sign-in)(\/|$)/i.test(route);
}

function isMessageList(el: DomObservation): boolean {
  if (el.role === "log") return true;
  if (el.tag === "button" || el.role === "button") return false;
  if (/消息|message/i.test(el.ariaLabel ?? "")) return true;
  const container = el.role === "list" || el.role === "feed" || el.tag === "ul" || el.tag === "ol";
  return container && CHAT_AREA.test(textOf(el));
}

function isChatSurface(el: DomObservation): boolean {
  if (el.role === "log" || el.role === "feed") return true;
  if (el.tag === "button" || el.role === "button") return false;
  if (/消息|聊天|\bchat\b|\bmessage/i.test(el.ariaLabel ?? "")) return true;
  return (el.role === "list" || el.tag === "section") && CHAT_AREA.test(textOf(el));
}

function isFileInput(el: DomObservation): boolean {
  return el.tag === "input" && (el.inputType ?? "").toLowerCase() === "file";
}

function isUploadControl(el: DomObservation): boolean {
  if (!/附件|上传|拖放.*文件|\bupload\b|\battachment\b/i.test(textOf(el))) return false;
  return el.role === "group" || isAction(el);
}

function isComposer(el: DomObservation): boolean {
  return el.tag === "textarea" || el.contentEditable === true;
}

function isSearchField(el: DomObservation): boolean {
  if ((el.inputType ?? "").toLowerCase() === "search" || el.role === "searchbox") return true;
  const field = el.tag === "input" || el.tag === "textarea" || el.role === "textbox";
  return field && SEARCH_TEXT.test(textOf(el));
}

function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isApiTraffic(item: NetworkObservation): boolean {
  return item.resourceType === "xhr" || item.resourceType === "fetch" || item.resourceType === "eventsource";
}

function isUploadRequest(item: NetworkObservation): boolean {
  if (!isApiTraffic(item)) return false;
  if (mediaType(item.requestContentType).includes("multipart/form-data")) return true;
  if (mediaType(item.contentType).includes("multipart/form-data")) return true;
  const path = requestPath(item.url);
  if (path.includes("upload") || path.includes("attachment")) return true;
  return /(^|\/)(file|files|media)(\/|$)/.test(path);
}

function isChatRequest(item: NetworkObservation): boolean {
  if (!isApiTraffic(item) || item.websocket) return false;
  const path = requestPath(item.url);
  if (path.includes("chat/completions") || path.includes("completions")) return true;
  return /(^|\/)(agent|assistant|llm)(\/|$)/.test(path);
}
