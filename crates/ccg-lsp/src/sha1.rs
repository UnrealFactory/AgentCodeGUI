//! SHA-1 — Node의 `crypto.createHash('sha1')`과 **바이트 단위로 같은** 결과.
//!
//! 왜 직접 쓰는가: 3.0이 2.6.2와 **같은 토큰 디스크 캐시를 공유**하기 때문이다
//! (`<앱 홈>/lsp/semcache/…`). 캐시 키는 2.6.2가 SHA-1로 만들었고, 다른 해시를 쓰면
//! 같은 폴더에 평행 우주가 하나 더 생겨서 (a) 업그레이드한 사용자가 첫 실행에 캐시를
//! 통째로 잃고 (b) 캐시 상한(4000개)을 두 배로 쓴다. 의존성 하나를 아끼려는 게 아니라
//! **바이트 호환이 목적**이다.
//!
//! 검증: 아래 테스트가 RFC 3174 벡터 + Node가 뱉은 실제 값을 확인한다.

pub struct Sha1 {
    h: [u32; 5],
    buf: [u8; 64],
    buf_len: usize,
    total: u64,
}

impl Default for Sha1 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha1 {
    pub fn new() -> Self {
        Sha1 {
            h: [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0],
            buf: [0; 64],
            buf_len: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
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
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    pub fn finish(mut self) -> [u8; 20] {
        let bits = self.total.wrapping_mul(8);
        self.update_raw(&[0x80]);
        while self.buf_len != 56 {
            self.update_raw(&[0]);
        }
        let b = bits.to_be_bytes();
        self.update_raw(&b);
        let mut out = [0u8; 20];
        for (i, w) in self.h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
        }
        out
    }

    /// 길이 카운터를 건드리지 않는 update(패딩 전용)
    fn update_raw(&mut self, data: &[u8]) {
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
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (self.h[0], self.h[1], self.h[2], self.h[3], self.h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
    }
}

pub fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// 한 방에 — `sha1_hex(b"abc") == "a9993e36…"`
pub fn sha1_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha1::new();
    for p in parts {
        h.update(p);
    }
    hex(&h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3174_vectors() {
        assert_eq!(sha1_hex(&[b"abc"]), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            sha1_hex(&[b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"]),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        assert_eq!(sha1_hex(&[b""]), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }

    /// **교차 확인** — 아래 두 값은 `node scripts/poc-lsp-sha1.mjs`가 뱉은 실제 출력이다.
    /// 이게 어긋나면 3.0이 2.6.2의 토큰 캐시를 못 읽는다(= 업그레이드 첫 실행에 캐시 전멸).
    #[test]
    fn matches_node_crypto_exactly() {
        // crypto.createHash('sha1').update('v1\0ts\0c:\x.ts\0').update('hello').digest('hex')
        assert_eq!(
            sha1_hex(&[b"v1\0ts\0c:\\x.ts\0", b"hello"]),
            "49cbf021d9746c999f45a2ae80d58b41dfb82845"
        );
        // 버킷 이름의 앞 16자: sha1('c:\code\agentcodegui')
        assert_eq!(&sha1_hex(&[b"c:\\code\\agentcodegui"])[..16], "4321f5548e6c5bd1");
        // 여러 번 update == 이어붙여 한 번
        assert_eq!(sha1_hex(&[b"ab", b"c"]), sha1_hex(&[b"abc"]));
    }

    #[test]
    fn long_input_crosses_blocks() {
        let big = vec![b'a'; 1_000_000];
        assert_eq!(sha1_hex(&[&big]), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    }
}
