import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { archiveCall, archiveConfigure, archiveStatus } from "../api/archive";
import { ArchiveRecordingSwitch } from "../lib/archiveRecordingSwitch";
import { chatIdOfPanel } from "../lib/accounts";
import { t, useLang } from "../lib/i18n";
import { IconX2 } from "./icons";

const switches = new Map<string, ArchiveRecordingSwitch>();
function recordingSwitch(id: string): ArchiveRecordingSwitch {
  let value = switches.get(id);
  if (!value) {
    value = new ArchiveRecordingSwitch(
      () => archiveStatus(id),
      config => archiveConfigure(id, config),
      () => { if (switches.get(id) === value) switches.delete(id); },
    );
    switches.set(id, value);
  }
  return value;
}

export function RecordingChip({ chatId, panelId, cwd, refDirs = [], title = "", onOpen }: {
  chatId?: string;
  panelId?: string;
  cwd: string;
  refDirs?: string[];
  title?: string;
  onOpen?: () => void;
}) {
  useLang();
  const [resolved, setResolved] = useState("");
  const id = chatId || (panelId ? chatIdOfPanel(panelId) : "") || resolved;
  const control = useMemo(() => recordingSwitch(id), [id]);
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot);

  useEffect(() => {
    let alive = true;
    setResolved("");
    if (!chatId && panelId) void archiveCall<{ chatId: string }>("resolve", { panelId })
      .then(result => { if (alive) setResolved(result.chatId); })
      .catch(() => {});
    return () => { alive = false; };
  }, [chatId, panelId]);

  useEffect(() => {
    if (!id) return;
    void control.refresh();
    const timer = window.setInterval(() => { void control.refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [id, control]);

  if (!chatId && !panelId) return null;
  return <>
    <span className="hfold archive-chip-wrap" onMouseDown={event => event.stopPropagation()}>
      <button
        className={"ma-p-folder archive-chip" + (state.enabled ? " recording" : "")}
        aria-pressed={state.enabled}
        aria-busy={state.pending}
        aria-label={t("대화 자동 기록", "Automatic conversation recording")}
        disabled={!id || !state.ready}
        onClick={() => {
          onOpen?.();
          control.toggle({ cwd, roots: [cwd, ...refDirs].filter(Boolean), title });
        }}
      >
        <span className={"archive-record-dot" + (state.enabled ? " on" : "")} />
        <span>{t("대화 기록", "Archive")}</span>
        <span className="archive-record-state">{state.enabled ? "ON" : "OFF"}</span>
      </button>
    </span>
    {state.error && createPortal(
      <div className="archive-action-notice" role="alert">
        <div><strong>{t("기록 설정을 변경하지 못했습니다.", "Could not change recording.")}</strong><p>{state.error}</p></div>
        <button onClick={control.dismissError} aria-label={t("닫기", "Dismiss")}><IconX2 size={14} /></button>
      </div>, document.body,
    )}
  </>;
}
