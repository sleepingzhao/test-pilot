import type { DetectionReport } from "@testpilot/detect";
import { approvedTestsCoverCapability } from "./risk-report.js";
import type { StoredTest } from "./store.js";

export type ExplorationSuggestion = {
  id: string;
  kind: "unvisited-page" | "missing-scenario" | "unknown";
  title: string;
  route?: string;
  capabilityId?: string;
  why: string;
  testIdeas: string[];
};

/**
 * Advisory exploration hints only: nothing here creates, approves, or runs a test.
 * Sources: discovered-but-unvisited routes, uncovered capabilities, and open questions.
 */
export function buildExplorationSuggestions(
  profile: DetectionReport,
  tests: StoredTest[],
): ExplorationSuggestion[] {
  const suggestions: ExplorationSuggestion[] = [];

  for (const item of (profile.unvisited ?? []).slice(0, 10)) {
    suggestions.push({
      id: `explore-page-${item.route.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`,
      kind: "unvisited-page",
      title: `未访问页面：${item.route}`,
      route: item.route,
      why: "探测预算内没有打开该页面",
      testIdeas: [
        `只读打开 ${item.route}，记录列表/搜索/筛选/详情入口`,
        `确认该页面的空态与权限可见性，再决定是否补用例`,
      ],
    });
  }

  for (const capability of profile.capabilities) {
    if (capability.confidence < 0.7) continue;
    if (approvedTestsCoverCapability(capability.id, tests)) continue;
    suggestions.push({
      id: `explore-cap-${capability.id}`,
      kind: "missing-scenario",
      title: `补充场景：${capability.id}`,
      capabilityId: capability.id,
      why: "该能力置信度较高，但当前没有已批准用例覆盖",
      testIdeas: [
        ...(capability.testIdeas ?? []).slice(0, 3),
        ...capability.unknowns.slice(0, 2).map((unknown) => `先确认：${unknown}`),
      ].slice(0, 5),
    });
  }

  for (const question of profile.questions.slice(0, 8)) {
    suggestions.push({
      id: `explore-q-${question.id}`,
      kind: "unknown",
      title: `待确认：${question.question.slice(0, 100)}`,
      capabilityId: question.capability,
      route: question.routes[0],
      why: "画像里仍是未知项，建议先探索确认",
      testIdeas: question.routes.length
        ? [`只读打开 ${question.routes.join(" / ")}，观察相关入口与状态`]
        : ["只读探索相关页面，确认约束后再补用例"],
    });
  }

  return suggestions.slice(0, 20);
}
