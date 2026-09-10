import type { ArchiveConfig, ArchiveStatus } from "../api/archive";

export interface RecordingSwitchState {
  enabled: boolean;
  ready: boolean;
  pending: boolean;
  error: string;
}

/** Immediate click feedback with ordered writes and the most recent intent. */
export class ArchiveRecordingSwitch {
  private state: RecordingSwitchState = { enabled: false, ready: false, pending: false, error: "" };
  private confirmed = false;
  private queued: ArchiveConfig | null = null;
  private revision = 0;
  private reading = false;
  private listeners = new Set<() => void>();
  private read: () => Promise<ArchiveStatus>;
  private write: (config: ArchiveConfig) => Promise<ArchiveStatus>;
  private unused: () => void;

  constructor(read: () => Promise<ArchiveStatus>, write: (config: ArchiveConfig) => Promise<ArchiveStatus>, unused = () => {}) {
    this.read = read;
    this.write = write;
    this.unused = unused;
  }

  getSnapshot = (): RecordingSwitchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); this.release(); };
  };

  private release(): void {
    queueMicrotask(() => {
      if (!this.listeners.size && !this.state.pending) this.unused();
    });
  }
  private update(patch: Partial<RecordingSwitchState>): void {
    const next = { ...this.state, ...patch };
    if (Object.keys(next).every(key => next[key as keyof RecordingSwitchState] === this.state[key as keyof RecordingSwitchState])) return;
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  dismissError = (): void => this.update({ error: "" });

  async refresh(): Promise<void> {
    if (this.reading || this.state.pending) return;
    this.reading = true;
    const revision = this.revision;
    try {
      const status = await this.read();
      // A poll started before a click must never undo the latest choice.
      if (revision === this.revision && !this.state.pending) {
        this.confirmed = status.status.enabled;
        this.update({ enabled: this.confirmed, ready: true });
      }
    } catch {
      // Background reads retry on the next poll; action failures are separate.
    } finally { this.reading = false; }
  }

  toggle(config: Omit<ArchiveConfig, "enabled">): void {
    if (!this.state.ready) return;
    this.revision++;
    const enabled = !this.state.enabled;
    this.queued = { ...config, enabled };
    this.update({ enabled, error: "" });
    if (!this.state.pending) void this.drain();
  }

  private async drain(): Promise<void> {
    this.update({ pending: true });
    try {
      while (this.queued) {
        const config = this.queued;
        this.queued = null;
        if (config.enabled === this.confirmed) continue;
        try {
          const status = await this.write(config);
          this.confirmed = status.status.enabled;
        } catch (e) {
          // A request may fail after changing state (for example during flush).
          try { this.confirmed = (await this.read()).status.enabled; } catch { /* retain last confirmation */ }
          if (!this.queued) this.update({ error: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.update({ enabled: this.confirmed, pending: false });
      this.release();
    }
  }
}
