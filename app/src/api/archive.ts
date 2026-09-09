import { invoke } from "@tauri-apps/api/core";

export interface ArchiveConfig {
  enabled: boolean;
  cwd: string;
  roots: string[];
  title: string;
}
export interface ArchiveStatus {
  chatId: string;
  root: string;
  config: ArchiveConfig;
  status: {
    enabled: boolean;
    preparing: boolean;
    pendingBytes: number;
    writtenBytes: number;
    events: number;
    fileCount: number;
    fileBytes: number;
    lastSavedAt: number;
    error: string | null;
    coverageErrors: number;
  };
}
export interface ArchiveTurn {
  id: string;
  parentId: string | null;
  title: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  durationMs: number;
  waitingMs: number;
  status: string;
  model: string;
  cwd: string;
  identity: unknown;
  firstSeq: number;
  lastSeq: number;
  events: number;
  files: number;
  bytes: number;
  incomplete: boolean;
  starred: boolean;
  usage: unknown;
  engineDurationMs: number | null;
}
export interface ArchiveEntry {
  seq: number;
  at: number;
  source: string;
  kind: string;
  preview: string;
  turnId: string | null;
  payloadBytes: number;
  activity?: {
    operation: string;
    name: string;
    target: string;
    phase: string;
    toolId: string;
    error: boolean;
  };
  fileGroup?: { endSeq: number; count: number };
}
export interface ArchivePage<T> {
  items: T[];
  total: number;
  next: number | null;
}
export interface ArchiveSession {
  chatId: string;
  title: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  events: number;
  bytes: number;
  enabled: boolean;
  lastModel: string;
}
export function archiveSessions(
  offset = 0,
  query = "",
): Promise<ArchivePage<ArchiveSession> & { root: string }> {
  return archiveCall("sessions", { offset, query });
}
export interface PayloadPage {
  text: string;
  totalBytes: number;
  next: number | null;
}
export interface ObjectPage {
  hash: string;
  text: string | null;
  binary: boolean;
  totalBytes: number;
  next: number | null;
}
export async function archiveCall<T>(
  channel: string,
  argument: Record<string, unknown> = {},
): Promise<T> {
  const result = await invoke<
    T & { ok?: boolean; error?: string; __unimplemented?: boolean }
  >("ipc_call", { channel: `archive:${channel}`, payload: [argument] });
  if (!result || result.__unimplemented)
    throw new Error("대화 기록 기능을 사용할 수 없는 앱 버전입니다.");
  if (result.ok === false)
    throw new Error(result.error || "기록을 처리하지 못했습니다.");
  return result;
}
export function archiveStatus(chatId: string): Promise<ArchiveStatus> {
  return archiveCall("status", { chatId });
}
export function archiveConfigure(
  chatId: string,
  config: ArchiveConfig,
): Promise<ArchiveStatus> {
  return archiveCall("configure", { chatId, config });
}
export function archiveTurns(
  chatId: string,
  offset = 0,
): Promise<ArchivePage<ArchiveTurn>> {
  return archiveCall("turns", { chatId, offset });
}
export function archiveEntries(
  chatId: string,
  from = 1,
  source = "",
  turnId = "",
  query = "",
  to?: number,
): Promise<ArchivePage<ArchiveEntry>> {
  return archiveCall("entries", {
    chatId,
    from,
    source,
    turnId,
    query,
    limit: 60,
    ...(to == null ? {} : { to }),
  });
}
export function archivePayload(
  chatId: string,
  seq: number,
  offset = 0,
): Promise<PayloadPage> {
  return archiveCall("payload", { chatId, seq, offset });
}
export function archiveObject(
  chatId: string,
  hash: string,
  offset = 0,
): Promise<ObjectPage> {
  return archiveCall("object", { chatId, hash, offset });
}
export const formatArchiveBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
export const formatArchiveTime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
      : `${seconds}초`;
};
