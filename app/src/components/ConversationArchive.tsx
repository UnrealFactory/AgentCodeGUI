import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveCall,
  archiveConfigure,
  archiveEntries,
  archiveObject,
  archivePayload,
  archiveStatus,
  archiveSessions,
  formatArchiveBytes,
  formatArchiveTime,
  type ArchiveEntry,
  type ArchivePage,
  type ArchiveStatus,
  type ArchiveSession,
  type ObjectPage,
  type PayloadPage,
} from "../api/archive";
import { t, useLang } from "../lib/i18n";
import { imageSrc } from "../lib/images";
import { Markdown } from "./Markdown";
import { MouseGestureLayer, scrollGestures } from "./mouseGesture";
import {
  ArchiveImportButton,
  ArchiveSessionActionDialog,
  ArchiveSessionMenu,
  type ArchiveAction,
} from "./ArchiveSessionActions";
import {
  IconAlert,
  IconBot,
  IconCheck,
  IconChevDown,
  IconClock,
  IconClose,
  IconCode,
  IconCopy,
  IconDownload,
  IconFile,
  IconFolder,
  IconMessage,
  IconRefresh,
  IconSearch,
  IconTerminal,
  IconUser,
} from "./icons";
import "./conversationArchive.css";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
const date = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
function contentText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => str(obj(c).text))
          .filter(Boolean)
          .join("\n\n")
      : "";
}
function textOf(p: Json): string {
  return (
    str(p.text) ||
    str(p.delta) ||
    contentText(obj(p.message).content) ||
    contentText(p.content) ||
    str(p.output) ||
    str(p.result)
  );
}

function FileSnapshot({
  chatId,
  hash,
  name,
  label,
}: {
  chatId: string;
  hash: string;
  name: string;
  label: string;
}) {
  const [page, setPage] = useState<ObjectPage | null>(null);
  const [history, setHistory] = useState<number[]>([0]);
  const [error, setError] = useState("");
  const [image, setImage] = useState("");
  const [loading, setLoading] = useState(false);
  const offset = history[history.length - 1];
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void archiveObject(chatId, hash, offset)
      .then((p) => {
        if (alive) setPage(p);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chatId, hash, offset]);
  const open = async (): Promise<void> => {
    try {
      const result = await archiveCall<{ path: string }>("materialize", {
        chatId,
        hash,
        name,
      });
      if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name))
        setImage(imageSrc(result.path));
      else await window.api.revealPath("", result.path);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="arc-snapshot">
      <div className="arc-snapshot-head">
        <b>{label}</b>
        <span>{page ? formatArchiveBytes(page.totalBytes) : ""}</span>
        <button
          className="arc-text-button"
          onClick={() => {
            void open();
          }}
        >
          {/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
            ? t("이미지 보기", "View image")
            : t("사본 위치 열기", "Reveal saved copy")}
        </button>
      </div>
      {error && (
        <p className="arc-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="arc-muted">{t("읽는 중…", "Loading…")}</p>
      ) : image ? (
        <img src={image} className="arc-image" alt={name} />
      ) : page?.binary ? (
        <p className="arc-muted">
          {t(
            "바이너리 원본이 보관되어 있습니다. 사본을 열어 확인할 수 있어요.",
            "The original binary file is saved. Open a copy to view it.",
          )}
        </p>
      ) : (
        <pre>{page?.text}</pre>
      )}
      {(history.length > 1 || page?.next != null) && (
        <div className="arc-page-controls">
          <button
            disabled={history.length <= 1 || loading}
            onClick={() => setHistory((h) => h.slice(0, -1))}
          >
            {t("이전 부분", "Previous")}
          </button>
          <span>
            {formatArchiveBytes(offset)} /{" "}
            {formatArchiveBytes(page?.totalBytes || 0)}
          </span>
          <button
            disabled={page?.next == null || loading}
            onClick={() => {
              if (page?.next != null) setHistory((h) => [...h, page.next!]);
            }}
          >
            {t("다음 부분", "Next")}
          </button>
        </div>
      )}
    </section>
  );
}

function EventBody({
  chatId,
  entry,
  payload,
  raw,
}: {
  chatId: string;
  entry: ArchiveEntry;
  payload: Json;
  raw: boolean;
}) {
  const [snapshots, setSnapshots] = useState(false);
  if (raw)
    return <pre className="arc-raw">{JSON.stringify(payload, null, 2)}</pre>;
  if (
    entry.source === "file" &&
    (entry.kind === "file-version" || entry.kind === "file-reference")
  ) {
    const before = obj(payload.before),
      after = obj(payload.after),
      path = str(payload.path);
    return (
      <div>
        <p className="arc-file-path">{path}</p>
        <div className="arc-file-versions">
          <span>
            {{
              created:
                payload.origin === "filesystem"
                  ? t("생성 감지", "Creation detected")
                  : t("원본 보관", "Original saved"),
              referenced: t("참조·첨부", "Referenced / attached"),
              modified: t("수정", "Modified"),
              deleted: t("삭제", "Deleted"),
            }[str(payload.change)] || str(payload.change)}
          </span>
          <span>
            {before.hash ? formatArchiveBytes(Number(before.bytes)) : "—"} →{" "}
            {after.hash ? formatArchiveBytes(Number(after.bytes)) : "—"}
          </span>
          <button
            className="arc-text-button"
            onClick={() => setSnapshots((s) => !s)}
          >
            {snapshots
              ? t("파일 내용 접기", "Collapse files")
              : t("보관된 파일 내용 보기", "View saved contents")}
          </button>
        </div>
        {!!(before.link || after.link) && (
          <p className="arc-muted">
            {t("연결 경로", "Link target")}: {str(before.link)} →{" "}
            {str(after.link)}
          </p>
        )}
        {snapshots && (
          <div className="arc-snapshot-grid">
            {!!before.hash && (
              <FileSnapshot
                chatId={chatId}
                hash={str(before.hash)}
                name={path}
                label={t("변경 전", "Before")}
              />
            )}
            {!!after.hash && (
              <FileSnapshot
                chatId={chatId}
                hash={str(after.hash)}
                name={path}
                label={
                  entry.kind === "file-reference"
                    ? t("보관본", "Saved copy")
                    : t("변경 후", "After")
                }
              />
            )}
          </div>
        )}
        <p className="arc-muted arc-small">
          {t(
            "작업 폴더 또는 도구가 가리킨 경로에서 감지한 보관 버전입니다.",
            "A saved version observed in the workspace or a tool-referenced path.",
          )}
        </p>
      </div>
    );
  }
  if (entry.kind === "capture-error" || entry.kind === "coverage-gap")
    return (
      <p className="arc-error">{str(payload.error) || str(payload.text)}</p>
    );
  if (
    (entry.source === "input" && entry.kind === "user") ||
    entry.kind === "assistant-done"
  )
    return (
      <div className="content arc-message-text">
        <Markdown text={textOf(payload)} />
      </div>
    );
  if (entry.source === "tool") {
    const item = obj(payload.item);
    const command = str(item.command) || str(obj(payload.input).command);
    const output =
      str(item.aggregatedOutput) ||
      contentText(payload.content) ||
      contentText(obj(item.result).content) ||
      str(item.output);
    if (item.type === "fileChange" && Array.isArray(item.changes))
      return (
        <div className="arc-file-patches">
          {item.changes.map((change, i) => {
            const c = obj(change);
            return (
              <section key={i}>
                <p className="arc-file-path">{str(c.path)}</p>
                <pre className="arc-tool-output">
                  {str(c.diff) || JSON.stringify(c, null, 2)}
                </pre>
              </section>
            );
          })}
        </div>
      );
    return (
      <div>
        {command && <pre className="arc-command">{command}</pre>}
        {payload.input != null && (
          <div>
            <span className="arc-mini-label">{t("입력", "Input")}</span>
            <pre className="arc-raw">
              {JSON.stringify(payload.input, null, 2)}
            </pre>
          </div>
        )}
        {output && (
          <div>
            <span className="arc-mini-label">
              {t("출력 원문", "Full output")}
            </span>
            <pre className="arc-tool-output">{output}</pre>
          </div>
        )}
        {!command && payload.input == null && !output && (
          <pre className="arc-raw">{JSON.stringify(payload, null, 2)}</pre>
        )}
        {item.exitCode != null && (
          <p className="arc-muted">
            {t("종료 코드", "Exit code")}: {String(item.exitCode)}
          </p>
        )}
      </div>
    );
  }
  if (entry.source === "ui" && entry.kind === "result")
    return (
      <div className="arc-completion">
        <p>
          {payload.isError
            ? t("오류로 작업이 끝났습니다.", "The task ended with an error.")
            : t("작업이 완료되었습니다.", "Task completed.")}
          {typeof payload.durationMs === "number" &&
            ` · ${formatArchiveTime(payload.durationMs)}`}
        </p>
        {textOf(payload) && <Markdown text={textOf(payload)} />}
      </div>
    );
  if (entry.kind === "question-request" && Array.isArray(payload.questions))
    return (
      <div className="content arc-message-text">
        {payload.questions.map((q, i) => (
          <p key={i}>{str(obj(q).question)}</p>
        ))}
      </div>
    );
  return <pre className="arc-raw">{JSON.stringify(payload, null, 2)}</pre>;
}

function activityTitle(entry: ArchiveEntry): string {
  if (entry.kind === "result" && entry.activity)
    return entry.activity.error
      ? t("작업 실패", "Task failed")
      : t("작업 완료", "Task completed");
  if (entry.source === "tool") {
    const op = entry.activity?.operation;
    return (
      (
        {
          read: t("파일 읽기", "Read file"),
          write: t("파일 쓰기", "Write file"),
          edit: t("파일 수정", "Edit file"),
          delete: t("파일 삭제", "Delete file"),
          command: t("명령 실행", "Run command"),
          search: t("검색", "Search"),
          agent: t("에이전트 작업", "Agent task"),
          image: t("이미지 생성", "Generate image"),
        } as Record<string, string>
      )[op || ""] ||
      entry.activity?.name ||
      t("도구 실행", "Tool activity")
    );
  }
  return (
    (
      {
        "permission-request": t("실행 승인 요청", "Approval requested"),
        "question-request": t("질문", "Question"),
        "question-closed": t("질문 처리", "Question resolved"),
        control_response: t("사용자 응답", "User response"),
        result: t("작업 종료", "Task finished"),
        error: t("오류", "Error"),
        aborted: t("작업 중단", "Task stopped"),
        interrupted: t("실행 중단", "Execution interrupted"),
        "recording-enabled": t("대화 기록 시작", "Recording started"),
        "recording-paused": t("대화 기록 중지", "Recording paused"),
        "capture-error": t("파일 보관 오류", "Capture error"),
        "coverage-gap": t("기록 확인 필요", "Capture gap"),
        "model-fallback": t("모델 변경", "Model changed"),
        "api-retry": t("요청 재시도", "Request retry"),
        plan: t("작업 계획", "Work plan"),
      } as Record<string, string>
    )[entry.kind] ||
    (entry.source === "response"
      ? t("사용자 응답", "User response")
      : entry.kind)
  );
}

const FileActivityGroup = memo(function FileActivityGroup({
  chatId,
  entry,
  refresh,
}: {
  chatId: string;
  entry: ArchiveEntry;
  refresh: number;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  return (
    <section
      className="arc-event arc-activity arc-file-group"
      data-first-seq={entry.seq}
      data-last-seq={entry.fileGroup?.endSeq}
    >
      <button
        className="arc-event-head arc-activity-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="arc-event-symbol">
          <IconFile size={14} />
        </span>
        <b>{t("파일 원본·변경 기록", "Saved files and changes")}</b>
        <span className="arc-activity-phase arc-file-group-count">
          {entry.fileGroup?.count.toLocaleString()}
          {t("건", " records")}
        </span>
        <time>{clock(entry.at)}</time>
        <IconChevDown size={12} />
      </button>
      {open && (
        <div className="arc-file-group-body">
          <EventList
            chatId={chatId}
            source="files"
            turnId=""
            firstSeq={entry.seq}
            lastSeq={entry.fileGroup!.endSeq}
            refresh={refresh}
          />
        </div>
      )}
    </section>
  );
});

const EventCard = memo(function EventCard({
  chatId,
  entry,
  autoOpen = false,
}: {
  chatId: string;
  entry: ArchiveEntry;
  autoOpen?: boolean;
}) {
  useLang();
  const [open, setOpen] = useState(autoOpen);
  const [page, setPage] = useState<PayloadPage | null>(null);
  const [history, setHistory] = useState<number[]>([0]);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const offset = history[history.length - 1];
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError("");
    void archivePayload(chatId, entry.seq, offset)
      .then((p) => {
        if (alive) setPage(p);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chatId, entry.seq, offset, open]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const value = useMemo<Json | null>(() => {
    if (page && offset === 0 && page.next == null) {
      try {
        return obj(obj(JSON.parse(page.text)).payload);
      } catch {
        /* Show unreadable records verbatim. */
      }
    }
    return null;
  }, [page, offset]);
  const isUser = entry.source === "input" && entry.kind === "user";
  const isMessage = isUser || entry.kind === "assistant-done";
  const who = isUser
    ? t("나", "You")
    : entry.kind === "assistant-done"
      ? str(value?._archiveModel) || "AI"
      : entry.source === "file" &&
          (entry.kind === "file-version" || entry.kind === "file-reference")
        ? t("파일 보관", "File snapshot")
        : activityTitle(entry);
  const copy = async (): Promise<void> => {
    try {
      const text =
        raw || !value
          ? page?.text || ""
          : isMessage
            ? textOf(value)
            : JSON.stringify(value, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const body = (
    <>
      {error && (
        <p className="arc-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="arc-muted">{t("기록 읽는 중…", "Loading record…")}</p>
      ) : raw || !value ? (
        <pre className="arc-raw">{page?.text}</pre>
      ) : (
        <EventBody chatId={chatId} entry={entry} payload={value} raw={false} />
      )}
    </>
  );
  const pages = (history.length > 1 || page?.next != null) && (
    <div className="arc-page-controls">
      <button
        disabled={history.length <= 1 || loading}
        onClick={() => setHistory((h) => h.slice(0, -1))}
      >
        {t("이전 부분", "Previous")}
      </button>
      <span>
        {formatArchiveBytes(offset)} /{" "}
        {formatArchiveBytes(page?.totalBytes || 0)} ·{" "}
        {t("원문 전체 보관됨", "Full record saved")}
      </span>
      <button
        disabled={page?.next == null || loading}
        onClick={() => {
          if (page?.next != null) setHistory((h) => [...h, page.next!]);
        }}
      >
        {t("다음 부분", "Next")}
      </button>
    </div>
  );
  if (autoOpen)
    return (
      <article
        className={
          "arc-event arc-chat-message" + (isUser ? " user" : " assistant")
        }
        data-kind={entry.kind}
        data-seq={entry.seq}
      >
        <div className="arc-message-head">
          <span
            className={"arc-avatar" + (isUser ? " user" : "")}
            aria-hidden="true"
          >
            {isUser ? <IconUser size={15} /> : <IconBot size={16} />}
          </span>
          <b>{who}</b>
          <time title={date(entry.at)}>{clock(entry.at)}</time>
          <div className="arc-message-actions">
            {value && (
              <button
                className={"arc-icon" + (raw ? " active" : "")}
                aria-label={
                  raw
                    ? t("메시지 보기", "View message")
                    : t("저장 원문 보기", "View raw record")
                }
                title={
                  raw
                    ? t("메시지 보기", "View message")
                    : t("저장 원문 보기", "View raw record")
                }
                aria-pressed={raw}
                onClick={() => setRaw((r) => !r)}
              >
                <IconCode size={14} />
              </button>
            )}
            <button
              className={"arc-icon" + (copied ? " copied" : "")}
              disabled={!page || loading}
              aria-label={
                copied
                  ? t("복사됨", "Copied")
                  : t("메시지 복사", "Copy message")
              }
              title={
                copied
                  ? t("복사됨", "Copied")
                  : t("메시지 복사", "Copy message")
              }
              onClick={() => {
                void copy();
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </button>
          </div>
        </div>
        <div className={"arc-message-content" + (raw ? " raw" : "")}>
          {raw && (
            <div className="arc-raw-info">
              #{entry.seq} · {entry.source} ·{" "}
              {formatArchiveBytes(entry.payloadBytes)}
            </div>
          )}
          {body}
          {pages}
        </div>
      </article>
    );
  return (
    <article
      data-kind={entry.kind}
      data-seq={entry.seq}
      className={
        "arc-event" +
        (!isMessage && entry.source !== "file" ? " arc-activity" : "") +
        (isUser ? " user" : "") +
        (entry.kind === "error" ||
        entry.kind === "capture-error" ||
        entry.kind === "coverage-gap" ||
        entry.activity?.error
          ? " issue"
          : "")
      }
    >
      <button
        className="arc-event-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="arc-event-symbol">
          {entry.source === "tool" ? (
            <IconTerminal size={14} />
          ) : entry.source === "file" ? (
            <IconFile size={14} />
          ) : isUser ? (
            <IconUser size={14} />
          ) : (
            <IconCode size={14} />
          )}
        </span>
        <b>{who}</b>
        <span className="arc-event-preview">
          {entry.activity?.target ||
            (entry.preview !== entry.kind ? entry.preview : "")}
        </span>
        {entry.source === "tool" && (
          <span
            className={
              "arc-activity-phase" + (entry.activity?.error ? " error" : "")
            }
          >
            {entry.activity?.phase === "end" ||
            entry.kind === "tool_result" ||
            entry.kind === "item/completed"
              ? entry.activity?.error
                ? t("실패", "Failed")
                : t("완료", "Completed")
              : t("시작", "Started")}
          </span>
        )}
        <time title={date(entry.at)}>{clock(entry.at)}</time>
        <IconChevDown size={12} />
      </button>
      {open && (
        <div className="arc-event-body">
          {body}
          <div className="arc-event-actions">
            <span>
              #{entry.seq} · {entry.source} ·{" "}
              {formatArchiveBytes(entry.payloadBytes)}
            </span>
            {value && (
              <button onClick={() => setRaw((r) => !r)}>
                <IconCode size={13} />
                {raw ? t("내용 보기", "Content") : t("저장 원문", "Raw record")}
              </button>
            )}
            <button
              disabled={!page || loading}
              onClick={() => {
                void copy();
              }}
            >
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              {copied ? t("복사됨", "Copied") : t("내용 복사", "Copy content")}
            </button>
          </div>
          {pages}
        </div>
      )}
    </article>
  );
});
const EventList = memo(function EventList({
  chatId,
  turnId,
  source,
  refresh,
  firstSeq = 1,
  lastSeq,
}: {
  chatId: string;
  turnId: string;
  source: string;
  refresh: number;
  firstSeq?: number;
  lastSeq?: number;
}) {
  useLang();
  const [page, setPage] = useState<ArchivePage<ArchiveEntry> | null>(null);
  const [cursor, setCursor] = useState<number[]>([firstSeq]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query);
      setCursor([firstSeq]);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, firstSeq]);
  useEffect(() => {
    setCursor([firstSeq]);
    setPage(null);
    setQuery("");
    setSearch("");
  }, [chatId, turnId, source, firstSeq]);
  const from = cursor[cursor.length - 1];
  useEffect(() => {
    if (source === "timeline")
      list.current?.closest(".arc-detail-scroll")?.scrollTo({ top: 0 });
  }, [from, search, source]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    // File baselines and raw streaming may span many index pages between chat
    // messages. Skip empty filtered ranges without making the user page through
    // them; each IPC read remains bounded and changing tabs cancels the scan.
    const read = async (): Promise<ArchivePage<ArchiveEntry> | null> => {
      let position = from;
      while (alive) {
        const p = await archiveEntries(
          chatId,
          position,
          source,
          turnId,
          search,
          lastSeq,
        );
        if (p.items.length || p.next == null) return p;
        if (p.next <= position)
          throw new Error(
            t(
              "기록을 계속 읽을 수 없습니다.",
              "Unable to advance through archive records.",
            ),
          );
        position = p.next;
      }
      return null;
    };
    void read()
      .then((p) => {
        if (alive && p) setPage(p);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chatId, turnId, source, from, refresh, search, lastSeq]);
  return (
    <div
      ref={list}
      className={
        "arc-events" + (source === "timeline" ? " arc-conversation" : "")
      }
    >
      {source === "all" && (
        <label className="arc-event-search">
          <IconSearch size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(
              "이벤트 이름·미리보기 검색",
              "Search event names and previews",
            )}
          />
        </label>
      )}
      {source === "files" && (
        <p className="arc-tab-note">
          {t(
            "변경 기록을 열면 보관된 파일의 이전 내용과 이후 내용을 비교할 수 있습니다.",
            "Open a change to compare the saved file before and after it.",
          )}
        </p>
      )}
      {error && (
        <p className="arc-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="arc-empty">{t("기록 읽는 중…", "Loading…")}</div>
      ) : !page?.items.length ? (
        <div className="arc-empty">
          {page?.next
            ? t(
                "이 구간에는 해당 기록이 없어요. 다음 구간에서 계속 확인할 수 있습니다.",
                "No matching entries in this range. Continue to the next range.",
              )
            : source === "diagnostics"
              ? t("기록된 오류 알림이 없습니다.", "No error notifications recorded.")
              : t(
                  "이 항목에 해당하는 기록이 없습니다.",
                  "No records in this category.",
                )}
        </div>
      ) : (
        page.items.map((e, i) => (
          <div key={`${chatId}-${e.seq}`}>
            {source === "timeline" &&
              (i === 0 ||
                new Date(page.items[i - 1].at).toDateString() !==
                  new Date(e.at).toDateString()) && (
                <div className="arc-day">
                  {new Date(e.at).toLocaleDateString()}
                </div>
              )}
            {e.fileGroup ? (
              <FileActivityGroup chatId={chatId} entry={e} refresh={refresh} />
            ) : (
              <EventCard
                chatId={chatId}
                entry={e}
                autoOpen={
                  (e.source === "input" && e.kind === "user") ||
                  (e.source === "ui" && e.kind === "assistant-done")
                }
              />
            )}
          </div>
        ))
      )}
      {(cursor.length > 1 || page?.next != null) && (
        <div className="arc-page-controls">
          <button
            disabled={cursor.length < 2 || loading}
            onClick={() => setCursor((c) => c.slice(0, -1))}
          >
            {t("이전 기록", "Previous")}
          </button>
          <span>
            {t("기록을 나누어 불러옵니다", "Records load in bounded pages")}
          </span>
          <button
            disabled={page?.next == null || loading}
            onClick={() => {
              if (page?.next != null) setCursor((c) => [...c, page.next!]);
            }}
          >
            {t("다음 기록", "Next")}
          </button>
        </div>
      )}
    </div>
  );
});

export default function ConversationArchive({
  onClose,
}: {
  onClose: () => void;
}) {
  useLang();
  const [sessions, setSessions] = useState<ArchiveSession[]>([]);
  const [session, setSession] = useState<ArchiveSession | null>(null);
  const [cursor, setCursor] = useState([0]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [root, setRoot] = useState("");
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [transfer, setTransfer] = useState<"import" | "export" | null>(null);
  const [notice, setNotice] = useState("");
  const [storageOpen, setStorageOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{
    session: ArchiveSession;
    x: number;
    y: number;
  } | null>(null);
  const [sessionAction, setSessionAction] = useState<{
    session: ArchiveSession;
    action: ArchiveAction;
  } | null>(null);
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const chat = session?.chatId || "";
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
    setDiagnosticsOpen(false);
  }, [chat]);
  const offset = cursor[cursor.length - 1];
  const title = (s: ArchiveSession): string =>
    s.title ||
    s.cwd.split(/[\\/]/).pop() ||
    t("제목 없는 세션", "Untitled session");

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.focus();
    const key = (e: KeyboardEvent): void => {
      if (document.querySelector(".arc-session-menu, .arc-session-action"))
        return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        close.current();
      }
      if (e.key === "Tab") {
        const nodes = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]',
          ) || [],
        ).filter((n) => n.getClientRects().length);
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, [dialog]);
  useEffect(() => {
    setSessionMenu(null);
  }, [offset, query, refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCursor([0]);
      setQuery(search.trim());
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setListError("");
    void archiveSessions(offset, query)
      .then((p) => {
        if (!alive) return;
        setSessions(p.items);
        setTotal(p.total);
        setNext(p.next);
        setRoot(p.root);
        setSession(
          (current) =>
            p.items.find((s) => s.chatId === current?.chatId) ||
            p.items[0] ||
            null,
        );
      })
      .catch((e) => {
        if (alive) setListError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [offset, query, refresh]);
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError("");
    if (chat)
      void archiveStatus(chat)
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    return () => {
      alive = false;
    };
  }, [chat, refresh]);
  const reload = async (): Promise<void> => {
    setActing(true);
    setError("");
    try {
      if (chat) await archiveCall("flush", { chatId: chat });
      setRefresh((r) => r + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing(false);
    }
  };
  const changeRoot = async (): Promise<void> => {
    setActing(true);
    setError("");
    try {
      const path = await window.api.pickDirectory();
      if (!path) return;
      const result = await archiveCall<{ root: string; previousRoot: string }>(
        "set-root",
        { path },
      );
      setNotice(
        t(
          `저장 위치를 변경했습니다. 이전 기록은 ${result.previousRoot}에 남아 있으며, 그 폴더를 다시 선택하면 볼 수 있어요.`,
          `Archive location changed. Earlier records remain in ${result.previousRoot}; select that folder to view them again.`,
        ),
      );
      setSession(null);
      setSessions([]);
      setCursor([0]);
      setSearch("");
      setQuery("");
      setRefresh((r) => r + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing(false);
    }
  };
  const pause = async (): Promise<void> => {
    if (!status) return;
    setActing(true);
    setError("");
    try {
      await archiveConfigure(chat, { ...status.config, enabled: false });
      setRefresh((r) => r + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing(false);
    }
  };
  const importSession = async (kind: "zip" | "folder"): Promise<void> => {
    setActing(true);
    setTransfer("import");
    setError("");
    try {
      const { path } = await archiveCall<{ path: string | null }>("pick-import", { kind });
      if (!path) return;
      await archiveCall("import", { path });
      setSession(null);
      setCursor([0]);
      setSearch("");
      setQuery("");
      setRefresh((r) => r + 1);
      setNotice(
        t(
          "세션을 가져왔습니다. 대화와 파일 사본을 확인할 수 있습니다.",
          "Session imported. Its conversation and saved files are ready to view.",
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing(false);
      setTransfer(null);
    }
  };
  const exportSession = async (): Promise<void> => {
    if (!session) return;
    setActing(true);
    setTransfer("export");
    setError("");
    try {
      const { path } = await archiveCall<{ path: string | null }>("pick-export", { title: title(session) });
      if (!path) return;
      const result = await archiveCall<{ path: string; bytes: number }>("export", {
        chatId: session.chatId, root, path,
      });
      setNotice(t(
        `세션을 내보냈습니다 (${formatArchiveBytes(result.bytes)}): ${result.path}`,
        `Session exported (${formatArchiveBytes(result.bytes)}): ${result.path}`,
      ));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing(false);
      setTransfer(null);
    }
  };
  const openSessionFolder = async (): Promise<void> => {
    setActing(true);
    setError("");
    try {
      const result = await archiveCall<{ path: string }>("session-folder", {
        chatId: chat,
      });
      await window.api.openPath(result.path, "");
      setNotice(
        t(
          "다른 컴퓨터로 옮길 때는 기록을 중지한 뒤, Chat과 View가 들어 있는 이 세션 폴더 전체를 복사해 주세요.",
          "To transfer this session, pause recording and copy this entire folder containing Chat and View.",
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActing(false);
    }
  };
  const enabled = status?.status.enabled ?? session?.enabled;
  const focusSession = (id: string): void => {
    requestAnimationFrame(() => {
      const row = [
        ...(dialog?.querySelectorAll<HTMLElement>(".arc-session") ||
          []),
      ].find((el) => el.dataset.sessionId === id);
      (
        row || dialog?.querySelector<HTMLElement>(".arc-refresh")
      )?.focus();
    });
  };
  const performSessionAction = async (value: string): Promise<void> => {
    if (!sessionAction) return;
    const target = sessionAction.session;
    const kind = sessionAction.action;
    setActing(true);
    try {
      await archiveCall(kind, {
        chatId: target.chatId,
        root,
        ...(kind === "rename" ? { title: value } : {}),
      });
      if (kind === "delete") {
        setSessions((items) => items.filter((s) => s.chatId !== target.chatId));
        setSession((s) => (s?.chatId === target.chatId ? null : s));
        if (sessions.length === 1 && cursor.length > 1)
          setCursor((pages) => pages.slice(0, -1));
      } else {
        setSessions((items) =>
          items.map((s) =>
            s.chatId === target.chatId ? { ...s, title: value } : s,
          ),
        );
        setSession((s) =>
          s?.chatId === target.chatId ? { ...s, title: value } : s,
        );
      }
      setRefresh((r) => r + 1);
    } finally {
      setActing(false);
    }
  };
  return (
    <div
      className="arc-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <MouseGestureLayer
        target={dialog}
        disabled={!!sessionAction}
        actions={[
          ...scrollGestures(() => scroll.current),
          { pattern: "DR", label: t("창 닫기", "Close window"), run: onClose },
        ]}
      />
      <div
        className="arc-dialog"
        ref={setDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="arc-title"
        tabIndex={-1}
      >
        <header className="arc-header">
          <div className="arc-brand">
            <span className="arc-brand-icon">
              <IconClock size={19} />
            </span>
            <h2 id="arc-title">{t("대화 기록소", "Conversation archive")}</h2>
          </div>
          <span className="arc-grow" />
          <button
            className="arc-icon arc-refresh has-tip"
            disabled={loading || acting}
            data-tip={t("새로고침", "Refresh")}
            aria-label={t("새로고침", "Refresh")}
            onClick={() => {
              void reload();
            }}
          >
            <IconRefresh size={16} />
          </button>
          <ArchiveImportButton
            disabled={acting}
            importing={transfer === "import"}
            onImport={(kind) => {
              void importSession(kind);
            }}
          />
          <button
            className={
              "arc-button arc-storage-toggle" + (storageOpen ? " active" : "")
            }
            aria-expanded={storageOpen}
            onClick={() => setStorageOpen((v) => !v)}
          >
            <IconFolder size={15} />
            {t("저장 위치", "Storage")}
            <IconChevDown size={11} />
          </button>
          <span className="arc-header-divider" />
          <button
            className="arc-icon arc-close"
            aria-label={t("닫기", "Close")}
            onClick={onClose}
          >
            <IconClose size={19} />
          </button>
        </header>
        {(error || listError) && (
          <div className="arc-banner" role="alert">
            <IconAlert size={15} />
            <span>{error || listError}</span>
          </div>
        )}
        {storageOpen && (
          <div className="arc-storage-panel">
            <div>
              <span>{t("보관 폴더", "Archive folder")}</span>
              <code title={root}>{root || t("읽는 중…", "Loading…")}</code>
            </div>
            <button
              className="arc-button"
              disabled={!root}
              onClick={() => {
                void window.api.openPath(root, "");
              }}
            >
              {t("폴더 열기", "Open folder")}
            </button>
            <button
              className="arc-button"
              disabled={acting}
              onClick={() => {
                void changeRoot();
              }}
            >
              {t("위치 변경", "Change location")}
            </button>
          </div>
        )}
        {notice && (
          <p className="arc-storage-notice" role="status">
            {notice}
          </p>
        )}
        <div className="arc-layout">
          <aside className="arc-sidebar">
            <label className="arc-search">
              <IconSearch size={15} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("세션 검색", "Search sessions")}
                aria-label={t("세션 검색", "Search sessions")}
              />
            </label>
            <div className="arc-list-label">
              <span>
                {query
                  ? t("검색 결과", "Search results")
                  : t("모든 세션", "All sessions")}
              </span>
              <span>{total.toLocaleString()}</span>
            </div>
            <div
              className="arc-session-list scroll"
              aria-label={t("저장된 세션", "Saved sessions")}
              aria-busy={loading}
            >
              {loading ? (
                <div className="arc-empty">
                  {t("세션 읽는 중…", "Loading sessions…")}
                </div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.chatId}
                    className={
                      "arc-session" + (chat === s.chatId ? " selected" : "")
                    }
                    data-session-id={s.chatId}
                    aria-haspopup="menu"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (acting) return;
                      setSession(s);
                      setSessionMenu({
                        session: s,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                    onKeyDown={(e) => {
                      if (acting) return;
                      if (
                        e.key === "ContextMenu" ||
                        (e.shiftKey && e.key === "F10")
                      ) {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setSession(s);
                        setSessionMenu({
                          session: s,
                          x: rect.left + 20,
                          y: rect.top + 20,
                        });
                      } else if (e.key === "F2" || e.key === "Delete") {
                        e.preventDefault();
                        setSessionAction({
                          session: s,
                          action: e.key === "F2" ? "rename" : "delete",
                        });
                      }
                    }}
                    aria-pressed={chat === s.chatId}
                    onClick={() => setSession(s)}
                  >
                    <h3>{title(s)}</h3>
                    <p title={s.cwd}>
                      <IconFolder size={12} />
                      <span>
                        {folderName(s.cwd) ||
                          t("작업 폴더 없음", "No workspace")}
                      </span>
                    </p>
                    <div className="arc-session-top">
                      <time title={date(s.updatedAt)}>
                        {shortDate(s.updatedAt)}
                      </time>
                      {s.enabled && (
                        <span className="arc-session-recording">
                          <i />
                          {t("기록중", "Recording")}
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
              {!loading && !sessions.length && (
                <div className="arc-empty">
                  {query
                    ? t("검색에 맞는 세션이 없습니다.", "No matching sessions.")
                    : t(
                        "아직 저장된 세션이 없습니다.",
                        "No saved sessions yet.",
                      )}
                </div>
              )}
            </div>
            {(cursor.length > 1 || next != null) && (
              <div className="arc-page-controls arc-session-pages">
                <button
                  disabled={cursor.length < 2 || loading}
                  onClick={() => setCursor((c) => c.slice(0, -1))}
                >
                  {t("이전", "Previous")}
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + sessions.length, total)} /{" "}
                  {total}
                </span>
                <button
                  disabled={next == null || loading}
                  onClick={() => {
                    if (next != null) setCursor((c) => [...c, next]);
                  }}
                >
                  {t("다음", "Next")}
                </button>
              </div>
            )}
          </aside>
          <main className="arc-detail">
            {session ? (
              <>
                <div className="arc-detail-header">
                  <div className="arc-session-title-row">
                    <h3>{title(session)}</h3>
                    {enabled && (
                      <span className="arc-session-state recording">
                        <i />
                        {t("대화 기록중", "Recording conversation")}
                      </span>
                    )}
                  </div>
                  <div className="arc-session-meta">
                    <span
                      title={`${date(session.startedAt)} — ${date(session.updatedAt)}`}
                    >
                      <IconClock size={12} />
                      {date(session.startedAt)} —{" "}
                      {new Date(session.startedAt).toDateString() ===
                      new Date(session.updatedAt).toDateString()
                        ? clock(session.updatedAt)
                        : date(session.updatedAt)}
                    </span>
                    <span title={session.cwd}>
                      <IconFolder size={12} />
                      {folderName(session.cwd) ||
                        t("작업 폴더 없음", "No workspace")}
                    </span>
                    <span>{formatArchiveBytes(session.bytes)}</span>
                    <button
                      className="arc-text-button arc-session-folder"
                      disabled={acting}
                      onClick={() => {
                        void openSessionFolder();
                      }}
                    >
                      <IconFolder size={12} />
                      {t("세션 폴더", "Session folder")}
                    </button>
                    <button
                      className="arc-text-button arc-export"
                      disabled={acting || !!enabled}
                      title={enabled
                        ? t("대화 기록을 중지한 뒤 내보낼 수 있습니다.", "Pause recording before exporting.")
                        : t("대화와 파일 사본을 ZIP으로 내보내기", "Export the conversation and saved files as ZIP")}
                      onClick={() => { void exportSession(); }}
                    >
                      <IconDownload size={12} />
                      {transfer === "export"
                        ? t("내보내는 중…", "Exporting…")
                        : t("세션 내보내기", "Export session")}
                    </button>
                    <button
                      className="arc-text-button arc-diagnostics-toggle"
                      aria-expanded={diagnosticsOpen}
                      aria-controls="arc-capture-status"
                      onClick={() => setDiagnosticsOpen((v) => !v)}
                    >
                      <IconAlert size={12} />
                      {t("오류 알림", "Error notifications")}
                    </button>
                    {enabled && (
                      <button
                        className="arc-text-button"
                        disabled={acting || !status}
                        onClick={() => {
                          void pause();
                        }}
                      >
                        {t("기록 중지", "Pause recording")}
                      </button>
                    )}
                  </div>
                </div>
                {diagnosticsOpen && (
                  <section
                    id="arc-capture-status"
                    className="arc-diagnostics scroll"
                    aria-label={t("오류 알림 상세", "Error notification details")}
                  >
                    <p className="arc-tab-note">
                      {t(
                        "보관 중 발생한 오류와 누락 가능성을 시간순으로 보여줍니다.",
                        "Errors and possible gaps recorded during capture, in chronological order.",
                      )}
                    </p>
                    {status?.status.error && (
                      <p className="arc-error" role="alert">
                        {status.status.error}
                      </p>
                    )}
                    <EventList
                      key={chat}
                      chatId={chat}
                      turnId=""
                      source="diagnostics"
                      refresh={refresh}
                    />
                  </section>
                )}
                <div
                  className="arc-detail-scroll scroll"
                  ref={scroll}
                  id="arc-content-panel"
                  role="region"
                  aria-label={t(
                    "전체 대화와 작업 기록",
                    "Conversation and activity",
                  )}
                >
                  <EventList
                    key={chat}
                    chatId={chat}
                    turnId=""
                    source="timeline"
                    refresh={refresh}
                  />
                </div>
              </>
            ) : (
              <div className="arc-library-empty">
                <span className="arc-empty-icon">
                  <IconMessage size={28} />
                </span>
                <h3>
                  {loading
                    ? t("기록소를 열고 있어요", "Opening your archive")
                    : query
                      ? t("찾는 세션이 없습니다", "No matching sessions")
                      : t(
                          "아직 보관된 대화가 없습니다",
                          "No saved conversations yet",
                        )}
                </h3>
                <p>
                  {loading
                    ? t(
                        "저장된 세션을 불러오고 있습니다.",
                        "Loading your saved sessions.",
                      )
                    : query
                      ? t(
                          "다른 검색어로 세션을 찾아보세요.",
                          "Try another search to find a session.",
                        )
                      : t(
                          "채팅에서 ‘대화 기록’을 켜면 세션별로 여기에 보관됩니다.",
                          "Enable recording in a chat to keep its session here.",
                        )}
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
      {sessionMenu && (
        <ArchiveSessionMenu
          title={title(sessionMenu.session)}
          x={sessionMenu.x}
          y={sessionMenu.y}
          onAction={(action) => {
            setSessionAction({ session: sessionMenu.session, action });
            setSessionMenu(null);
          }}
          onClose={() => {
            focusSession(sessionMenu.session.chatId);
            setSessionMenu(null);
          }}
        />
      )}
      {sessionAction && (
        <ArchiveSessionActionDialog
          key={`${sessionAction.action}-${sessionAction.session.chatId}`}
          action={sessionAction.action}
          title={title(sessionAction.session)}
          onSubmit={performSessionAction}
          onClose={() => {
            focusSession(sessionAction.session.chatId);
            setSessionAction(null);
          }}
        />
      )}
    </div>
  );
}
