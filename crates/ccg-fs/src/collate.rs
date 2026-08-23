//! 이름 정렬 — 2.6.2가 쓰던 `localeCompare(undefined, { sensitivity: 'base' })`의 근사.
//!
//! ── 왜 그냥 `to_lowercase().cmp()`가 아닌가 ─────────────────────────────────
//! 실측(Node 24, 이 머신 로케일 ko-KR)으로 두 순서를 대조했더니 **한글 이름이 통째로
//! 자리를 옮긴다**:
//!
//! ```text
//! localeCompare : _priv  .env  1a  가나  나가  문서  Ábc  abc  app  Bench  zz
//! 소문자 코드포인트: .env  1a  _priv  a…  app  bench  zz  Ábc  가나  나가  문서
//! ```
//!
//! 즉 2.6.2 탐색기에서 **맨 위에 오던 한글 폴더가 맨 아래로 내려간다.** 한국어가 1차
//! 언어인 앱에서 트리 순서가 뒤집히는 건 "같은 화면"이 아니다. 원인은 세 가지고,
//! 여기서는 그 셋만 맞춘다:
//!
//! 1. **문장부호가 숫자·글자보다 앞선다** — DUCET의 variable weight. 순서까지 있다
//!    (`_` < `-` < `.` < `(` < `#` < `+` < `=` < `~`, 실측으로 확인).
//! 2. **한국어 로케일에서는 한글·한자가 라틴보다 앞선다** — CLDR `ko`의 `[reorder Hang Hani]`.
//!    로케일이 ko가 아니면 루트 순서(라틴 → 한자 → 한글)로 돌아간다.
//! 3. **base sensitivity = 대소문자·발음구별부호 무시** — `Ábc`가 `abc`와 같은 자리.
//!
//! 여기에 R2가 둘을 더 맞췄다(크리틱 R1 §4가 짚은 잔여 클래스):
//!
//! 4. **전각 라틴은 ASCII로 접힌다** — ICU는 폭을 3차 가중치로만 본다. 안 접으면
//!    `ＦＵＬＬ幅.txt`가 가나보다도 뒤, 목록 끝으로 밀린다.
//! 5. **가타카나는 히라가나로 접힌다** — ICU는 가나 종류도 3차다. 안 접으면
//!    `カタカナ`가 `ひらがな` 뒤로 가는데 ICU는 음절(か < ひ)로 읽어 앞에 둔다.
//!
//! ── 안 맞추는 것(문서화된 근사) ─────────────────────────────────────────────
//! - Latin Extended-A 이후의 발음구별부호(ā, ł, ő…)는 접지 않는다 — 실사용 파일명에
//!   사실상 안 나오고, 표를 잘못 정렬하면 조용히 순서가 망가진다.
//! - 그리스·키릴의 스크립트 간 세부 순서는 코드포인트 순이다.
//! - 반각 가타카나(U+FF61..U+FF9F)는 접지 않는다 — 한 글자가 두 글자(가나+탁점)로
//!   퍼지는 확장이라 `æ→ae`와 같은 부류고, 파일명에서 사실상 안 쓰인다.
//! - 대소문자만 다른 두 이름의 tie-break: 2.6.2는 입력 순서(안정 정렬)를 남기고 여기는
//!   원문 비교로 확정한다. 한 폴더 안에 대소문자만 다른 두 항목은 NTFS에서 공존할 수
//!   없으므로 탐색기에서는 도달 불가능한 차이다.

use std::cmp::Ordering;

/// DUCET/CLDR 루트의 문장부호 순서(ASCII 전량 + 공백). 인덱스가 곧 가중치다.
/// 실측 대조: `_a` `-a` `.a` `(a` `#a` `+a` `=a` `~a` `a` 순서가 이 표와 일치한다.
const PUNCT: &[char] = &[
    ' ', '_', '-', ',', ';', ':', '!', '?', '.', '\'', '"', '(', ')', '[', ']', '{', '}', '@', '*',
    '/', '\\', '&', '#', '%', '`', '^', '+', '<', '=', '>', '|', '~', '$',
];

/// Latin-1 Supplement(U+00C0..U+00FF)의 기저 문자 — 인덱스 = `c - 0xC0`. 64칸 고정.
/// base sensitivity가 보는 값이고, 기대값은 전부 실측이다:
/// `['ad','ae','æ','az','d','ð','da','ø','oa','oe','oz','sa','ss','ß','sz','ta','th','tt','tz','þ']`
/// → `ad ae æ az | d ð da | ø oa oe oz | sa ss ß sz | ta th tt tz þ`
/// 여기서 읽히는 규칙: `ð→d`, `ø→o`는 정확히 접히고, `þ`는 **안 접힌다**(t 단어들 뒤).
/// `æ→ae`·`ß→ss`는 2글자 확장이라 한 글자 근사(`a`·`s`)로 둔다 — 이웃까지는 맞고
/// 같은 접두 단어와의 앞뒤만 어긋난다(‘z 뒤로 밀리는’ 것보다 한참 가깝다).
/// ×·÷는 기호라 접지 않는다.
const LATIN1_FOLD: &str =
    "AAAAAAACEEEEIIIIDNOOOOO×OUUUUYÞsaaaaaaaceeeeiiiidnooooo÷ouuuuyþy";

/// 한국어 로케일인가 — CLDR `ko`는 한글·한자를 라틴 앞으로 재배치한다(`[reorder Hang Hani]`).
/// 2.6.2의 `localeCompare(undefined, …)`도 **OS 로케일**을 봤으므로 같은 원천을 읽는다
/// (앱의 UI 언어 설정이 아니다 — 한국어 Windows에서 UI만 영어로 둬도 2.6.2는 한글 우선이었다).
fn korean_locale() -> bool {
    use std::sync::OnceLock;
    static KO: OnceLock<bool> = OnceLock::new();
    *KO.get_or_init(detect_korean)
}

#[cfg(windows)]
fn detect_korean() -> bool {
    // 테스트·재현용 탈출구. 값이 있으면 그걸 로케일로 본다.
    if let Ok(v) = std::env::var("CCG_LOCALE") {
        return v.to_ascii_lowercase().starts_with("ko");
    }
    unsafe extern "system" {
        fn GetUserDefaultLocaleName(lpLocaleName: *mut u16, cchLocaleName: i32) -> i32;
    }
    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return false;
    }
    let name = String::from_utf16_lossy(&buf[..(n as usize).saturating_sub(1)]);
    name.to_ascii_lowercase().starts_with("ko")
}

#[cfg(not(windows))]
fn detect_korean() -> bool {
    std::env::var("CCG_LOCALE")
        .or_else(|_| std::env::var("LANG"))
        .map(|v| v.to_ascii_lowercase().starts_with("ko"))
        .unwrap_or(false)
}

fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7FF)
}
fn is_han(c: char) -> bool {
    matches!(c as u32, 0x2E80..=0x2FDF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// 폭·가나 종류를 1차 가중치에서 지운다 — ICU가 그것들을 **3차 가중치**로만 보기 때문.
///
/// ── 전각 라틴(U+FF01..U+FF5E) ────────────────────────────────────────────────
/// ICU는 `ＦＵＬＬ`을 `full`로 접어 f 자리에 둔다. 접지 않으면 코드포인트 그대로
/// 라틴 계층 **맨 뒤**(가나보다도 뒤)로 밀려 `ＦＵＬＬ幅.txt`가 목록 끝으로 다섯 칸
/// 이동한다(크리틱 R1 §4 실측). `！`·`１` 같은 전각 부호·숫자도 같은 규칙으로 접힌다.
/// U+3000(전각 공백)은 이 블록 밖이라 따로 잡는다.
///
/// ── 가나 상호(U+30A1..U+30F6 → 히라가나) ────────────────────────────────────
/// ICU는 두 가나를 **같은 음절**로 보고 종류는 3차로만 가른다. 코드포인트 그대로 두면
/// `カタカナ`(カ=U+30AB)가 `ひらがな`(ひ=U+3072)보다 뒤로 가는데, ICU는 음절 か < ひ로
/// 읽어 반대로 준다(§4 실측). 접고 나면 1차가 같아진 두 가나는 `name_cmp`의 원문
/// tie-break가 가르고, 그 순서(히라가나 먼저)가 ICU의 3차 순서와 같다.
fn fold_width_and_kana(ch: char) -> char {
    let u = ch as u32;
    let mapped = match u {
        0xFF01..=0xFF5E => u - 0xFEE0,      // 전각 ASCII → ASCII
        0x3000 => 0x0020,                   // 전각 공백 → 공백
        0x30A1..=0x30F6 => u - 0x60,        // 가타카나 → 히라가나
        0x30FD..=0x30FE => u - 0x60,        // 가타카나 반복 기호 → 히라가나 반복 기호
        _ => return ch,
    };
    char::from_u32(mapped).unwrap_or(ch)
}

/// 문자 하나의 1차 가중치 — 상위 8비트가 스크립트 계층, 하위가 그 안의 순서.
fn weight(c: char, ko: bool) -> u64 {
    // base sensitivity: 폭·가나 종류 접기 → 대소문자 접기 → Latin-1 발음구별부호 접기
    let mut ch = fold_width_and_kana(c);
    if let 0x00C0..=0x00FF = ch as u32 {
        if let Some(f) = LATIN1_FOLD.chars().nth(ch as usize - 0xC0) {
            ch = f;
        }
    }
    let ch = ch.to_lowercase().next().unwrap_or(ch);

    let class: u64 = if let Some(i) = PUNCT.iter().position(|p| *p == ch) {
        return i as u64; // class 0 — 표 순서가 곧 가중치(0..32)
    } else if ch.is_ascii_digit() {
        1
    } else if is_hangul(ch) {
        if ko { 2 } else { 6 }
    } else if is_han(ch) {
        if ko { 3 } else { 5 }
    } else if ch.is_alphanumeric() || ch.is_ascii() {
        4 // 라틴 + 그 밖의 글자
    } else {
        0 // 표에 없는 문장부호·기호 — 문장부호 계층 뒤쪽에 코드포인트 순으로
    };
    if class == 0 {
        return PUNCT.len() as u64 + ch as u64;
    }
    (class << 32) | ch as u64
}

/// 2.6.2 `a.localeCompare(b, undefined, { sensitivity: 'base' })`의 자리.
/// 1차 가중치가 완전히 같으면(대소문자만 다름 등) 원문으로 확정한다 — 같은 목록에서
/// 실행마다 순서가 흔들리지 않게.
pub fn name_cmp(a: &str, b: &str) -> Ordering {
    let ko = korean_locale();
    let mut ia = a.chars();
    let mut ib = b.chars();
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let o = weight(x, ko).cmp(&weight(y, ko));
                if o != Ordering::Equal {
                    return o;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(v: &[&str]) -> Vec<String> {
        let mut o: Vec<String> = v.iter().map(|s| s.to_string()).collect();
        o.sort_by(|a, b| name_cmp(a, b));
        o
    }

    /// 기대값은 전부 **Node 24(ko-KR)에서 실측한** localeCompare 결과다.
    /// (`node -e "[...].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base'}))"`)
    #[test]
    fn matches_localecompare_on_korean_locale() {
        assert!(korean_locale(), "이 테스트는 ko 로케일 전제 — CCG_LOCALE=ko로 강제할 수 있다");
        assert_eq!(
            sorted(&["app", "문서", "Bench", "가나", "나가", "_priv", ".env", "1a", "zz", "abc"]),
            ["_priv", ".env", "1a", "가나", "나가", "문서", "abc", "app", "Bench", "zz"]
        );
        assert_eq!(
            sorted(&["하늘", "가나", "나가", "다라", "힣", "ㄱ자", "각", "갃"]),
            ["ㄱ자", "가나", "각", "갃", "나가", "다라", "하늘", "힣"]
        );
        assert_eq!(
            sorted(&["_a", "-a", ".a", "~a", "#a", "(a", "+a", "=a", "a"]),
            ["_a", "-a", ".a", "(a", "#a", "+a", "=a", "~a", "a"]
        );
        assert_eq!(
            sorted(&[".github", "app", "bench", "crates", "docs", "progress", "scripts", "src",
                     "src-tauri", "node_modules", "__pycache__", "_build", "Cargo.toml", "README.md"]),
            ["__pycache__", "_build", ".github", "app", "bench", "Cargo.toml", "crates", "docs",
             "node_modules", "progress", "README.md", "scripts", "src", "src-tauri"]
        );
        // 숫자는 **문자열 비교**다 (2.6.2도 numeric 옵션을 안 켰다)
        assert_eq!(
            sorted(&["file2", "file10", "file1", "2x", "10x", "1x"]),
            ["10x", "1x", "2x", "file1", "file10", "file2"]
        );
    }

    #[test]
    fn base_sensitivity_folds_case_and_latin1_accents() {
        assert_eq!(name_cmp("APP", "app"), Ordering::Less, "1차가 같으면 원문으로 확정");
        assert_eq!(name_cmp("Ábc", "abc"), Ordering::Greater, "1차 동률 → 원문 tie-break");
        // 하지만 정렬 위치는 abc 옆이어야 한다(zz 뒤가 아니라)
        assert_eq!(sorted(&["zz", "Ábc", "abd", "abc"]), ["abc", "Ábc", "abd", "zz"]);
        assert_eq!(sorted(&["Über", "under", "zoo"]), ["Über", "under", "zoo"]);
        // 실측과 일치하는 자리들 (ð→d · ø→o · þ는 안 접힘)
        assert_eq!(sorted(&["d", "ð", "da"]), ["d", "ð", "da"]);
        assert_eq!(sorted(&["ø", "oa", "oe", "oz"]), ["ø", "oa", "oe", "oz"]);
        assert_eq!(sorted(&["ta", "th", "tt", "tz", "þ"]), ["ta", "th", "tt", "tz", "þ"]);
    }

    /// 표가 어긋나면 조용히 순서가 망가진다 — 길이와 대표 자리를 못으로 박는다.
    #[test]
    fn the_latin1_fold_table_stays_aligned() {
        let f: Vec<char> = LATIN1_FOLD.chars().collect();
        assert_eq!(f.len(), 64, "U+00C0..U+00FF 64칸");
        for (c, want) in [
            ('À', 'A'), ('Å', 'A'), ('Æ', 'A'), ('Ç', 'C'), ('Ë', 'E'), ('Ï', 'I'), ('Ð', 'D'),
            ('Ñ', 'N'), ('Ö', 'O'), ('×', '×'), ('Ø', 'O'), ('Ü', 'U'), ('Ý', 'Y'), ('Þ', 'Þ'),
            ('ß', 's'), ('à', 'a'), ('æ', 'a'), ('ç', 'c'), ('ï', 'i'), ('ð', 'd'), ('ñ', 'n'),
            ('ö', 'o'), ('÷', '÷'), ('ø', 'o'), ('ü', 'u'), ('ý', 'y'), ('þ', 'þ'), ('ÿ', 'y'),
        ] {
            assert_eq!(f[c as usize - 0xC0], want, "{c}");
        }
    }

    /// 전각 라틴 — ICU는 폭을 3차로만 본다. R1은 코드포인트 그대로 둬서 `ＦＵＬＬ幅.txt`가
    /// 가나보다도 뒤, 목록 끝으로 다섯 칸 밀렸다(크리틱 R1 §4).
    #[test]
    fn fullwidth_latin_folds_onto_its_ascii_seat() {
        assert_eq!(sorted(&["ＦＵＬＬ.txt", "full2.txt"]), ["ＦＵＬＬ.txt", "full2.txt"]);
        assert_eq!(sorted(&["ＡＢＣ.md", "abd.md"]), ["ＡＢＣ.md", "abd.md"]);
        assert_eq!(sorted(&["Ｚ.txt", "a.txt"]), ["a.txt", "Ｚ.txt"]);
        // 목록 안에서의 자리 — 라틴 사이지 끝이 아니다
        assert_eq!(
            sorted(&["zoo.txt", "ＦＵＬＬ幅.txt", "apple.txt", "가나.txt"]),
            ["가나.txt", "apple.txt", "ＦＵＬＬ幅.txt", "zoo.txt"]
        );
        // 전각 숫자·부호도 같은 규칙
        assert_eq!(sorted(&["１０x", "2x"]), ["１０x", "2x"]);
        assert_eq!(sorted(&["＿a", "a"]), ["＿a", "a"]);
    }

    /// 가나 상호 — ICU는 음절로 읽는다(か < ひ). 종류(히라/가타)는 3차라 동률일 때만 가른다.
    #[test]
    fn katakana_sorts_by_syllable_like_hiragana() {
        assert_eq!(sorted(&["ひらがな.txt", "カタカナ.txt"]), ["カタカナ.txt", "ひらがな.txt"]);
        assert_eq!(sorted(&["さくら.txt", "サクラ.txt"]), ["さくら.txt", "サクラ.txt"]);
        assert_eq!(name_cmp("あ", "ア"), Ordering::Less, "1차 동률 → 원문 tie-break(히라가나 먼저)");
    }

    /// 스크립트 계층 순서 — 실측(ko-KR): 부호 · 숫자 · 한글 · 한자 · 라틴 · 그 밖.
    #[test]
    fn script_tiers_follow_the_korean_locale_reorder() {
        assert_eq!(
            sorted(&["app", "漢字", "가나", "1x", "_x", "Ω", "Ж"]),
            ["_x", "1x", "가나", "漢字", "app", "Ω", "Ж"]
        );
        assert_eq!(sorted(&["文서", "가", "나", "字", "漢"])[..2], ["가", "나"], "한글이 한자보다 앞");
    }

    /// 정렬이 **전순서**여야 한다 — 아니면 sort_by가 목록을 뒤죽박죽으로 남긴다.
    #[test]
    fn the_comparator_is_a_total_order() {
        let names = [
            "a", "A", "ab", "_x", ".x", "1", "10", "가", "가나", "漢", "z", "Ábc", "~", " sp", "",
        ];
        for x in names {
            assert_eq!(name_cmp(x, x), Ordering::Equal, "{x}");
            for y in names {
                assert_eq!(name_cmp(x, y), name_cmp(y, x).reverse(), "{x} vs {y}");
                for z in names {
                    if name_cmp(x, y) != Ordering::Greater && name_cmp(y, z) != Ordering::Greater {
                        assert_ne!(name_cmp(x, z), Ordering::Greater, "이행성 깨짐 {x} {y} {z}");
                    }
                }
            }
        }
    }
}
