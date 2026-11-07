import type { MechanismPack } from "./mechanism-types.js";

/**
 * Realtime messaging pack skeleton. Scenario/assertion shapes are the acceptance
 * contract; execution lands in V7 with the multi-actor runner and ws provider.
 */
export const realtimeMessagingPack: MechanismPack = {
  id: "realtime-messaging",
  capability: "realtime-messaging",
  requires: ["second-actor", "ws-observable"],
  scenarios: [
    {
      id: "text-delivery",
      title: "A 发送文本，B 收到同一条消息",
      parameters: ["marker", "conversation", "timeout"],
      evidence: ["ws-frame", "ui"],
      negativeProbeId: "block-delivery",
    },
    {
      id: "image-delivery",
      title: "A 发送图片，B 收到可渲染的消息",
      parameters: ["imageFixture", "conversation", "timeout"],
      evidence: ["http", "ws-frame", "ui"],
      negativeProbeId: "corrupt-file",
    },
    {
      id: "oversize-invariant",
      title: "超长消息不崩溃、不静默丢失，明确报错或完整送达",
      parameters: ["messageLength", "conversation", "timeout"],
      evidence: ["http", "ws-frame", "ui"],
      negativeProbeId: "block-delivery",
    },
    {
      id: "reconnect-no-loss",
      title: "B 断线重连后补齐消息且不重复",
      parameters: ["conversation", "timeout"],
      evidence: ["ws-frame", "ui"],
      negativeProbeId: "block-delivery",
    },
    {
      id: "ordering-dedup",
      title: "连续消息在 B 端的顺序与 A 一致且无重复",
      parameters: ["messageCount", "conversation", "timeout"],
      evidence: ["ws-frame", "ui"],
      negativeProbeId: "block-delivery",
    },
  ],
  assertions: [
    {
      id: "outbound-ws-frame",
      type: "event",
      provider: "ws-frames",
      evidence: "ws-frame",
      description: "A 的出站帧包含本次 run marker",
    },
    {
      id: "inbound-ws-frame",
      type: "event",
      provider: "ws-frames",
      evidence: "ws-frame",
      description: "B 的入站帧包含同一条消息",
    },
    {
      id: "recipient-dom",
      type: "ui",
      provider: "playwright-ui",
      evidence: "ui",
      description: "B 的消息列表出现该消息",
    },
    {
      id: "upload-api",
      type: "api",
      provider: "captured-http",
      evidence: "http",
      description: "图片上传接口返回成功且消息类型为 image",
    },
  ],
  negativeProbes: [
    {
      id: "block-delivery",
      description: "阻断 B 的入站投递，断言必须失败",
      break: "block-delivery",
    },
    {
      id: "corrupt-file",
      description: "上传损坏图片，图片断言必须失败",
      break: "corrupt-file",
    },
  ],
  safety: {
    mutation: "sandbox-only",
    maxActions: 20,
  },
};
