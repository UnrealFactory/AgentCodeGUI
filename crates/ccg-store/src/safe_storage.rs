//! **2.6.2 safeStorage 스킴 읽기** — 저장된 API 키를 재로그인 없이 승계한다.
//!
//! Electron의 `safeStorage`는 Windows에서 Chromium OSCrypt를 탄다. 실측(벤치 픽스처가
//! 이미 이 사실 위에 서 있다 — `bench/fixture.mjs`의 Local State 복사):
//!
//! ```text
//! <userData>/Local State   →  os_crypt.encrypted_key = base64("DPAPI" || DPAPI(AES-256 key))
//! api-config.json.key      →  base64("v10" || nonce(12) || AES-256-GCM(ct || tag(16)))
//! ```
//!
//! 두 갈래를 다 읽는다:
//!  - `v10` 접두사 → Local State의 AES 키로 AES-256-GCM 복호
//!  - 접두사 없음  → DPAPI 직접 복호(`CryptUnprotectData`) — OSCrypt가 키를 못 만든 환경
//!
//! **쓰기(★R2 D6)**: Local State의 OSCrypt 키가 있으면 **`v10`으로 쓴다.** 없을 때만
//! DPAPI 직접이다.
//!
//! R1은 "Chromium `DecryptString`이 `v10` 접두사가 없으면 DPAPI로 폴백하니 2.6.2도 읽는다"고
//! 적었는데 **거짓이었다.** Electron의 `safeStorage.decryptString`은 OSCrypt에 넘기기 전에
//! 접두사를 검사하고 거부한다(실측 에러: *"Ciphertext does not appear to be encrypted."*).
//! 그래서 3.0에서 키를 한 번 넣으면 2.6.2로 되돌렸을 때 `hasKey:true`인데 실행만 실패하는
//! 조용한 불일치가 생겼다 = 롤백 경로가 끊겼다.
//!
//! 남은 정직한 제약 하나: **2.6.2가 없던 환경**(Local State 없음)에서는 OSCrypt 키가 없어
//! DPAPI로 쓴다. 그 홈에서 2.6.2로 "되돌리면" 키는 다시 넣어야 한다 — 애초에 그 홈에는
//! 되돌릴 2.6.2가 없다.
//!
//! `<CCG_HOME>/userData/Local State`를 먼저 본다 — 격리 홈(벤치·dev)이 설치본 키를
//! 복사해 쓰는 규약과 같은 자리다. 없으면 설치본 경로(`%APPDATA%/agent-code-gui`).

const V10: &[u8] = b"v10";
const DPAPI_TAG: &[u8] = b"DPAPI";

/// base64 디코드 — 표준 알파벳, 패딩 관용(암호가 아니라 표현 변환이라 손으로 둔다).
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = val(c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

pub fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Chromium `Local State`의 OSCrypt AES 키(32바이트). 없으면 None.
#[cfg(windows)]
fn os_crypt_key() -> Option<Vec<u8>> {
    for p in local_state_paths() {
        let Ok(raw) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let Some(b64) = v.get("os_crypt").and_then(|o| o.get("encrypted_key")).and_then(|k| k.as_str()) else {
            continue;
        };
        let Some(blob) = b64_decode(b64) else { continue };
        if !blob.starts_with(DPAPI_TAG) {
            continue;
        }
        if let Some(key) = dpapi_unprotect(&blob[DPAPI_TAG.len()..]) {
            if key.len() == 32 {
                return Some(key);
            }
        }
    }
    None
}

#[cfg(windows)]
fn local_state_paths() -> Vec<std::path::PathBuf> {
    let mut v = vec![crate::app_home().join("userData").join("Local State")];
    if let Ok(appdata) = std::env::var("APPDATA") {
        v.push(std::path::PathBuf::from(appdata).join("agent-code-gui").join("Local State"));
    }
    v
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut out).ok()?;
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData as *mut core::ffi::c_void)));
        Some(slice)
    }
}

#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&mut input, None, None, None, None, 0, &mut out).ok()?;
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData as *mut core::ffi::c_void)));
        Some(slice)
    }
}

/// 저장된 값(base64) → 원문. 어떤 갈래로도 못 풀면 None(= "키 없음"으로 취급).
#[cfg(windows)]
pub fn decrypt(b64: &str) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    let blob = b64_decode(b64)?;
    if blob.starts_with(V10) {
        let key = os_crypt_key()?;
        if blob.len() < V10.len() + 12 + 16 {
            return None;
        }
        let nonce = &blob[V10.len()..V10.len() + 12];
        let ct = &blob[V10.len() + 12..];
        let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
        let plain = cipher.decrypt(Nonce::from_slice(nonce), ct).ok()?;
        return String::from_utf8(plain).ok();
    }
    // OSCrypt 키가 없던 환경(구 Electron·DPAPI 직접) — 그대로 풀린다
    String::from_utf8(dpapi_unprotect(&blob)?).ok()
}

/// 암호학적 난수(BCryptGenRandom — 이미 있는 `windows` 크레이트, 새 의존성 없음).
#[cfg(windows)]
fn rand_bytes(n: usize) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut buf = vec![0u8; n];
    let st = unsafe { BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if st.is_ok() {
        Some(buf)
    } else {
        None
    }
}

/// 원문 → 저장 값(base64).
///
/// ★R2 D6 — **Local State의 OSCrypt 키가 있으면 `v10`으로 쓴다**(2.6.2 `safeStorage`가
/// 읽는 유일한 모양). 키가 없는 환경에서만 DPAPI 직접으로 떨어진다.
#[cfg(windows)]
pub fn encrypt(plain: &str) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    if let Some(key) = os_crypt_key() {
        if let (Some(nonce), Ok(cipher)) = (rand_bytes(12), Aes256Gcm::new_from_slice(&key)) {
            if let Ok(ct) = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()) {
                let mut blob = V10.to_vec();
                blob.extend_from_slice(&nonce);
                blob.extend_from_slice(&ct);
                return Some(b64_encode(&blob));
            }
        }
    }
    Some(b64_encode(&dpapi_protect(plain.as_bytes())?))
}

/// 지금 쓰기가 어느 스킴을 쓰는가 — 리포트/하네스용(키 원문은 절대 나가지 않는다).
#[cfg(windows)]
pub fn write_scheme() -> &'static str {
    if os_crypt_key().is_some() {
        "v10"
    } else {
        "dpapi"
    }
}
#[cfg(not(windows))]
pub fn write_scheme() -> &'static str {
    "none"
}

/// 암호화를 쓸 수 있는가 — 2.6.2 `safeStorage.isEncryptionAvailable()` 자리.
#[cfg(windows)]
pub fn available() -> bool {
    dpapi_protect(b"probe").is_some()
}

#[cfg(not(windows))]
pub fn decrypt(_b64: &str) -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn encrypt(_plain: &str) -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrips_including_padding_cases() {
        for s in ["", "a", "ab", "abc", "abcd", "hello world!", "\u{1F600}"] {
            let enc = b64_encode(s.as_bytes());
            assert_eq!(b64_decode(&enc).unwrap(), s.as_bytes(), "roundtrip {s:?} → {enc}");
        }
        // 알려진 벡터 (Node Buffer.from('v10').toString('base64'))
        assert_eq!(b64_encode(b"v10"), "djEw");
        assert_eq!(b64_decode("djEw").unwrap(), b"v10");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrips_on_this_machine() {
        // DPAPI는 이 Windows 사용자 컨텍스트에서만 풀린다 — 왕복만 확인한다
        if !available() {
            return;
        }
        let enc = encrypt("sk-ant-test-0000").unwrap();
        assert_eq!(decrypt(&enc).as_deref(), Some("sk-ant-test-0000"));
    }

    /// ★R2 D6 — Local State가 있으면 **v10으로 쓴다**(2.6.2 `safeStorage`가 읽는 유일한 모양).
    /// 없는 머신에서는 DPAPI 폴백이고, 그 갈래도 자기 자신은 읽는다.
    #[cfg(windows)]
    #[test]
    fn the_write_scheme_is_v10_whenever_the_oscrypt_key_exists() {
        let h = crate::testkit::temp_home("safestorage-v10");
        let key_src = std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
            .join("agent-code-gui")
            .join("Local State");
        if !key_src.is_file() {
            return; // 2.6.2 미설치 머신 — 폴백 갈래만 유효하다
        }
        std::fs::create_dir_all(h.path("userData")).unwrap();
        std::fs::copy(&key_src, h.path("userData/Local State")).unwrap();
        assert_eq!(write_scheme(), "v10");
        let enc = encrypt("sk-ant-v10-roundtrip").unwrap();
        assert!(b64_decode(&enc).unwrap().starts_with(V10), "v10 접두사가 없으면 2.6.2가 거부한다");
        assert_eq!(decrypt(&enc).as_deref(), Some("sk-ant-v10-roundtrip"));
    }

    #[cfg(windows)]
    #[test]
    fn nonces_never_repeat() {
        let a = rand_bytes(12).unwrap();
        let b = rand_bytes(12).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 12);
    }
}
