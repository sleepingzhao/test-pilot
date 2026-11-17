import type { Page } from "playwright";

type LiveEntry = { page: Page; startedAt: string };

const livePages = new Map<string, LiveEntry>();

export function registerRecordLivePage(jobId: string, page: Page): void {
  livePages.set(jobId, { page, startedAt: new Date().toISOString() });
}

export function clearRecordLivePage(jobId: string): void {
  livePages.delete(jobId);
}

export function getRecordLivePage(jobId: string): Page | null {
  return livePages.get(jobId)?.page ?? null;
}

export function resetRecordLivePagesForTest(): void {
  livePages.clear();
}