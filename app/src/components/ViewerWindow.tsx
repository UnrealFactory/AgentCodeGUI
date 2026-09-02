import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { ViewerOpenPayload } from '@shared/protocol'
import { t, useLang } from '../lib/i18n'
import { diffsOf } from '../lib/viewerWindow'
const FileModal = lazy(() => import('./FileModal').then((m) => ({ default: m.FileModal }))) // CodeMirror 청크 지연 로드

// ── 파일 뷰어 독립 창 (#viewer) — 코드 뷰어 카드 하나가 창 전체를 쓴다 ────────────
// 카드 뷰어(FileModal)를 `windowed`로 그린다: 오버레이 배경·카드 크기 조절·카드 최대화는
// 물러나고, 헤더가 창 드래그 띠(-webkit-app-region:drag → chrome.ts가 네이티브 드래그로)
// 겸 창 컨트롤(창 안으로·최소화·최대화·닫기)이 된다. 대화는 없다 — 파일은 main이
// `viewer:open`으로 보내 주고, 질문 전송·「창 안으로」는 main이 원래 창으로 되돌린다.
//
// 빈 창 번쩍임 방지: 창은 숨긴 채 태어나고(또 파일을 닫으면 숨겨진다) 파일이 그려진 뒤
// (`onReady` → `viewer:shown`)에야 main이 보인다. 그래서 첫 프레임이 곧 그 파일이다.

export function ViewerWindow(): React.ReactElement {
  useLang() // 언어 전환 브로드캐스트 재렌더 (메인 창 설정에서 바꿔도 따라온다)
  const [file, setFile] = useState<ViewerOpenPayload | null>(null)
  const fileRef = useRef<ViewerOpenPayload | null>(null)
  fileRef.current = file

  useEffect(() => {
    const api = window.api.viewer
    if (!api) return
    // 마운트/재로드 복원 — 닫은 뒤(hide)면 null이라 아무것도 안 그린다(창도 숨겨져 있다)
    api.hydrate().then((p) => p && setFile(p)).catch(() => {})
    const offOpen = api.onOpen((p) => setFile(p))
    // X·Alt+F4·Ctrl+W는 전부 shortcut:close로 온다. 파일이 떠 있으면 FileModal이 자기 닫기
    // 경로(미저장 확인 카드 포함)로 받고, 파일이 없으면(빈 창) 여기서 창만 숨긴다.
    const offClose = window.api.onCloseShortcut(() => {
      if (!fileRef.current) void api.hide()
    })
    return () => {
      offOpen()
      offClose()
    }
  }, [])

  // 창 타이틀(OS 작업 표시줄) — 보는 파일명을 따라간다
  useEffect(() => {
    const name = file ? file.path.replace(/\\/g, '/').split('/').pop() || file.path : ''
    document.title = name ? `${name} — AgentCodeGUI` : t('파일 뷰어 — AgentCodeGUI', 'File viewer — AgentCodeGUI')
  }, [file])

  const api = window.api.viewer
  return (
    <div className="sw vwin">
      {file && api && (
        <Suspense fallback={null}>
          <FileModal
            windowed
            path={file.path}
            cwd={file.cwd}
            diffs={diffsOf(file)}
            override={file.override}
            onReady={() => void api.shown()}
            onClose={() => {
              setFile(null)
              void api.hide()
            }}
            onDock={(path) => void api.dock({ ...file, path, override: path === file.path ? file.override : null })}
            onAskSelection={file.askable ? (p) => void api.askSelection(p) : undefined}
          />
        </Suspense>
      )}
    </div>
  )
}
