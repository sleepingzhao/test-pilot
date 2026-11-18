import type { TestAssertion, TestIR, TestStep } from "@testpilot/test-ir";

const REALTIME_CONFIDENCE = 0.6;
const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MESSAGE_COUNT_MIN = 2;
const MESSAGE_COUNT_MAX = 5;
const DEFAULT_MESSAGE_COUNT = 3;

export const REALTIME_V7_4B_BLOCKER = "图片/重连（V7-4b 后续）";

const MAX_LENGTH_MIN = 10;
const MAX_LENGTH_MAX = 2000;
const DEFAULT_MAX_LENGTH = 200;

export type RealtimeProfile = {
  capabilities?: ReadonlyArray<{ id: string; confidence: number }>;
};

export type RealtimeContext = {
  pagePath?: string;
  composerTestId?: string;
  sendTestId?: string;
  listTestId?: string;
  wsUrlIncludes?: string;
  text?: string;
  messageCount?: number;
  maxLength?: number;
  overlongText?: string;
  senderActor?: string;
  receiverActor?: string;
  senderLoginSteps?: TestStep[];
  receiverLoginSteps?: TestStep[];
};

export type RealtimeScenarioKind = "text" | "dedupe" | "oversize" | "order";

export type RealtimeScenario = {
  id: string;
  kind: RealtimeScenarioKind;
  ir: TestIR;
};

export type RealtimePlan = {
  mechanism: "realtime-messaging";
  runnable: boolean;
  blockers: string[];
  scenarios: RealtimeScenario[];
};

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function realtimeConfidence(profile: RealtimeProfile): number | undefined {
  const scores = (profile.capabilities ?? [])
    .filter((capability) => capability.id === "realtime-messaging")
    .map((capability) => capability.confidence);
  if (scores.length === 0) return undefined;
  return Math.max(...scores);
}

function loginStepsCannotUseActor(steps: TestStep[] | undefined, label: string): string | undefined {
  if (!steps?.length) return undefined;
  if (steps.some((step) => step.actor)) {
    return `${label} loginSteps 不能设置 actor 字段`;
  }
  return undefined;
}

function stripActorFromLoginSteps(steps: TestStep[]): TestStep[] {
  return steps.map((step) => {
    if (!step.actor) return step;
    const { actor: _actor, ...rest } = step;
    return rest;
  });
}

function validateActorIds(sender: string, receiver: string): string[] {
  const blockers: string[] = [];
  if (!ACTOR_ID_PATTERN.test(sender)) {
    blockers.push(`senderActor "${sender}" 不符合安全 actor id 规则（小写字母、数字、连字符）`);
  }
  if (!ACTOR_ID_PATTERN.test(receiver)) {
    blockers.push(`receiverActor "${receiver}" 不符合安全 actor id 规则（小写字母、数字、连字符）`);
  }
  if (sender === receiver) {
    blockers.push("senderActor 与 receiverActor 不能相同");
  }
  return blockers;
}

function resolveMaxLength(ctx: RealtimeContext): { maxLength: number; blocker?: string } {
  const raw = ctx.maxLength;
  if (raw === undefined) return { maxLength: DEFAULT_MAX_LENGTH };
  if (!Number.isInteger(raw) || raw < MAX_LENGTH_MIN || raw > MAX_LENGTH_MAX) {
    return {
      maxLength: DEFAULT_MAX_LENGTH,
      blocker: `maxLength 必须在 ${MAX_LENGTH_MIN}–${MAX_LENGTH_MAX} 之间（当前 ${String(raw)}）`,
    };
  }
  return { maxLength: raw };
}

function resolveOverlongText(
  ctx: RealtimeContext,
  maxLength: number,
): { text: string; blocker?: string } {
  const override = present(ctx.overlongText);
  if (override !== undefined) {
    if (override.length <= maxLength) {
      return {
        text: override,
        blocker: `overlongText 长度必须大于 maxLength（${maxLength}）`,
      };
    }
    return { text: override };
  }
  return { text: "测".repeat(maxLength + 20) };
}

function resolveMessageCount(ctx: RealtimeContext): { count: number; blocker?: string } {
  const raw = ctx.messageCount;
  if (raw === undefined) return { count: DEFAULT_MESSAGE_COUNT };
  if (!Number.isInteger(raw) || raw < MESSAGE_COUNT_MIN || raw > MESSAGE_COUNT_MAX) {
    return {
      count: DEFAULT_MESSAGE_COUNT,
      blocker: `messageCount 必须在 ${MESSAGE_COUNT_MIN}–${MESSAGE_COUNT_MAX} 之间（当前 ${String(raw)}）`,
    };
  }
  return { count: raw };
}

function defaultLoginSteps(pagePath: string, openStepId: string): TestStep[] {
  return [{ id: openStepId, action: "navigate", path: pagePath }];
}

function textScenarioIr(
  id: string,
  sender: string,
  receiver: string,
  senderLogin: TestStep[],
  receiverLogin: TestStep[],
  composerTestId: string,
  sendTestId: string,
  listTestId: string,
  wsUrlIncludes: string,
  text: string,
): TestIR {
  const wsExpect = {
    direction: "sent" as const,
    contains: text,
    urlIncludes: wsUrlIncludes,
    timeoutMs: 5000,
  };
  const assertions: TestAssertion[] = [
    {
      id: "ws-sent",
      type: "event",
      provider: "ws",
      actor: sender,
      expect: { ...wsExpect, direction: "sent" },
      oracle: "human-approved",
    },
    {
      id: "ws-received",
      type: "event",
      provider: "ws",
      actor: receiver,
      expect: { ...wsExpect, direction: "received" },
      oracle: "human-approved",
    },
    {
      id: "ui-sender-list",
      type: "ui",
      actor: sender,
      target: { testId: listTestId },
      contains: text,
      oracle: "human-approved",
    },
    {
      id: "ui-receiver-list",
      type: "ui",
      actor: receiver,
      target: { testId: listTestId },
      contains: text,
      oracle: "human-approved",
    },
  ];
  return {
    id,
    version: 1,
    platform: "web",
    actors: [
      { id: sender, loginSteps: senderLogin },
      { id: receiver, loginSteps: receiverLogin },
    ],
    steps: [
      {
        id: "wait-composer",
        action: "wait",
        target: { testId: composerTestId },
        actor: sender,
      },
      {
        id: "fill-text",
        action: "fill",
        target: { testId: composerTestId },
        value: text,
        actor: sender,
      },
      {
        id: "send-message",
        action: "click",
        target: { testId: sendTestId },
        actor: sender,
      },
      {
        id: "wait-list",
        action: "wait",
        target: { testId: listTestId },
        actor: receiver,
      },
    ],
    assertions,
    policy: { screenshots: "on-failure" },
  };
}

function dedupeScenarioIr(
  id: string,
  sender: string,
  receiver: string,
  senderLogin: TestStep[],
  receiverLogin: TestStep[],
  composerTestId: string,
  sendTestId: string,
  listTestId: string,
  wsUrlIncludes: string,
  textBase: string,
  messageCount: number,
): TestIR {
  const steps: TestStep[] = [
    {
      id: "wait-composer",
      action: "wait",
      target: { testId: composerTestId },
      actor: sender,
    },
  ];
  const assertions: TestAssertion[] = [];

  for (let i = 1; i <= messageCount; i++) {
    const text = `${textBase}-${i}`;
    steps.push({
      id: `fill-${i}`,
      action: "fill",
      target: { testId: composerTestId },
      value: text,
      actor: sender,
    });
    steps.push({
      id: `send-${i}`,
      action: "click",
      target: { testId: sendTestId },
      actor: sender,
    });

    const wsBase = {
      contains: text,
      urlIncludes: wsUrlIncludes,
      minCount: 1,
      maxCount: 1,
      timeoutMs: 5000,
    };
    assertions.push({
      id: `ws-sent-${i}`,
      type: "event",
      provider: "ws",
      actor: sender,
      expect: { ...wsBase, direction: "sent" },
      oracle: "human-approved",
    });
    assertions.push({
      id: `ws-received-${i}`,
      type: "event",
      provider: "ws",
      actor: receiver,
      expect: { ...wsBase, direction: "received" },
      oracle: "human-approved",
    });
    assertions.push({
      id: `ui-sender-list-${i}`,
      type: "ui",
      actor: sender,
      target: { testId: listTestId },
      contains: text,
      oracle: "human-approved",
    });
    assertions.push({
      id: `ui-receiver-list-${i}`,
      type: "ui",
      actor: receiver,
      target: { testId: listTestId },
      contains: text,
      oracle: "human-approved",
    });
  }

  steps.push({
    id: "wait-list",
    action: "wait",
    target: { testId: listTestId },
    actor: receiver,
  });

  return {
    id,
    version: 1,
    platform: "web",
    actors: [
      { id: sender, loginSteps: senderLogin },
      { id: receiver, loginSteps: receiverLogin },
    ],
    steps,
    assertions,
    policy: { screenshots: "on-failure" },
  };
}

function orderScenarioIr(
  id: string,
  sender: string,
  receiver: string,
  senderLogin: TestStep[],
  receiverLogin: TestStep[],
  composerTestId: string,
  sendTestId: string,
  listTestId: string,
  wsUrlIncludes: string,
  textBase: string,
  messageCount: number,
): TestIR {
  const steps: TestStep[] = [
    {
      id: "wait-composer",
      action: "wait",
      target: { testId: composerTestId },
      actor: sender,
    },
  ];
  const sequence: string[] = [];
  const assertions: TestAssertion[] = [];

  for (let i = 1; i <= messageCount; i++) {
    const text = `${textBase}-${i}`;
    sequence.push(text);
    steps.push({
      id: `fill-${i}`,
      action: "fill",
      target: { testId: composerTestId },
      value: text,
      actor: sender,
    });
    steps.push({
      id: `send-${i}`,
      action: "click",
      target: { testId: sendTestId },
      actor: sender,
    });
    assertions.push({
      id: `ui-sender-list-${i}`,
      type: "ui",
      actor: sender,
      target: { testId: listTestId },
      contains: text,
      oracle: "human-approved",
    });
    assertions.push({
      id: `ui-receiver-list-${i}`,
      type: "ui",
      actor: receiver,
      target: { testId: listTestId },
      contains: text,
      oracle: "human-approved",
    });
  }

  steps.push({
    id: "wait-list",
    action: "wait",
    target: { testId: listTestId },
    actor: receiver,
  });

  const wsSequenceExpect = {
    sequence,
    urlIncludes: wsUrlIncludes,
    timeoutMs: 8000,
  };
  assertions.unshift(
    {
      id: "ws-received-sequence",
      type: "event",
      provider: "ws",
      actor: receiver,
      expect: { ...wsSequenceExpect, direction: "received" },
      oracle: "human-approved",
    },
    {
      id: "ws-sent-sequence",
      type: "event",
      provider: "ws",
      actor: sender,
      expect: { ...wsSequenceExpect, direction: "sent" },
      oracle: "human-approved",
    },
  );

  return {
    id,
    version: 1,
    platform: "web",
    actors: [
      { id: sender, loginSteps: senderLogin },
      { id: receiver, loginSteps: receiverLogin },
    ],
    steps,
    assertions,
    policy: { screenshots: "on-failure" },
  };
}

function oversizeScenarioIr(
  id: string,
  sender: string,
  receiver: string,
  senderLogin: TestStep[],
  receiverLogin: TestStep[],
  composerTestId: string,
  sendTestId: string,
  listTestId: string,
  wsUrlIncludes: string,
  overlongText: string,
): TestIR {
  const broadcastSnippet = overlongText.slice(0, 30);
  const assertions: TestAssertion[] = [
    {
      id: "ws-sender-error",
      type: "event",
      provider: "ws",
      actor: sender,
      expect: {
        contains: "too_long",
        direction: "received",
        urlIncludes: wsUrlIncludes,
        timeoutMs: 5000,
        minCount: 1,
      },
      oracle: "human-approved",
    },
    {
      id: "ws-receiver-absent",
      type: "event",
      provider: "ws",
      actor: receiver,
      expect: {
        contains: broadcastSnippet,
        direction: "received",
        urlIncludes: wsUrlIncludes,
        absent: true,
        timeoutMs: 3000,
      },
      oracle: "human-approved",
    },
    {
      id: "ui-sender-list",
      type: "ui",
      actor: sender,
      target: { testId: listTestId },
      contains: "消息过长",
      oracle: "human-approved",
    },
  ];
  return {
    id,
    version: 1,
    platform: "web",
    actors: [
      { id: sender, loginSteps: senderLogin },
      { id: receiver, loginSteps: receiverLogin },
    ],
    steps: [
      {
        id: "wait-composer",
        action: "wait",
        target: { testId: composerTestId },
        actor: sender,
      },
      {
        id: "fill-overlong",
        action: "fill",
        target: { testId: composerTestId },
        value: overlongText,
        actor: sender,
      },
      {
        id: "send-message",
        action: "click",
        target: { testId: sendTestId },
        actor: sender,
      },
      {
        id: "wait-list-sender",
        action: "wait",
        target: { testId: listTestId },
        actor: sender,
      },
      {
        id: "wait-list",
        action: "wait",
        target: { testId: listTestId },
        actor: receiver,
      },
    ],
    assertions,
    policy: { screenshots: "on-failure" },
  };
}

export function planRealtimeMessaging(profile: RealtimeProfile, ctx: RealtimeContext = {}): RealtimePlan {
  const pagePath = present(ctx.pagePath) ?? "/chat";
  const composerTestId = present(ctx.composerTestId) ?? "chat-composer";
  const sendTestId = present(ctx.sendTestId) ?? "chat-send";
  const listTestId = present(ctx.listTestId) ?? "chat-list";
  const wsUrlIncludes = present(ctx.wsUrlIncludes) ?? "/ws/chat";
  const text = present(ctx.text) ?? "测试消息";
  const sender = present(ctx.senderActor) ?? "sender";
  const receiver = present(ctx.receiverActor) ?? "receiver";

  const confidence = realtimeConfidence(profile);
  if (confidence === undefined || confidence < REALTIME_CONFIDENCE) {
    const reason =
      confidence === undefined
        ? "画像没有 realtime-messaging 能力（需要 confidence ≥ 0.6），不生成 IR"
        : `realtime-messaging 置信度 ${confidence} 低于 0.6，不生成 IR`;
    return { mechanism: "realtime-messaging", runnable: false, blockers: [reason], scenarios: [] };
  }

  const blockers: string[] = [];

  const senderLoginBlocker = loginStepsCannotUseActor(ctx.senderLoginSteps, "sender");
  if (senderLoginBlocker) blockers.push(senderLoginBlocker);
  const receiverLoginBlocker = loginStepsCannotUseActor(ctx.receiverLoginSteps, "receiver");
  if (receiverLoginBlocker) blockers.push(receiverLoginBlocker);

  blockers.push(...validateActorIds(sender, receiver));

  if (blockers.length > 0) {
    return { mechanism: "realtime-messaging", runnable: false, blockers, scenarios: [] };
  }

  const senderLogin = stripActorFromLoginSteps(
    ctx.senderLoginSteps?.length
      ? ctx.senderLoginSteps
      : defaultLoginSteps(pagePath, "sender-open"),
  );
  const receiverLogin = stripActorFromLoginSteps(
    ctx.receiverLoginSteps?.length
      ? ctx.receiverLoginSteps
      : defaultLoginSteps(pagePath, "receiver-open"),
  );

  const messageCountResult = resolveMessageCount(ctx);
  if (messageCountResult.blocker) {
    blockers.push(messageCountResult.blocker);
  }

  const maxLengthResult = resolveMaxLength(ctx);
  if (maxLengthResult.blocker) {
    blockers.push(maxLengthResult.blocker);
  }
  const overlongResult = resolveOverlongText(ctx, maxLengthResult.maxLength);
  if (overlongResult.blocker) {
    blockers.push(overlongResult.blocker);
  }

  blockers.push(REALTIME_V7_4B_BLOCKER);

  const scenarios: RealtimeScenario[] = [
    {
      id: "text",
      kind: "text",
      ir: textScenarioIr(
        "realtime-messaging-text",
        sender,
        receiver,
        senderLogin,
        receiverLogin,
        composerTestId,
        sendTestId,
        listTestId,
        wsUrlIncludes,
        text,
      ),
    },
  ];

  if (!messageCountResult.blocker) {
    scenarios.push({
      id: "dedupe",
      kind: "dedupe",
      ir: dedupeScenarioIr(
        "realtime-messaging-dedupe",
        sender,
        receiver,
        senderLogin,
        receiverLogin,
        composerTestId,
        sendTestId,
        listTestId,
        wsUrlIncludes,
        text,
        messageCountResult.count,
      ),
    });
    scenarios.push({
      id: "order",
      kind: "order",
      ir: orderScenarioIr(
        "realtime-messaging-order",
        sender,
        receiver,
        senderLogin,
        receiverLogin,
        composerTestId,
        sendTestId,
        listTestId,
        wsUrlIncludes,
        text,
        messageCountResult.count,
      ),
    });
  }

  if (!maxLengthResult.blocker && !overlongResult.blocker) {
    scenarios.push({
      id: "oversize",
      kind: "oversize",
      ir: oversizeScenarioIr(
        "realtime-messaging-oversize",
        sender,
        receiver,
        senderLogin,
        receiverLogin,
        composerTestId,
        sendTestId,
        listTestId,
        wsUrlIncludes,
        overlongResult.text,
      ),
    });
  }

  return { mechanism: "realtime-messaging", runnable: true, blockers, scenarios };
}