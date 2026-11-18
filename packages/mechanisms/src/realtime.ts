import type { TestAssertion, TestIR, TestStep } from "@testpilot/test-ir";

const REALTIME_CONFIDENCE = 0.6;
const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const REALTIME_V7_4B_BLOCKER = "图片/超长/重连/顺序/去重场景尚未实现（V7-4b）";

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
  senderActor?: string;
  receiverActor?: string;
  senderLoginSteps?: TestStep[];
  receiverLoginSteps?: TestStep[];
};

export type RealtimeScenarioKind = "text";

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

  return { mechanism: "realtime-messaging", runnable: true, blockers, scenarios };
}