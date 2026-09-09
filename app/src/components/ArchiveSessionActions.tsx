import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { IconAlert, IconPencil, IconTrash } from "./icons";

export type ArchiveAction = "rename" | "delete";

export function ArchiveSessionMenu({
  title,
  x,
  y,
  onAction,
  onClose,
}: {
  title: string;
  x: number;
  y: number;
  onAction: (action: ArchiveAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector("button")?.focus();
  }, [x, y]);
  useEffect(() => {
    const dismiss = (): void => close.current();
    const down = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [...(ref.current?.querySelectorAll("button") || [])];
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                items.length;
        items[next]?.focus();
      }
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu arc-session-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label={t("세션 메뉴", "Session menu")}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="cmh">{title}</div>
      <button
        className="ctx-item"
        role="menuitem"
        onClick={() => onAction("rename")}
      >
        <IconPencil size={15} />
        {t("이름 변경", "Rename")}
      </button>
      <div className="ctx-sep" />
      <button
        className="ctx-item danger"
        role="menuitem"
        onClick={() => onAction("delete")}
      >
        <IconTrash size={15} />
        {t("삭제", "Delete")}
      </button>
    </div>,
    document.body,
  );
}

export function ArchiveSessionActionDialog({
  action,
  title,
  onSubmit,
  onClose,
}: {
  action: ArchiveAction;
  title: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(title);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const id = useId();
  const renaming = action === "rename";
  const dismiss = (): void => {
    if (!busyRef.current) close.current();
  };
  useEffect(() => {
    if (input.current) {
      input.current.focus();
      input.current.select();
    } else ref.current?.querySelector<HTMLButtonElement>(".cancel")?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busyRef.current) close.current();
      } else if (event.key === "Tab") {
        const nodes = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled)",
          ) || []),
        ];
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  const submit = async (): Promise<void> => {
    if (busyRef.current) return;
    if (renaming && !name.trim()) {
      setError(t("이름을 입력해 주세요.", "Enter a name."));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
      close.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return createPortal(
    <div className="sconfirm arc-session-action" onMouseDown={dismiss}>
      <div
        ref={ref}
        className="sccard"
        role={renaming ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={busy}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={"scic" + (renaming ? " arc-rename-icon" : "")}>
          {renaming ? <IconPencil size={19} /> : <IconTrash size={19} />}
        </div>
        <div className="sctt" id={`${id}-title`}>
          {renaming
            ? t("세션 이름 변경", "Rename session")
            : t("보관된 세션 삭제", "Delete archived session")}
        </div>
        <div className="sct" id={`${id}-description`}>
          {renaming ? (
            t(
              "기록소에 표시할 이름을 입력해 주세요.",
              "Enter a name for this archived session.",
            )
          ) : (
            <>
              <strong className="arc-action-name">{title}</strong>
              {t(
                "이 세션의 보관 기록과 파일 사본을 삭제할까요? 되돌릴 수 없습니다.",
                "Delete this session's archived conversation and saved files? This cannot be undone.",
              )}
              <p>
                {t(
                  "기록 중이면 기록도 중지됩니다. 실제 작업 파일과 원래 채팅은 유지됩니다.",
                  "Recording will stop if active. Workspace files and the original chat will remain.",
                )}
              </p>
            </>
          )}
        </div>
        {renaming && (
          <input
            ref={input}
            className="pr-input arc-rename-input"
            aria-label={t("세션 이름", "Session name")}
            value={name}
            maxLength={200}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        )}
        {error && (
          <div className="fop-err" role="alert">
            <IconAlert size={14} />
            {error}
          </div>
        )}
        <div className="scb">
          <button className="cancel" disabled={busy} onClick={dismiss}>
            {t("취소", "Cancel")}
          </button>
          <button
            className={renaming ? "arc-action-save" : "danger"}
            disabled={busy || (renaming && !name.trim())}
            onClick={() => {
              void submit();
            }}
          >
            {busy
              ? t("처리 중…", "Working…")
              : renaming
                ? t("변경", "Rename")
                : t("삭제", "Delete")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
