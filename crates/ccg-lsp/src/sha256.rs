//! SHA-256 — **설치기가 나르는 `node.exe`가 우리가 핀으로 박은 그 파일인가**를 확인한다.
//!
//! 왜 이 크레이트에 또 해시가 필요한가(옆에 [`crate::sha1`]이 이미 있다): 그쪽은
//! 2.6.2와의 **캐시 바이트 호환**이 목적이라 알고리즘을 바꿀 수 없고, 이쪽은 **적재물의
//! 출처 검증**이 목적이라 nodejs.org가 `SHASUMS256.txt`에 쓰는 알고리즘이어야 한다.
//! 둘은 같은 자리에 못 선다.
//!
//! ★R3 · 확인 크리틱 R2 **R2-C2**가 판 자리다. R2의 매니페스트 계약은 `bundle.resources`의
//! **값(목적지)만** 읽고 키(출처)는 한 번도 안 봤다. 크리틱의 회피 변이 E3이 그 구멍으로
//! 들어왔다 — `dest=node.exe` · `src=…/pyright/LICENSE.txt`. 목적지 문자열은 완벽하고,
//! 파일은 실재하고, 계약은 **초록**이고, 사용자의 `$INSTDIR\node.exe`는 텍스트 파일이 된다.
//! 그리고 R2가 PATH를 끊었으므로 **복구 경로가 없다.**
//!
//! 그래서 계약이 이제 스테이징된 실물의 해시를 `scripts/tauri-build.mjs`의 `NODE_PIN`과
//! 맞춰 본다([`crate::spec::tests`]). 스테이징 스크립트도 같은 해시를 보지만, 그건
//! **빌드 시각**의 검사다 — 그 뒤에 파일이 바뀌면 아무도 안 본다.
//!
//! 검증: 아래 테스트가 NIST 표준 벡터 + 빈 문자열 + 블록 경계(55/56/64/119/120바이트)를 본다.

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub struct Sha256 {
    h: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            h: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0; 64],
            buf_len: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        // 앞선 조각이 남아 있으면 64바이트를 채워서 먼저 흘린다.
        if self.buf_len > 0 {
            let need = 64 - self.buf_len;
            let take = need.min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            let mut b = [0u8; 64];
            b.copy_from_slice(block);
            self.compress(&b);
            data = rest;
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.total.wrapping_mul(8);
        self.update_no_count(&[0x80]);
        while self.buf_len != 56 {
            self.update_no_count(&[0]);
        }
        self.update_no_count(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (i, w) in self.h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
        }
        out
    }

    /// 패딩용 — 길이 카운터를 안 올린다(그 값은 이미 확정됐다).
    fn update_no_count(&mut self, data: &[u8]) {
        for &b in data {
            self.buf[self.buf_len] = b;
            self.buf_len += 1;
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, v) in [a, b, c, d, e, f, g, h].into_iter().enumerate() {
            self.h[i] = self.h[i].wrapping_add(v);
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 파일 하나의 sha256(소문자 hex). 89MB를 통째로 안 올리고 1MB씩 흘린다 —
/// 이 함수를 부르는 자리가 `cargo test`라 메모리 급증이 남의 테스트를 흔들면 안 된다.
pub fn file_hex(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> String {
        let mut h = Sha256::new();
        h.update(s.as_bytes());
        hex(&h.finish())
    }

    /// NIST 표준 벡터 — 이게 맞아야 nodejs.org의 `SHASUMS256.txt`와 같은 눈금이다.
    #[test]
    fn nist_vectors() {
        assert_eq!(d(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(d("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            d("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            d("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
        );
    }

    /// 블록 경계 — 패딩이 한 블록을 더 밀어야 하는 자리(55/56/63/64/119/120)에서 틀리기 쉽다.
    #[test]
    fn block_boundaries() {
        for n in [55usize, 56, 57, 63, 64, 65, 119, 120, 128] {
            let s = "a".repeat(n);
            // 한 번에 넣은 값과 **한 바이트씩** 넣은 값이 같아야 한다(스트리밍 상태기 검증).
            let one = d(&s);
            let mut h = Sha256::new();
            for b in s.as_bytes() {
                h.update(&[*b]);
            }
            assert_eq!(one, hex(&h.finish()), "n={n}");
        }
        // 알려진 값 하나로 못을 박는다(1,000,000 × 'a'는 느려서 안 쓴다).
        assert_eq!(d(&"a".repeat(64)), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
    }

    /// 조각을 나눠 넣어도 같은 값 — `file_hex`가 1MB씩 흘리는 것의 근거.
    #[test]
    fn chunked_update_matches_one_shot() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let mut a = Sha256::new();
        a.update(&data);
        let mut b = Sha256::new();
        for c in data.chunks(7) {
            b.update(c);
        }
        assert_eq!(hex(&a.finish()), hex(&b.finish()));
    }
}
