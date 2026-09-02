; ─────────────────────────────────────────────────────────────────────────────
; AgentCodeGUI 3.0 — NSIS 설치기 훅 (tauri.conf.json ▸ bundle.windows.nsis.installerHooks)
;
; 이 파일은 **UTF-8 + BOM**으로 저장한다. Unicode makensis가 BOM으로 인코딩을 판정하고,
; BOM이 없으면 아래 한국어 라벨이 깨진 채로 exe에 박힌다(2.6.2 build/installer.nsh와 같은 규약).
;
; 삽입 지점(tauri 2.11 NSIS 템플릿 실측):
;   `!include "<이 파일>"`은 `!define MAINBINARYNAME` **앞**에 온다. 그래도 문제가 없는 이유는
;   NSIS가 매크로 **본문을 삽입 시점에 파싱**하기 때문이다 — `!insertmacro NSIS_HOOK_POSTINSTALL`은
;   `Section Install` 끝에서 일어나고, 그때는 모든 define이 서 있다. 그래도 이름이 어긋나면
;   조용히 깨지므로 아래에서 실행 시점에 exe 존재를 확인해 로그로 말한다.
;   `MUI2/FileFunc/utils.nsh`도 이 include 앞에 오므로 `${If}`·`${FileExists}`를 쓸 수 있다.
;
; ★ 이 파일의 제1 규칙: **2.6.2의 것은 무엇도 건드리지 않는다.**
;   M12 R1에서 `mainBinaryName`을 안 갈랐더라면 설치기가 사용자의 2.6.2를 이름으로 죽일
;   뻔했다. 같은 사고를 레지스트리에서 반복하지 않도록, 여기서 쓰는 키 이름은 전부
;   `AgentCodeGUI3`이고 2.6.2의 `AgentCodeGUI` 키는 **읽지도 지우지도 않는다.**
;
;   2.6.2가 쓰는 키(build/installer.nsh:16-23) — 이 목록은 「금지 목록」이다:
;     HKCU\Software\Classes\Directory\shell\AgentCodeGUI
;     HKCU\Software\Classes\Directory\Background\shell\AgentCodeGUI
; ─────────────────────────────────────────────────────────────────────────────

; 두 앱이 동시에 깔려 있을 때 우클릭 메뉴에 같은 글자가 둘 뜨면 어느 쪽인지 알 수 없다.
; 아이콘도 이번 라운드에서 teal 「3」 배지로 갈랐으니(4050e99) 글자도 같이 가른다.
!define CCG3_VERB "AgentCodeGUI3으로 열기"
!define CCG3_KEY "AgentCodeGUI3"
!define CCG3_DIRSHELL "Software\Classes\Directory\shell\${CCG3_KEY}"
!define CCG3_BGSHELL "Software\Classes\Directory\Background\shell\${CCG3_KEY}"

!macro NSIS_HOOK_POSTINSTALL
  ; installMode=currentUser라 HKCU다 — 관리자 권한이 필요 없고, 다른 사용자 계정도 안 건드린다.
  DetailPrint "탐색기 우클릭 메뉴 등록: ${CCG3_VERB}"
  ${IfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    DetailPrint "경고: $INSTDIR\${MAINBINARYNAME}.exe 가 없다 — 우클릭 항목이 죽은 경로를 가리킬 수 있다"
  ${EndIf}

  ; 폴더를 **직접** 우클릭 — 고른 디렉터리가 %V로 온다.
  WriteRegStr HKCU "${CCG3_DIRSHELL}" "" "${CCG3_VERB}"
  WriteRegStr HKCU "${CCG3_DIRSHELL}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${CCG3_DIRSHELL}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  ; 폴더 **안 빈 공간**을 우클릭 — 현재 디렉터리가 %V로 온다.
  WriteRegStr HKCU "${CCG3_BGSHELL}" "" "${CCG3_VERB}"
  WriteRegStr HKCU "${CCG3_BGSHELL}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${CCG3_BGSHELL}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 우리가 쓴 키만 지운다. 2.6.2의 `…\shell\AgentCodeGUI`는 이름이 달라 여기 안 걸린다.
  DeleteRegKey HKCU "${CCG3_DIRSHELL}"
  DeleteRegKey HKCU "${CCG3_BGSHELL}"

  ; ── WebView2 캐시 정리 (보수적) ────────────────────────────────────────────
  ;
  ; 3.0은 WebView2 사용자 데이터 폴더를 **앱 홈 안**으로 끌어왔다(src-tauri/src/win.rs
  ; `shared_env` — 기본값 %LOCALAPPDATA%\<identifier>는 CCG_HOME 격리를 벗어나고 벤치의
  ; 콜드 스타트도 유리하게 왜곡한다). 그 대가로 제거 후 잔여물이 앱 홈에 남는다.
  ;
  ; 앱 홈은 3.0 전용 `$PROFILE\.agentcodegui3`다(2026-09-01 — 2.6.2의 `.agentcodegui`와
  ; 분리, 그쪽은 이 설치기가 아예 모른다). 홈 자체는 지우지 않는다 — 대화·계정이 산다.
  ; `webview2\` 폴더를 통째로도 지우지 않는다: 그 안 `Local Storage`에 **사용자가 쓴
  ; 프롬프트 라이브러리**(app/src/lib/prompts.ts의 `prompt.library` — 다른 저장소가 없다)와
  ; 최근 작업 폴더·창별 picker 기본값·언어 미러가 산다. 통째로 지우면 그게 같이 죽는다.
  ;
  ; 그래서 **순수 캐시 폴더만 이름으로 지목**한다. 실측(격리 벤치 홈 12MB 기준):
  ;   Cache 5.2M · Code Cache 1.4M · BrowserMetrics 1.3M · GPUCache/Dawn*/*ShaderCache 각 548K
  ;   ⇒ 캐시 ~10.7M(89%)를 걷고 Local Storage 9K는 남는다.
  ; 없는 경로에 대한 RMDir는 무해한 no-op이라 WebView2 판이 바뀌어도 조용히 실패한다.
  Push $R0
  StrCpy $R0 "$PROFILE\.agentcodegui3\webview2\EBWebView"
  ${If} ${FileExists} "$R0\*.*"
    DetailPrint "WebView2 캐시 정리: $R0 (사용자 데이터는 남긴다)"
    RMDir /r "$R0\Default\Cache"
    RMDir /r "$R0\Default\Code Cache"
    RMDir /r "$R0\Default\GPUCache"
    RMDir /r "$R0\Default\DawnWebGPUCache"
    RMDir /r "$R0\Default\DawnGraphiteCache"
    RMDir /r "$R0\Default\Service Worker\CacheStorage"
    RMDir /r "$R0\Default\Service Worker\ScriptCache"
    RMDir /r "$R0\BrowserMetrics"
    RMDir /r "$R0\ShaderCache"
    RMDir /r "$R0\GrShaderCache"
    RMDir /r "$R0\GPUPersistentCache"
  ${EndIf}
  Pop $R0
!macroend
