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

---

# §R2 — 크리틱 지적 반영 (M5 R1 크리틱 `docs/critic/m5-r1.md`)

판정은 **조건부 합격**이었다. 깨진 것 1 + 잔금 3. 다섯 항목 전부 고쳤고, 고쳤다는 증거는
**크리틱 자신의 도구를 그대로 다시 돌려** 냈다(내 하네스를 새로 만들지 않았다).

| # | 크리틱 지적 | 상태 | 잠근 방법 |
|---|---|---|---|
| 4-1 | **[깨짐]** 오염가드가 계정 순서에 좌우된다 | 고침 | `token_owners`(목록) + `token_collision`(자기 제외) — `diagnose`와 **같은 로직 단일 소스**. 폴더 쪽 토큰도 본다 |
| 4-2 | [잔금] `reorder_accounts`가 중복 이메일 레코드를 유실 | 고침 | 이메일이 아니라 **인덱스**로 잡는다(= 2.6.2 참조 비교). codex 쌍둥이도 같이 |
| 4-3 | [잔금] usage 파서 12/71 불일치 | 고침 | `js.rs`(JS 강제변환·`Date.parse` 미러) + **71케이스 골든 편입** → 0/71 |
| 4-4 | [잔금] `version: 3.0`·usage 캐시 관대성이 2.6.2보다 좁다 | 고침 | 버전 비교를 `as_f64`(JS `3.0 === 3`), 캐시는 `v && v.data` 규칙으로 직접 읽는다 |
| 2/5 | `verify.rs`의 "`auth status`는 읽기 전용" 오기 | 고침 | 주석 정정 + **타입으로 봉인**(`IsolatedConfigDir`) |
| 4-5 | [메모] 파서 커버리지 구멍 · 실홈 테스트의 선의의 실패 | 고침 | 골든 71케이스가 구멍을 덮고, 실홈 폴더 테스트는 **폴더 신원 기준**으로 뒤집었다 |

테스트 **50 → 67**(+17). `cargo clippy -p ccg-auth --all-targets` 경고 **0**.

---

## R2-1. 오염가드 — 순서 의존 제거 (`claude.rs` · `verify.rs`)

R1은 `token_owner`(`find_map` = 첫 일치)로 판정하고 `!= email`을 봤다. 그래서 오염 쌍 중
스토어에서 **앞에 있는 쪽은 자기 자신을 찾아 통과**했다. 순서는 사용자가 설정 → Account에서
드래그로 바꾸는 값이라, 같은 오염이 재정렬 한 번에 통과/차단으로 뒤집혔다.

```rust
pub fn token_owners(creds: &str) -> Vec<String>                     // 지문 일치 계정 전부
pub fn token_collision(creds: &str, email: &str) -> Option<String>  // 자기 제외 첫 소유자
```

- `preflight`와 `import_account_from_dir`(`RejectTokenCollision`)이 **둘 다** `token_collision`을
  쓴다. 편입 가드도 같은 비대칭을 갖고 있었다(크리틱이 preflight만 짚었지만 같은 병이다).
- 곁다리 지적도 반영: `token_owner`는 **백업만** 비교해 폴더(`.credentials.json`) 쪽 오염을
  못 봤다. `token_owners`는 계정 폴더의 살아 있는 토큰도 지문으로 대조한다 —
  백업이 아직 안 갈렸어도 폴더끼리 같은 토큰이면 이미 오염이다.
- `token_owner`는 **없앴다.** 남겨두면 "첫 일치" 함정이 다시 불려 갈 자리다.

**크리틱 시나리오 재실행**(같은 도구 `m5drive.exe contamination`, CCG_HOME 격리):

```
배치 [a, b]           preflightA=Contaminated("b@x.com") probeA=false
                      preflightB=Contaminated("a@x.com") probeB=false
드래그 재정렬 [b, a]   preflightA=Contaminated("b@x.com") probeA=false
                      preflightB=Contaminated("a@x.com") probeB=false
diagnose              양쪽 배치에서 둘 다 collides_with 있음
```

R1은 여기서 앞엣것이 `Probe(통과!)`였다. 잠금 테스트 —
`verify::tests::contamination_verdict_does_not_depend_on_store_order`(두 배치 × 두 계정 전수),
`contamination_also_sees_the_folder_side_token`,
`claude::tests::token_owners_lists_everyone_regardless_of_order`,
`guarded_import_rejects_regardless_of_order`.

## R2-2. `reorder_accounts` — 레코드 유실 제거 (`claude.rs` · `codex.rs`)

2.6.2의 `if (!next.includes(a))`는 **참조 비교**라 같은 이메일 레코드가 둘이면 둘 다 남는다.
R1은 이메일로 걸러서 두 번째 레코드(= 그 계정의 암호화 토큰 백업)가 드래그 한 번에 사라졌다.
`next.push` 조건을 **인덱스**로 바꿔 참조 비교와 같은 의미론으로 만들었다.
`new Map(...)`이 마지막 레코드를 고르는 것까지 `rposition`으로 맞췄다 — **순서도 2.6.2와 같다.**

```
스토어 [dup(TOK-1), dup(TOK-2), ok(TOK-3)] → reorder(['ok','dup'])
  2.6.2 : [ok(TOK-3), dup(TOK-2), dup(TOK-1)]  3건
  R1    : 2건 (TOK-2 백업 소멸)
  R2    : [ok(TOK-3), dup(TOK-2), dup(TOK-1)]  3건 ← credEnc 지문 3개 전부 상이(실측)
```

같은 병이 `codex::reorder_accounts`에도 있어 같이 고쳤다(`authEnc` 유실).
남은 의도적 차이 하나: **입력** `emails`에 같은 이메일이 두 번 오면 2.6.2는 레코드를 두 벌로
**복제**해 저장한다. 우리는 한 번만 놓는다 — 복제는 없던 계정을 만드는 쪽이라 유실 금지 원칙과
방향이 반대다(§7 표의 "의도적 차이" 항목을 이 문장으로 대체한다).

## R2-3. usage 파서 — 12/71 → 0/71 (`js.rs` 신설 · `usage.rs`)

2.6.2 파서는 **JS의 느슨한 변환에 그대로 기대고** 있다. `as_bool()`/`as_f64()`/`f64::round()`로
옮긴 게 불일치의 원인이었다. 변환기를 따로 두고 규칙만 미러했다 — `crates/ccg-auth/src/js.rs`.

| 크리틱이 짚은 입력 | 2.6.2 | R1 | R2 |
|---|---|---|---|
| `spend.enabled: 1` / `"yes"` | `true` | `false` | `true` (`js::truthy` = `!!`) |
| `limits[].percent: "77"` / `true` | 77 / 1 | 0 / 0 | 77 / 1 (`js::to_number` = ToNumber, `parseFloat` 아님) |
| `resets_at: "2026-08-20"` · `"…T15:00Z"` | 파싱됨 | `null` | 파싱됨 (ECMA Date Time String Format 전 형식) |
| `resets_at: "…T15:00:00"`(존 없음) | 로컬시 | UTC | **로컬시** (`TzSpecificLocalTimeToSystemTime` — DST 규칙까지 OS에 묻는다) |
| `resets_at: "…+09"`(분 없는 오프셋) | `null` | 파싱됨 | `null` (스펙대로 무효) |
| `resets_at: 12345`(숫자) | 12345년 | `null` | 12345년 (`String()` 강제변환 + 레거시 연도) |
| `utilization: "1e2"` / `"Infinity"` / `"1e-7"` | 100 / 100 / 0 | 1 / 0 / 1 | 100 / 100 / 0 |

곁다리로 같이 맞춘 것(코퍼스엔 없지만 같은 계열): `Math.round`는 **half up(+∞ 쪽)** 이라
`Math.round(-2.5) = -2`인데 Rust `f64::round`는 -3이다 → `js::round`. `win(o)`와 `spend`의
존재 판정이 JS 진위값이라 `five_hour: 0`이면 창이 **없다**(R1은 창을 만들었다).

**골든 편입**: `crates/ccg-auth/src/usage_golden_2_6_2.json`(71케이스 × 2.6.2 출력).
손으로 적은 기대값이 **하나도 없다** — 크리틱 도구가 뽑은 그대로다.

```bash
node docs/critic/tools/critic-m5-ucases.cjs | node docs/critic/tools/critic-m5-uparse262.cjs
```

존 없는 시각이 로컬시라 골든에 `localOffsetMinutes: 540`을 적고 테스트가 그 오프셋을
**고정**한다(`js::with_fixed_local_offset` — 스레드 로컬). 다른 타임존 머신에서도 같은 판정이
나오고, 실환경 경로가 진짜 OS 오프셋을 쓰는지는 별도 테스트가 본다
(`js::tests::production_path_uses_the_real_os_offset` — DST 없는 존에서는 바이어스와 정확히 일치).

**크리틱 도구 재실행**(우리 파서 = 워크스페이스 밖 드라이버 `uparse.exe`):

```
node critic-m5-ucases.cjs | node critic-m5-uparse262.cjs   ->  A
node critic-m5-ucases.cjs | %TEMP%/m5t/debug/uparse.exe    ->  B
총 71케이스 / 불일치 0        (R1: 12)
```

**대역은 정직하게**: ECMA-262의 ToBoolean/ToNumber/ToString/`parseFloat`과 Date Time String
Format은 그대로 옮겼고, `Date.parse`의 **V8 레거시 갈래**는 코퍼스가 밟는 만큼만 옮겼다
(구분자 `t`/공백, `±HHmm` 오프셋, 폭이 자유로운 `Y-M-D`, 5~6자리 맨 연도 — 전부 존 표기가
없으면 로컬시). 그 밖의 레거시 표기(`"Aug 20 2026"` 같은 자연어 날짜)는 `None`이다.
`1e21` 이상의 숫자 문자열화도 JS의 `1e+21` 표기와 갈리는데, usage 응답에 그 값이 올 자리가 없다.

## R2-4. 관대성 — 스토어 버전 · usage 캐시 (`claude.rs` · `codex.rs` · `usage.rs`)

- `read_store_file`의 버전 비교를 `as_u64` → `as_f64`로. JS는 `3.0 === 3`이고, R1은 부동소수
  표기 하나에 **빈 스토어 = 계정 0건 = 재로그인 화면**이 됐다. 문자열 `"3"`은 양쪽 다 폐기
  (JS도 `'3' !== 3`). `codex::read_store_file`도 같이 고쳤다(같은 실패 모드).
- `read_usage_cache`를 serde 파생 대신 **2.6.2 규칙(`if (v && v.data)`)** 으로 직접 읽는다.
  `at` 누락·실수 `pct`·4키 폴백형을 더는 버리지 않는다. 캐시는 퍼센트뿐이라 관대해서 잃을 게
  없고, 버리면 게이지가 빈 채로 뜬다.

**크리틱 도구 재실행**(`edge.exe`):

```
version=3   -> accounts=1      version=2   -> accounts=1
version=3.0 -> accounts=1  <-   version=2.0 -> accounts=1  <-   (R1: 둘 다 0)
version="3" -> accounts=0      version=4   -> accounts=0
usage cache 읽힌 키 = ["a@x.com","b@x.com","c@x.com","e@x.com"]   (R1: a,c 2건 / 2.6.2: 4건)
nasty.json 357B · 슬러그 7종 전부 R1과 동일
```

## R2-5. `auth status`는 읽기 전용이 아니다 — 주석 정정 + **타입 봉인** (`lib.rs` · `verify.rs`)

`verify.rs:22`의 "**읽기 전용**이다(파일을 쓰지 않는 것 실측)"는 틀린 주석이었다. 크리틱 §2.1
실측대로, 실행 후 `.claude.json`에 `firstStartTime`·`migrationVersion`·`seenNotifications`·
`opusProMigrationComplete`가 붙고 `backups/`가 생긴다. 주석을 그 실측으로 갈아끼웠다.

주석만 고치면 다음 라운드가 또 밟는다. **"물질화 폴더 밖(실홈)을 향해 CLI를 돌리는 경로가
없다"를 타입으로 보증**했다:

```rust
pub struct IsolatedConfigDir(PathBuf);        // 앱 홈 안에서만 만들어진다
IsolatedConfigDir::new(&path)                 // 앱 홈 밖 · `..` 포함 · 홈 자기 자신 -> None
IsolatedConfigDir::for_claude_account(email)  // = account_run_dir(물질화까지)
IsolatedConfigDir::for_claude_login() / for_codex_account / for_codex_login

pub fn status_command(bin: &str, config_dir: &IsolatedConfigDir) -> CommandSpec   // &Path 안 받는다
pub fn logout_command(…) · codex_logout_command(…) · usage::codex_app_server_command(…)
```

`&Path`를 받는 CLI 조립기가 **하나도 없다**. 사용자 실홈(`~/.claude`·`~/.codex`)으로는 증표를
만들 수 없고, 증표가 없으면 명령도 못 만든다 — 이 단정이 깨지려면 타입을 먼저 뜯어야 한다.
`codex app-server`(한도 조회)도 같은 하자였다: `CODEX_HOME`을 실홈으로 주면 그쪽 토큰이 회전한다.

테스트 `verify::tests::no_cli_command_can_ever_point_at_the_users_real_home` — `~/.claude`·
`~/.codex`·`~/.agentcodegui`·홈 자기 자신·`..` 탈출·`C:\`가 전부 `None`이고, 조립되는 6개
명령의 env가 전부 앱 홈 아래를 가리킨다.

## R2-6. 실홈 테스트의 "선의의 실패" (`real_home_tests.rs`)

`real_account_folders_match_our_slug_and_junction_rules`가 "등록 계정 **전부**에 폴더가 있다"를
단정해서, 사용자가 계정을 추가만 하고 안 쓰면 빨개졌다. 진짜 위험은 반대쪽이다 — "그 계정의
폴더가 **다른 이름으로** 이미 있다"(= 3.0이 새 폴더를 파고 재로그인). 판정을 폴더 쪽에서
하도록 뒤집었다: `accounts/<name>/.claude.json`의 신원(`oauthAccount.emailAddress`)을 읽어
`account_slug(email) == name`을 단정한다.

```
[m5] 실홈 계정 폴더: 신원 대조 6건 전부 슬러그 일치 · 등록 계정 중 폴더 있음 6/6
     — 살아 있는 정션 47개 / 폴더 토큰 미만료 4 / 백업보다 신선 2
```

47개는 크리틱의 Node 센서스(§1)와 같은 값이다.

---

## R2-7. 재실행한 크리틱 도구 — 전부 green

전부 **크리틱이 커밋한 도구 그대로**다(내가 만든 하네스가 아니다). 실홈은 읽기/복사만 했다.

| 도구 | 결과 | R1 대비 |
|---|---|---|
| `cargo test -p ccg-auth --offline` | **67 passed / 0 failed** | 50 → 67 |
| `cargo clippy -p ccg-auth --all-targets` | 경고 0 | 동일 |
| `critic-m5-ucases.cjs \| uparse262` vs `uparse.exe` | 71케이스 **불일치 0** | 12 → 0 |
| `m5drive.exe contamination`(배치 [a,b] / [b,a]) | 양쪽 배치 · 양쪽 계정 전부 `Contaminated` | 앞엣것 `Probe` → 고침 |
| `m5drive.exe seed → reorder`(중복 이메일) | 3건 유지 · credEnc 지문 3개 상이 | 2건 → 3건 |
| `edge.exe` | version 3.0/2.0 = 1건 · 캐시 4키 · nasty 357B · 슬러그 동일 | 3.0/2.0 0건, 캐시 2건 → 고침 |
| `jattack.exe` | 정션 공격 8종 전부 R1과 동일한 결과 | 회귀 없음 |
| `ccg-auth-probe roundtrip`(실홈 사본) | `accounts.json` 10,380B **identical** 6계정 · `codex-accounts.json` 36B identical | 동일 |
| `ccg-auth-probe diagnose`(실홈 사본) | 복호 6/6 · 스냅샷 온전 6/6 · 오염 0 · 지문 6개 상이 · writeScheme v10 | 동일 |
| `critic-m5-262reader.cjs read`(Electron 42 실 safeStorage) | 3.0이 reorder+setdefault+**credEnc 재암호화**한 뒤 v3 6계정 · `allRunnable=true` · 스냅샷 키 `[creds,account,userID]` · 복호 6/6 | 동일 |

실홈 `accounts.json` md5는 작업 전후 `20bdd3c0c4d357f98c8e40ad76ad3773`으로 **같다**
(크리틱 때의 `21203beb…`와 다른 건 그 사이 사용자가 앱을 써서 토큰이 되싱크됐기 때문 —
내 작업은 전부 `%TEMP%` 사본에서 했다). 사용자 앱 프로세스는 건드리지 않았고
(`AgentCodeGUI.exe` 3개 그대로 살아 있다), 내가 띄운 electron은 스스로 종료했다(잔류 0).
네트워크로 나간 토큰은 0건이다 — 크레이트에 전송 계층이 없다.

## R2-8. 공개 API 변경 (배선 라운드가 알아야 할 것)

| 전 | 후 | 왜 |
|---|---|---|
| `claude::token_owner(creds) -> Option<String>` | **삭제** → `token_owners(creds) -> Vec<String>` · `token_collision(creds, email) -> Option<String>` | "첫 일치"가 순서 함정이라 자리를 없앴다 |
| `usage::to_ts(Option<&str>)` | `usage::to_ts(Option<&Value>)` | 2.6.2는 문자열이 아닌 값도 `String()`으로 강제변환해 `Date.parse`에 넘긴다 |
| `verify::status_command(bin, &Path)` | `(bin, &IsolatedConfigDir)` | 실홈을 향할 수 없게 |
| `verify::logout_command(bin, &Path)` | `(bin, &IsolatedConfigDir)` | 〃 (해지는 되돌릴 수 없다) |
| `verify::codex_logout_command(bin, &Path)` | `(bin, &IsolatedConfigDir)` | 〃 |
| `usage::codex_app_server_command(bin, &Path)` | `(bin, &IsolatedConfigDir)` | 실홈 `CODEX_HOME`이면 그쪽 토큰이 회전한다 |
| — | `pub mod js` 신설 | JS 강제변환·`Date.parse` 미러 |

`Cargo.toml`은 `windows` 기능에 `Win32_System_Time` 한 줄이 늘었다(**새 패키지가 아니다** —
로컬 타임존 조회용). `cargo check -p ccg-auth -p ccg-store -p ccg-engine` 통과.
`cargo check --workspace`는 이 시점에 `src-tauri`가 다른 빌더의 작업 중(`Hub.route` 누락·
`TerminalStatus::Aborted` 미처리)이라 빨간데, **`src-tauri`는 `ccg-auth`를 물지 않는다**
(`src-tauri/Cargo.toml`에 `ccg-store`·`ccg-engine`만) — 내 변경과 무관하다.

## R2-9. 이번에도 안 한 것

- **live 응답 대조**: 여전히 안 했다. 파서는 골든 71 + 실홈 캐시 역직렬화로만 잠갔다.
- **실토큰 CLI 턴**: 크리틱이 합성 토큰으로만 확인하고 "배선 크리틱 몫"으로 남긴 그대로다.
  실토큰으로 `auth status`를 돌리면 리프레시 회전이 일어나 실홈 백업이 죽을 수 있다.
- **`Date.parse`의 자연어 갈래**: §R2-3의 대역 문단대로 안 옮겼다.
- **IPC 배선·HTTP 전송·로그인 실행·1회 마이그레이션**: §7 그대로 배선 라운드 몫.
