import { useEffect, useRef, useState } from "react";
import {
  archiveCall,
  archiveConfigure,
  archiveStatus,
  type ArchiveStatus,
} from "../api/archive";
import { chatIdOfPanel } from "../lib/accounts";
import { t, useLang } from "../lib/i18n";
import { IconAlert } from "./icons";

export function RecordingChip({
  chatId,
  panelId,
  cwd,
  refDirs = [],
  title = "",
  onOpen,
}: {
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
  const [state, setState] = useState<ArchiveStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    setResolved("");
    if (!chatId && panelId)
      void archiveCall<{ chatId: string }>("resolve", { panelId })
        .then((r) => {
          if (alive) setResolved(r.chatId);
        })
        .catch((e) => {
          if (alive) setError(String(e.message || e));
        });
    return () => {
      alive = false;
    };
  }, [chatId, panelId]);
  useEffect(() => {
    const gen = ++generation.current;
    setState(null);
    setError("");
    setPending(false);
    if (id)
      void archiveStatus(id)
        .then((s) => {
          if (generation.current === gen) setState(s);
        })
        .catch((e) => {
          if (generation.current === gen) setError(String(e.message || e));
        });
    return () => {
      generation.current++;
    };
  }, [id]);
  useEffect(() => {
    if (!id || !(state?.status.enabled || pending)) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void archiveStatus(id)
        .then((s) => {
          if (alive) setState(s);
        })
        .catch((e) => {
          if (alive) setError(String(e.message || e));
        });
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, state?.status.enabled, pending]);
  const toggle = async (): Promise<void> => {
    if (!id || !state || pending || state.status.preparing) return;
    const gen = generation.current;
    setPending(true);
    setError("");
    try {
      const next = await archiveConfigure(id, {
        enabled: !state?.status.enabled,
        cwd,
        roots: [cwd, ...refDirs].filter(Boolean),
        title,
      });
      if (gen === generation.current) setState(next);
    } catch (e) {
      if (gen === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === generation.current) setPending(false);
    }
  };
  if (!chatId && !panelId) return null;
  const problem = error || state?.status.error;
  const enabled = state?.status.enabled;
  const busy = pending || !!state?.status.preparing;
  const hint =
    problem ||
    (busy
      ? enabled
        ? t("기록을 마무리하고 있습니다.", "Finishing recording.")
        : t(
            "기존 파일을 보관한 뒤 기록을 시작합니다.",
            "Saving initial files before recording starts.",
          )
      : enabled
        ? t("눌러서 기록 끄기", "Click to stop recording")
        : t("눌러서 기록 켜기", "Click to start recording"));
  return (
    <span
      className="hfold archive-chip-wrap"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className={
          "ma-p-folder archive-chip has-tip tip-wrap" +
          (enabled ? " recording" : "") +
          (problem ? " error" : "")
        }
        data-tip={hint}
        title={problem || undefined}
        aria-pressed={!!enabled}
        aria-busy={busy}
        aria-label={t("대화 자동 기록", "Automatic conversation recording")}
        disabled={!id || !state || busy}
        onClick={() => {
          onOpen?.();
          void toggle();
        }}
      >
        {problem ? (
          <IconAlert size={11} />
        ) : (
          <span className={"archive-record-dot" + (enabled ? " on" : "")} />
        )}
        <span>
          {busy
            ? enabled
              ? t("기록 중지 중", "Stopping")
              : t("기록 준비 중", "Preparing")
            : enabled
              ? t("대화 기록중", "Recording conversation")
              : t("대화 기록", "Archive")}
        </span>
      </button>
    </span>
  );
}
