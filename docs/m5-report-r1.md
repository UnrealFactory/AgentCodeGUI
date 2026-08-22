# M5 빌드 보고 — R1 (계정 도메인 크레이트 `ccg-auth`)

**범위**: `crates/ccg-auth/`(신설) · `Cargo.toml`(워크스페이스 members 1줄) · 이 문서.
**안 건드린 것**: `src-tauri/`(배선 라운드 소유) · `src/shared/protocol.ts` · `app/` ·
`crates/ccg-store/`(**한 줄도 안 고쳤다** — 아래 §1.3) · `src/main/`(2.6.2 원본, 읽기만).

**절대 조건**: 사용자가 재로그인하지 않는다. 이 문서의 수치는 전부 **사용자 실홈**
(`~/.agentcodegui`, 계정 6건)을 **복사본**으로 돌린 실측이다 — 원본에는 아무것도 쓰지 않았다.

---

## 0. 한 장 요약

| 항목 | 수치 |
|---|---|
| 테스트 | **50 green / 0 red** · 컴파일 경고 0 (`cargo test -p ccg-auth --offline`) |
| 그중 실홈 검증 | **8건**(accounts v3 왕복 · v2 승격 · 실토큰 복호 · 재암호화 스킴 · 물질화 · 폴더/슬러그 대조 · `.claude.json` 재직렬화 · codex 왕복 · usage 캐시) |
| 실홈 계정 | **6건** — credEnc 복호 **6/6** · 스냅샷(토큰+신원) 온전 **6/6** · 토큰 지문 충돌(오염) **0** |
| `accounts.json` 왕복 | **10,380B → 10,380B, 바이트 동일** |
| `accounts.json.bak-v2`(v2) → v3 승격 | **3,576B → 3,616B**, Node(2.6.2 `writeStoreFile`) 산출물과 **바이트 동일**(§2.2) |
| `codex-accounts.json`(v1) 왕복 | **36B → 36B, 바이트 동일**(계정 0건) |
| 재암호화 스킴 | **v10**(OSCrypt AES-256-GCM) — 1,620B → 1,620B, 자기 복호 성공 |
| 계정 폴더 슬러그 | 실홈 `accounts/` **6/6** 폴더가 우리 슬러그로 정확히 찾아짐 |
| 물질화 검증 | 격리 홈에 실계정 1건 → 토큰·신원·정션 **11/11** 생성, 링크 너머 쓰기가 공유 원본에 도달 |
| 네트워크 호출 | **0건**(크레이트에 HTTP 의존성이 없다 — 구조적으로 불가능) |
| 코드량 | `crates/ccg-auth/src` **3,064줄**(인라인 테스트·프로브 바이너리 포함) |

재현:

```bash
cargo test -p ccg-auth --offline                              # 50 green
cargo test -p ccg-auth --offline -- --nocapture --test-threads=1 | grep '\[m5\]'   # 실홈 수치

# 프로브(진단/왕복) — CCG_HOME이 없으면 실행을 거부한다(실홈 보호)
mkdir -p /tmp/scratch && cp ~/.agentcodegui/{accounts.json,codex-accounts.json} /tmp/scratch/
mkdir -p /tmp/scratch/userData && cp "$APPDATA/agent-code-gui/Local State" /tmp/scratch/userData/
cargo build -p ccg-auth --features cli --offline
CCG_HOME=$(cygpath -w /tmp/scratch) ./target/debug/ccg-auth-probe.exe roundtrip
CCG_HOME=$(cygpath -w /tmp/scratch) ./target/debug/ccg-auth-probe.exe diagnose
```

> `npm run tauri:build`은 **돌리지 않았다.** `ccg-auth`는 아직 `src-tauri`의 의존성이 아니라
> tauri 빌드 그래프에 들어가지 않는다(배선은 다음 라운드, src-tauri는 다른 빌더가 단독 소유).
> 대신 `cargo check --workspace --offline`이 **깨끗이 통과**하고(src-tauri 포함),
> `cargo test -p ccg-store --offline`은 **54 green 그대로**다(내가 안 건드렸다는 증거).

---

## 1. 모듈 배치

| 파일 | 줄 | 대응 2.6.2 원본 | 내용 |
|---|---|---|---|
| `src/lib.rs` | 241 | — | 슬러그·토큰 지문·원자 쓰기·`HttpRequest`/`CommandSpec`·`AuthError` |
| `src/claude.rs` | 879 | `src/main/auth.ts` | `accounts.json` v3/v2 · 스냅샷 · 물질화 · 되싱크 · 진단 |
| `src/codex.rs` | 533 | `src/main/codex/auth.ts` | `codex-accounts.json` v1 · `auth.json`/JWT · `CODEX_HOME` 물질화 |
| `src/junction.rs` | 159 | (Node `fs.symlinkSync(…,'junction')`) | NTFS 정션 생성/판정/해제 |
| `src/usage.rs` | 529 | `auth.ts`·`index.ts`·`codex/auth.ts` | 한도 조회 요청 조립 + 응답 파서 + 디스크 캐시 |
| `src/verify.rs` | 300 | `auth.ts`(status/login/logout) | 생사검증·오염가드·CLI 명령 조립 |
| `src/real_home_tests.rs` | 242 | — | 실홈 검증(복사본) |
| `src/testkit.rs` | 86 | — | 임시 `CCG_HOME`(직렬화 락) + 실홈 복사 도우미 |
| `src/bin/ccg_auth_probe.rs` | 95 | — | `--features cli` 진단 프로브 |

### 1.1 `serde_json/preserve_order`에 기댄 무손실 왕복

계정 레코드를 구조체로 파싱해 **재구성하지 않는다.** 원본 `Map`을 그대로 들고 다니며 아는
키만 `insert`로 갈아끼운다(IndexMap의 자리 보존). 그래서 모르는 키·키 순서가 보존되고,
`credEnc`처럼 값을 바꿔도 자리는 그대로다. 테스트: `unknown_keys_survive_a_roundtrip`.

### 1.2 네트워크 부재가 설계다

`Cargo.toml`에 HTTP 클라이언트 의존성이 없다. 한도 조회·토큰 리프레시·생사검증·로그아웃은
전부 [`HttpRequest`]/[`CommandSpec`] **조립까지만** 한다. 이유:

- 사용자 **실계정**이다. 테스트가 실수로 `claude auth logout`을 부르면 그 순간 토큰이
  서버에서 해지되고, **그 토큰을 담은 저장 스냅샷까지 같이 죽는다**(1.6.1에 실제로 밟은 함정 —
  죽은 토큰을 복원하면 CLI가 401을 맞고 크리덴셜을 243B 껍데기로 덮어 "Not logged in").
- 전송 계층이 없으면 그 사고가 구조적으로 불가능하다.

### 1.3 `ccg-store` 공유 — 중복 0, 수정 0

OSCrypt(safeStorage) 복호/암호는 `ccg_store::safe_storage`를 **그대로 호출**한다
(`decrypt`/`encrypt`/`available`/`write_scheme`/`b64_encode`/`b64_decode`가 이미 전부 `pub`이라
공유화 작업 자체가 필요 없었다). 앱 홈 경로(`app_home`)와 원자 저장(`write_home_file`)도 같다.
스킴이 두 벌이 되면 한쪽만 고쳐지는 순간 사용자가 재로그인하게 되므로 사본을 두지 않았다.
**`crates/ccg-store/`는 한 줄도 수정하지 않았고, 그 크레이트 테스트 54건은 그대로 green이다.**

---

## 2. 스키마 호환 표

### 2.1 파일별

| 파일 | 2.6.2 스키마 | 3.0 읽기 | 3.0 쓰기 | 실홈 실측 |
|---|---|---|---|---|
| `accounts.json` | v3 `{version, defaultEmail?, accounts[]}`<br>레코드 `{email, subscriptionType?, credEnc}` | v3 + **v2**(레코드 포맷 동일) | **항상 v3**(2.6.2 `writeStoreFile`과 같음) | 6계정 10,380B **왕복 바이트 동일** |
| `accounts.json`(v1 이하) | 신원 없음 | **폐기 → 빈 스토어** | — | 해당 없음 |
| `credEnc` 알맹이 | `JSON({creds, account, userID?})` (공백 없는 stringify) | 원본 `Map` 보존 | `{...snap, creds}` 자리 보존 치환 | 6/6 파싱 성공 |
| `.credentials.json` | `{claudeAiOauth:{accessToken, refreshToken, expiresAt, …}}` | 신선도 = `expiresAt`(accessToken 없으면 0, 숫자 아니면 1) | 스냅샷 원문 그대로(재직렬화 안 함) | 6/6 accessToken·refreshToken 보유 |
| `.claude.json` | CLI 소유 + `oauthAccount`·`userID`·`hasCompletedOnboarding` 병합, `stringify(_,null,2)` | 원본 키 순서 보존 | 같은 3키만 얹음 | 실홈 6개 파일 **재직렬화 바이트 동일** |
| `codex-accounts.json` | v1 `{version, defaultEmail?, accounts[]}`<br>레코드 `{email, plan?, authEnc}` | v1만(다른 버전 → 빈 스토어) | v1 | 36B **왕복 바이트 동일**(0계정) |
| `auth.json`(codex) | `{tokens:{id_token,…}, last_refresh}` 또는 `{OPENAI_API_KEY}` | 신선도 = `last_refresh`(ISO), JWT 페이로드에서 email·plan | 백업 원문 그대로 | 등록 계정 0 — 합성 픽스처로만 검증 |
| `usage-cache.json` | `{ "<email>": {at, data:AccountUsage} }`, **들여쓰기 없음** | 항목 단위 관대(깨진 건 버림) | 들여쓰기 없음 | 실홈 **7항목 전부 역직렬화 성공** |

### 2.2 "2.6.2가 그대로 읽는가" — Node 대조

v2 백업을 재료로, ① Rust가 쓴 결과와 ② 2.6.2 `writeStoreFile` 로직을 Node로 그대로 돌린 결과를
바이트 비교했다.

```
node bytes 3616  rust bytes 3616  identical true
2.6.2 readStoreFile 통과: true | accounts 2 | defaultEmail true
```

v3 왕복은 더 강한 증거다 — **원본 파일 자체를 2.6.2가 썼고**, 우리가 되쓴 결과가 그 바이트와
같다(10,380B, `identical: true`).

`JSON.stringify(x, null, 2)` ↔ `serde_json::to_string_pretty` 동치는 다음까지 확인했다:
2칸 들여쓰기 · `": "` 구분자 · 빈 배열 `[]` · **undefined 키 생략**(계정 0개면 `defaultEmail`
자체가 없다) · 정수 표기(`js_number`로 `1787410867317.0` 같은 f64 표기 유출 차단).
실홈 `.claude.json` 6개에는 비정수 JSON 숫자가 **0개**여서(Node로 확인) 재직렬화가 바이트 동일하다.

### 2.3 계정 폴더 슬러그 — 어긋나면 곧 재로그인

```js
safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')   // 연속 구간을 '_' 하나로
h    = (h*31 + email.charCodeAt(i)) >>> 0                   // 소문자화 '전' 원본의 UTF-16 코드 유닛
slug = `${safe}-${h.toString(36)}`
```

실홈에 이미 만들어져 있는 폴더 이름을 그대로 기대값으로 박았다(`lmg56634_gmail.com-68e935` 등
6건 + 대문자/비ASCII 갈래 2건). 실측: **6/6 매칭**.

---

## 3. 격리 CONFIG_DIR 물질화

### 3.1 무엇을 만드는가

```
<home>/accounts/<slug>/
  .credentials.json     ← 스냅샷 토큰(폴더 쪽이 더 신선하면 안 덮는다)
  .claude.json          ← CLI 파일에 oauthAccount·userID·hasCompletedOnboarding 병합
  projects/ sessions/ session-env/ todos/ tasks/ teams/
  agents/ skills/ plugins/ commands/ file-history/    ← 전부 **정션** → <home>/shared/<name>
  settings.json settings.local.json CLAUDE.md         ← 파일이라 복사(정션 불가)
```

### 3.2 정션이어야 하는 이유 (주니어 함정)

`std::os::windows::fs::symlink_dir`(= `CreateSymbolicLinkW`)는 **개발자 모드가 꺼진 일반
사용자 계정에서 `ERROR_PRIVILEGE_NOT_HELD`로 실패**한다. 실패하면 `link_shared_state`가 조용히
넘어가고 → CLI가 계정 폴더 안에 진짜 `projects/`를 파고 → 세션 기록이 계정별로 갈라져
**resume이 죽는다**(대화 맥락이 통째로 사라진 것처럼 보인다). Node가
`fs.symlinkSync(target, path, 'junction')`을 쓴 이유가 이거고, Rust std에는 대응물이 없어
`FSCTL_SET_REPARSE_POINT`(IO_REPARSE_TAG_MOUNT_POINT)를 직접 친다 — 권한 불필요.

판정은 std로 충분하다: Windows에서 `file_type().is_symlink()`는 심링크와 마운트 포인트를
**둘 다** true로 준다 = Node `lstat().isSymbolicLink()`와 같은 판정이라, 2.6.2가 만든 링크와
우리가 만든 링크를 구분 없이 다룬다.

### 3.3 검증한 것

| 항목 | 결과 |
|---|---|
| 실계정 1건 물질화(격리 홈) | 폴더 `lmg56632_gmail.com-1to4267`, 정션 **11/11** 생성 |
| 토큰 | `.credentials.json`에 accessToken·refreshToken 존재 |
| 신원 | `.claude.json`의 `oauthAccount.emailAddress` == 계정 이메일, `hasCompletedOnboarding: true` |
| 격리 | 만들어진 폴더도, **정션 대상도 전부 `CCG_HOME` 안**(실홈을 가리키면 테스트 실패) |
| 링크 너머 쓰기 | `accounts/<slug>/projects/p.jsonl` 쓰기가 `shared/projects/p.jsonl`에 도달 = resume 공유 성립 |
| 삭제 안전 | `remove_account` 후 계정 폴더는 사라지고 **공유 원본 파일은 남음**(정션 먼저 unlink) |
| 관리자 권한 | 불필요(테스트가 일반 사용자 컨텍스트에서 통과) |

### 3.4 토큰 되싱크 가드 (2.6.2 규약 그대로)

물질화: `credsExpiresAt(백업) >= credsExpiresAt(폴더)`일 때만 덮는다 → 직전 실행에서 CLI가
리프레시한 토큰을 죽이지 않는다.
되싱크(`sync_account_tokens`): ① 내용 동일이면 스킵, ② **신선도가 전진하지 않으면 스킵**.
②가 없으면 401을 맞아 껍데기(`{"claudeAiOauth":{}}`)로 덮인 크리덴셜이 백업까지 오염시킨다.
테스트 `resync_refuses_shells_and_backwards_tokens`가 껍데기·후퇴 두 갈래를 잠근다.

### 3.5 실홈의 현재 상태 (읽기만 — 우리가 만든 게 아니다)

6계정 × 11항목 = 66 중 **살아 있는 정션 47개**. 나머지는 2.6.2의 "이미 있으면 그대로 둔다"
규칙이 남긴 자국이다:

| 항목 | 실폴더(공유 안 됨) | 없음(다음 물질화 때 정션 생성) |
|---|---|---|
| `session-env` | 5 | 1 |
| `tasks` | 4 | 1 |
| `todos` | 0 | 4 |
| `file-history` | 0 | 4 |

`projects`·`sessions`는 **6/6 전부 정션**이다(= resume 공유는 살아 있다). 3.0도 같은 규칙을
그대로 쓴다 — 이미 있는 실폴더를 정션으로 바꾸지 않는다(데이터 보존 우선). 이걸 "고칠지"는
제품 결정이라 크레이트에서 임의로 하지 않았다.

---

## 4. 생사검증 · 오염가드 (드라이런)

### 4.1 판정 규약 (1.6.1 `validateSnapshotToken` 이식)

| 신호 | 판정 | 이유 |
|---|---|---|
| usage API 200 | `Alive` | |
| **401 / 403** | `Dead` | 서버가 무효화(해지·그랜트 회전). 적용 금지 + 제거 대상 |
| 429 · 5xx · 네트워크 오류 | `Unknown` | 레이트리밋을 사망으로 읽으면 멀쩡한 계정이 지워진다 |
| accessToken 만료 | `Unknown`(= `NeedsRefresh`) | 리프레시로 살아난다 → 전환 허용 |
| refreshToken 없음 | `NeedsLogin` | 재로그인 외 길 없음 |

### 4.2 오염가드가 생사검증보다 **먼저**다

`preflight(email)`는 서버에 묻기 전에 토큰 지문(sha256 앞 12자)으로 **다른 이메일이 같은 토큰을
물고 있는지** 본다. 오염 항목의 토큰은 **살아 있어서** 서버 확인을 통과해 버리고, 통과시키는
순간 그게 1.6.1의 "전환이 되돌아감"이다(이름표만 B, 실토큰은 A → 다음 실행에서 CLI가
`oauthAccount`를 토큰 주인으로 자가 교정).

`Contaminated`면 `probe`가 `None`으로 나온다 — 물어볼 것도 없다는 뜻.
`import_account_from_dir`의 `ImportGuard::RejectTokenCollision`(2.6.2 마이그레이션 경로의
`collided` 규칙)은 같은 토큰의 다른 이메일 편입을 `AuthError::TokenCollision`으로 거부한다.

**실홈 실측: 토큰 지문 6개 전부 서로 다름 = 오염 0건.**

### 4.3 조립되는 요청/명령 (전부 미발사)

| 목적 | 조립물 |
|---|---|
| 한도/생사검증 | `GET https://api.anthropic.com/api/oauth/usage`<br>`Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, timeout 5s |
| 토큰 리프레시 | `POST console.anthropic.com/v1/oauth/token` → 실패 시 `platform.claude.com/v1/oauth/token`<br>body `{grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-…"}`, timeout 10s |
| 상태 | `claude auth status --json` + `CLAUDE_CONFIG_DIR=<dir>` (읽기 전용) |
| 로그인 | `claude auth login --claudeai|--console` + `CLAUDE_CONFIG_DIR=<home>/login`(임시) |
| 로그아웃(**해지**) | `claude auth logout` + `CLAUDE_CONFIG_DIR=<dir>` |
| codex 한도 | `codex app-server` + `CODEX_HOME=<dir>` → JSON-RPC 2프레임 |
| codex 로그인/로그아웃 | `codex login|logout` + `CODEX_HOME=…` |

---

## 5. 한도 조회 경로 — 코드 실측

**질문: 2.6.2는 usage를 어디서 얻나?** 코드를 열어 확인한 답:

| 엔진 | 경로 | 근거 |
|---|---|---|
| Anthropic | **CLI가 아니다.** 저장된 OAuth 액세스 토큰으로 `api.anthropic.com/api/oauth/usage`에 **직접 HTTPS GET** | `src/main/auth.ts:541` (`fetchAccountUsage`) · `src/main/index.ts:1044` (`fetchUsage`) |
| OpenAI(Codex) | `codex app-server`를 그 계정의 `CODEX_HOME`으로 **짧게 띄워** JSON-RPC `initialize`(id 1) → **`account/rateLimits/read`**(id 2) 한 번 쏘고 kill | `src/main/codex/auth.ts:401,482` (`codexRpcOnce`) |

계정을 **전환하지 않고** 계정 수만큼 조회할 수 있는 게 두 경로의 핵심 성질이고, 그래서
"계정별 한도 표시"가 성립한다.

이식한 세부(전부 테스트로 잠금):

- **Fable 5 주간 한도는 legacy 필드가 아니라 `limits[]`** — `kind === 'weekly_scoped'` +
  `scope.model.display_name`에 `fable` 포함.
- `utilization`은 **숫자로도 문자열로도** 온다(2.6.2가 `parseFloat`을 쓰는 이유) → JS
  `parseFloat` 접두 파싱을 그대로 구현.
- 추가 크레딧 금액은 `{amount_minor, exponent}` / `{money|credits}` **두 래퍼가 다 관찰됨** →
  관대 파서. `enabled:false + disabled_reason:'out_of_credits'`면 잔액 0으로 본다.
- 레이트리밋 정책 상수 이식: 전역 직렬화 간격 **1,200ms**, 계정 캐시 TTL **2분**,
  팝오버 TTL **5분**(강제 새로고침 바닥 **15초**), 429 재시도 대기 기본 15s·상한 30s.
- Codex 창 라벨: `mins<=1440 → "{h}h"/"{h}시간"`, `d==7 → "Weekly"/"주간"`.
  **영어 라벨이 규약**이다 — 설정 화면 정렬이 `'5h'`/`'Weekly'` 텍스트로 시간창을 판별한다.

**검증 방식**: 실 네트워크 호출은 하지 않았다(사용자 실계정 + 429 예산이 분당 1~2건). 대신
① 응답 파서를 골든 JSON으로 잠갔고, ② **실홈 `usage-cache.json`의 7항목이 우리
`AccountUsage` 구조체로 그대로 역직렬화됨**을 확인했다 — 그 캐시는 2.6.2가 실제 응답을 파싱해
쓴 값이므로, 필드 이름·타입이 어긋나면 여기서 깨진다.
③ codex 핸드셰이크 프레임(`initialize` params의 `clientInfo`, `capabilities:null` 포함)을
2.6.2 문자열과 필드 단위로 대조했다. **live 응답 대조는 안 했다**(§7).

---

## 6. 구현이 잡아낸 함정 (2.6.2 코드를 읽는 것만으로는 안 나오는 것)

1. **`CreateSymbolicLinkW`는 권한을 요구한다** → 정션을 직접 구현(§3.2). 이걸 모르고 std
   심링크를 쓰면 사용자 머신에서 조용히 실패하고 resume이 죽는다.
2. **serde의 f64 표기** — `expiresAt`을 f64로 넣으면 `1787410867317.0`으로 저장된다. JS는
   정수로 쓴다. `js_number()`로 정수화(테스트가 문자열까지 확인).
3. **`readStoreFile`은 v2도 읽지만 `writeStoreFile`은 항상 v3** — v2를 읽어 아무 저장이나
   하면 그 순간 승격된다. 되쓰기가 계정 블록을 재작성하면(재암호화 등) 사용자 눈에는 토큰이
   바뀐 것처럼 보인다 → 원본 `Value` 보존이 필수.
4. **`snap.userID !== undefined`** vs `!= null` — 키가 있는데 값이 null인 경우 2.6.2는 null을
   넣는다. `contains_key`로 맞췄다.
5. **`accountSlug`의 해시는 소문자화 전 원본의 UTF-16 코드 유닛**을 돈다. `to_lowercase()`한
   문자열로 해시하면 대문자 섞인 이메일에서 폴더를 못 찾는다.
6. **`credsExpiresAt`의 falsy 검사** — `accessToken: ""`도 0(껍데기)이다. `is_some()`으로
   쓰면 껍데기 토큰이 되싱크 가드를 통과한다.
7. **codex `last_refresh` 없음 → 1**(0이 아니다). 0으로 두면 "파일 없음"과 구분이 안 돼
   껍데기가 실토큰을 이긴다.
8. **로그인 URL 추출은 `https`만** — codex는 첫 줄에 로컬 로그인 서버(`http://localhost:1455.`
   — 문장 끝 마침표까지)를 뱉는다.

---

## 7. 미구현 / 다음 조각

| 항목 | 상태 | 메모 |
|---|---|---|
| **IPC 배선** | 없음 | `src-tauri`·`protocol.ts`는 이번 라운드 경계 밖. 크레이트는 순수 함수 + 조립물만 노출한다 |
| **HTTP 전송** | 없음(의도) | usage 조회·리프레시가 `HttpRequest`까지만. 배선 라운드가 클라이언트를 붙여야 실제 게이지가 뜬다 |
| **live 응답 대조** | 안 함 | 실계정 429 예산 때문. 파서는 골든 JSON + 실홈 캐시 역직렬화로만 잠갔다 |
| **로그인 플로우 실행** | 없음 | 자식 프로세스 스폰·stdout URL 스트리밍·5분 타임아웃·취소는 배선 라운드(명령 조립·URL 추출·상태 파서는 완료) |
| **실 로그아웃(토큰 해지)** | 없음(의도) | `logout_command()` 조립만. 실행하면 **되돌릴 수 없다** |
| **1회 마이그레이션** | 없음 | 2.6.2 `migrateAccounts`(전역 `~/.claude` → `shared` 복사 + 전역 로그인 편입 + v2→v3 승격)와 `migrateCodexAccounts`. **이 사용자 홈에는 마커가 이미 있다**(`shared/.migrated-v3` 2026-07-14, `codex/shared/.migrated-v1` 2026-07-14) → 승계에는 불필요. 새 사용자/미마이그레이션 홈에는 필요 |
| **`claude.exe` 경로 해석** | 없음 | `claudeBin()`은 `app.isPackaged`·`resourcesPath` 등 앱 셸 지식이라 `bin: &str` 인자로 받는다 |
| **usage 큐 실행** | 상수만 | 직렬화 큐·인플라이트 합치기·TTL 캐시 갱신은 런타임 정책 → 배선 라운드 |
| **codex 실계정 검증** | 못 함 | 실홈 `codex-accounts.json`이 **0계정**. 물질화·JWT·신선도는 합성 픽스처로만 검증됐다 |
| **`reorder_accounts` 중복 입력** | 의도적 차이 | 2.6.2는 입력에 같은 이메일이 두 번 있으면 레코드를 **두 번** 넣는다(참조 비교). 우리는 중복을 제거한다 |
| **계정 폴더 파일 쓰기** | 의도적 차이 | 2.6.2는 `writeFileSync`(비원자) — 도중에 죽으면 잘린 `.credentials.json`이 남고 그게 곧 로그아웃이다. 우리는 tmp→rename(실패 시 tmp 삭제) |
| **`usage-cache.json` 4키 폴백형** | 의도적 차이 | 2.6.2는 조회 실패 시 `{email, …Pct:null}` 4키만 쓴다. 우리는 항상 7키(리셋 3필드를 `null`로). 2.6.2 리더는 두 형태를 다 받는다(optional 선언) |

---

## 8. 경계 준수

- 쓴 파일: `crates/ccg-auth/**`(신설 10파일), `Cargo.toml`(members 1줄), `docs/m5-report-r1.md`.
- `crates/ccg-store/src/safe_storage.rs`: **수정 없음**(공유화가 필요 없었다 — 전부 이미 `pub`).
- `src-tauri/`·`app/`·`src/shared/protocol.ts`·`src/main/`: 읽기만.
- 실홈: **읽기/복사만.** 테스트는 `CCG_HOME`을 `%TEMP%`로 돌리고 종료 시 지운다. 프로브
  바이너리는 `CCG_HOME`이 없으면 실행을 거부한다.
- 프로세스: 아무것도 스폰하지 않았다(`cargo`/`node` 외). 사용자 앱 kill 없음.
