//! JS 의미론 미러 — 강제변환(`!!`·`Number()`·`String()`·`parseFloat`)과 `Date.parse`.
//!
//! 왜 크레이트에 이런 게 있나: 2.6.2의 usage 파서(`src/main/auth.ts` `fetchAccountUsage`,
//! `src/main/index.ts` `fetchUsage`)는 **JS의 느슨한 변환에 그대로 기대고** 있다.
//! `!!spend.enabled`·`Math.round(percent ?? 0)`·`parseFloat(String(utilization ?? 0))`·
//! `Date.parse(resets_at)` — 이걸 Rust의 `as_bool()`/`as_f64()`로 옮기면 **같은 응답에서
//! 다른 게이지가 뜬다**(M5 R1 크리틱 §4-3에서 71케이스 중 12건이 갈렸다). 게이지 숫자라
//! 계정이 죽지는 않지만, "한도가 텅 빈 줄 안다"·"리셋 시각이 9시간 어긋난다"는 사용자가
//! 보는 거짓말이다. 그래서 **변환기를 따로 두고 그 규칙만 미러**한다.
//!
//! 대역(정직하게): ECMA-262의 ToBoolean/ToNumber/ToString/`parseFloat`과
//! Date Time String Format을 그대로 옮겼고, `Date.parse`의 **V8 레거시 갈래**는 실측 코퍼스가
//! 밟는 만큼만 옮겼다(구분자 `t`/공백, `±HHmm` 오프셋, 폭이 자유로운 `Y-M-D`, 5~6자리 맨
//! 연도). 레거시 갈래는 존 표기가 없으면 **로컬시**다 — V8이 그렇다.

use serde_json::{Number, Value};

// ── 강제변환 ────────────────────────────────────────────────────────────────

/// JS `!!v`. `undefined`(=키 없음)·`null`·`false`·`0`·`NaN`·`""`만 거짓이고
/// **빈 객체·빈 배열·`"0"`·`"false"`는 참**이다.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS 공백(StrWhiteSpace) — 트림 대상.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// JS `String(v)`. 배열은 원소를 `,`로 잇고(`null`/`undefined`는 빈 칸), 객체는
/// `[object Object]`다 — `parseFloat(String(x))`가 이 문자열을 먹는다.
pub fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                x => to_js_string(x),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// serde의 숫자 표기는 JS와 거의 같다(정수는 정수로). 지수 표기 경계(`1e21` 이상)만
/// JS가 `1e+21`을 쓰는데, usage 응답에 그런 값이 올 자리가 없어 그대로 둔다.
fn number_to_string(n: &Number) -> String {
    n.to_string()
}

/// JS `parseFloat` — **앞에서부터 읽히는 만큼만**. 실패는 NaN.
/// (`"83%"`→83 · `"1e2"`→100 · `"Infinity"`→∞ · `"1e"`→1 · `"abc"`→NaN)
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_space);
    let (v, used) = scan_number(t);
    if used == 0 {
        f64::NAN
    } else {
        v
    }
}

/// JS `Number(v)`(ToNumber). `parseFloat`과 다르다 — **문자열 전체**가 숫자여야 하고
/// (`"42abc"`→NaN), 빈 문자열은 0, 불리언은 1/0, 16/8/2진 접두사를 읽는다.
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(a) => {
            if a.len() > 1 {
                f64::NAN // String([1,2]) = "1,2" → NaN
            } else {
                string_to_number(&to_js_string(v))
            }
        }
        Value::Object(_) => f64::NAN,
    }
}

fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| t.strip_prefix(p).map(|d| (d, r));
    if let Some((digits, r)) = radix("0x", 16)
        .or_else(|| radix("0X", 16))
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0O", 8))
        .or_else(|| radix("0b", 2))
        .or_else(|| radix("0B", 2))
    {
        return u128::from_str_radix(digits, r).map(|n| n as f64).unwrap_or(f64::NAN);
    }
    let (v, used) = scan_number(t);
    if used == t.len() {
        v
    } else {
        f64::NAN
    }
}

/// 십진 리터럴을 앞에서부터 훑어 `(값, 먹은 바이트 수)`. `parseFloat`과 ToNumber가 공유한다.
/// Rust의 `f64::from_str`은 `"inf"`·`"nan"`도 받으므로 **여기서 통과시킨 조각만** 넘긴다.
fn scan_number(t: &str) -> (f64, usize) {
    let b = t.as_bytes();
    let mut i = 0;
    let neg = matches!(b.first(), Some(b'-'));
    if matches!(b.first(), Some(b'+') | Some(b'-')) {
        i = 1;
    }
    if t[i..].starts_with("Infinity") {
        let end = i + "Infinity".len();
        return (if neg { f64::NEG_INFINITY } else { f64::INFINITY }, end);
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut has_digit = i > int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        has_digit |= i > frac_start;
    }
    if !has_digit {
        return (f64::NAN, 0);
    }
    // 지수부는 **뒤에 숫자가 실제로 있을 때만** 먹는다(JS: `parseFloat('1e')` === 1)
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let exp_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    (t[..i].parse::<f64>().unwrap_or(f64::NAN), i)
}

/// JS `Math.round` — **half up(+∞ 쪽)** 이다. Rust의 `f64::round`는 half away-from-zero라
/// 음수 반값에서 갈린다(`Math.round(-2.5)` = -2, `(-2.5f64).round()` = -3).
pub fn round(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return x;
    }
    // 스펙의 특례: [+0, 0.5) → +0, [-0.5, -0) → -0 (`floor(x+0.5)`의 배정밀도 함정 방어)
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    (x + 0.5).floor()
}

/// `Math.max(0, Math.min(100, Math.round(n)))` — 게이지 퍼센트의 공통 마무리.
/// NaN은 호출부가 미리 걸러야 한다(JS는 NaN이 그대로 나가 JSON에서 null이 된다).
pub fn clamp_pct(n: f64) -> i64 {
    round(n).clamp(0.0, 100.0) as i64
}

// ── Date.parse ──────────────────────────────────────────────────────────────

/// JS `Date.parse` — epoch ms. 파싱 불가는 `None`(JS의 NaN).
///
/// 존 표기가 없는 **날짜-시각**은 ECMA-262대로 **로컬시**로 읽는다(날짜만이면 UTC).
/// 이 갈림이 실제로 사용자에게 보이는 차이다 — KST에서 9시간 어긋난 리셋 시각.
pub fn date_parse(s: &str) -> Option<f64> {
    date_parse_with(s, local_offset_minutes)
}

/// 로컬 오프셋 공급자를 주입하는 갈래 — 골든 테스트가 머신 타임존에 좌우되지 않게 한다.
pub fn date_parse_with(s: &str, local_offset: impl Fn(i64, i64, i64, i64, i64, i64) -> i64) -> Option<f64> {
    let p = parse_date_string(s)?;
    let base = days_from_civil(p.year, p.month, p.day) * 86_400_000
        + p.hour * 3_600_000
        + p.minute * 60_000
        + p.second * 1_000
        + p.ms;
    let off_min = match p.offset_minutes {
        Some(o) => o,
        None if p.utc_default => 0,
        None => {
            // 로컬 벽시계 → 정규화(2026-02-30·24시 같은 넘침을 먼저 편다) → 그 시각의 오프셋
            let (y, mo, d) = civil_from_days(base.div_euclid(86_400_000));
            let rem = base.rem_euclid(86_400_000);
            local_offset(y, mo, d, rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60)
        }
    };
    Some((base - off_min * 60_000) as f64)
}

#[derive(Debug, Clone, Copy)]
struct Parsed {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
    /// `Some(분)` = 명시 오프셋, `None` = 표기 없음.
    offset_minutes: Option<i64>,
    /// 표기가 없을 때 UTC로 볼지(엄격 ISO의 **날짜만** 형식) 로컬로 볼지.
    utc_default: bool,
}

fn parse_date_string(s: &str) -> Option<Parsed> {
    strict_iso(s).or_else(|| legacy(s))
}

/// ECMA-262 Date Time String Format. 공백 트림도 하지 않는다 — JS도 `" 2026-…"`은 NaN이다.
fn strict_iso(s: &str) -> Option<Parsed> {
    let b = s.as_bytes();
    let digits = |i: usize, n: usize| -> Option<i64> {
        let e = i + n;
        if e > b.len() || !b[i..e].iter().all(u8::is_ascii_digit) {
            return None;
        }
        s[i..e].parse().ok()
    };
    let mut i;
    let year = match b.first() {
        Some(b'+') | Some(b'-') => {
            let y = digits(1, 6)?;
            i = 7;
            if b[0] == b'-' {
                if y == 0 {
                    return None; // -000000은 무효
                }
                -y
            } else {
                y
            }
        }
        _ => {
            let y = digits(0, 4)?;
            i = 4;
            y
        }
    };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') {
        month = digits(i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'-') {
            day = digits(i + 1, 2)?;
            i += 3;
        }
    }
    let date_only = i == b.len();
    let mut p = Parsed { year, month, day, hour: 0, minute: 0, second: 0, ms: 0, offset_minutes: None, utc_default: true };
    if !date_only {
        if b.get(i) != Some(&b'T') {
            return None;
        }
        i += 1;
        p.utc_default = false; // 시각이 붙으면 존 없을 때 로컬시
        i = parse_time_and_zone(s, i, &mut p, false)?;
        if i != b.len() {
            return None;
        }
    }
    valid(&p).then_some(p)
}

/// V8 레거시 갈래 — 실측 코퍼스가 밟는 만큼만. **존 표기가 없으면 로컬시**다.
fn legacy(s: &str) -> Option<Parsed> {
    let b = s.as_bytes();
    // 5~6자리 맨 숫자는 연도다(`Date.parse('12345')` = 12345년 1월 1일 로컬)
    if (5..=6).contains(&b.len()) && b.iter().all(u8::is_ascii_digit) {
        let p = Parsed {
            year: s.parse().ok()?,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
            ms: 0,
            offset_minutes: None,
            utc_default: false,
        };
        return valid(&p).then_some(p);
    }
    // Y-M-D — 월/일의 자릿수가 자유롭고, 구분자가 `T`/`t`/공백이어도 된다
    let flex = |i: &mut usize| -> Option<i64> {
        let st = *i;
        while *i < b.len() && b[*i].is_ascii_digit() && *i - st < 2 {
            *i += 1;
        }
        (*i > st).then(|| s[st..*i].parse().ok())?
    };
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() && i < 4 {
        i += 1;
    }
    if i != 4 || b.get(i) != Some(&b'-') {
        return None;
    }
    let year: i64 = s[..4].parse().ok()?;
    i += 1;
    let month = flex(&mut i)?;
    if b.get(i) != Some(&b'-') {
        return None;
    }
    i += 1;
    let day = flex(&mut i)?;
    let mut p = Parsed { year, month, day, hour: 0, minute: 0, second: 0, ms: 0, offset_minutes: None, utc_default: false };
    if i < b.len() {
        if !matches!(b[i], b'T' | b't' | b' ') {
            return None;
        }
        i += 1;
        i = parse_time_and_zone(s, i, &mut p, true)?;
        if i != b.len() {
            return None;
        }
    }
    valid(&p).then_some(p)
}

/// `HH:mm[:ss[.frac]]` + 선택 존. `lenient`면 시/분/초 자릿수가 자유롭다(레거시).
fn parse_time_and_zone(s: &str, mut i: usize, p: &mut Parsed, lenient: bool) -> Option<usize> {
    let b = s.as_bytes();
    let field = |i: &mut usize| -> Option<i64> {
        let st = *i;
        while *i < b.len() && b[*i].is_ascii_digit() && *i - st < 2 {
            *i += 1;
        }
        let n = *i - st;
        if n == 2 || (lenient && n == 1) {
            s[st..*i].parse().ok()
        } else {
            None
        }
    };
    p.hour = field(&mut i)?;
    if b.get(i) != Some(&b':') {
        return None;
    }
    i += 1;
    p.minute = field(&mut i)?;
    if b.get(i) == Some(&b':') {
        i += 1;
        p.second = field(&mut i)?;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let st = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == st {
                return None;
            }
            // 밀리초 세 자리까지(더 있으면 버린다 — Date.parse와 같다)
            let three: String = s[st..i].chars().chain("000".chars()).take(3).collect();
            p.ms = three.parse().ok()?;
        }
    }
    match b.get(i) {
        None => {}
        Some(b'Z') | Some(b'z') => {
            p.offset_minutes = Some(0);
            i += 1;
        }
        Some(&c @ (b'+' | b'-')) => {
            let sign = if c == b'-' { -1 } else { 1 };
            let two = |at: usize| -> Option<i64> {
                let e = at + 2;
                (e <= b.len() && b[at..e].iter().all(u8::is_ascii_digit)).then(|| s[at..e].parse().ok())?
            };
            let oh = two(i + 1)?;
            // `±HH:mm`(스펙) 또는 `±HHmm`(레거시)뿐 — `+09`처럼 분이 빠지면 **무효**다
            let om = if b.get(i + 3) == Some(&b':') {
                let v = two(i + 4)?;
                i += 6;
                v
            } else {
                let v = two(i + 3)?;
                i += 5;
                v
            };
            if oh > 23 || om > 59 {
                return None;
            }
            p.offset_minutes = Some(sign * (oh * 60 + om));
        }
        _ => return None,
    }
    Some(i)
}

/// 넘치는 날짜(`2026-02-30`)·24시는 JS가 **굴려서** 받는다. 달·분·초 범위만 막는다.
fn valid(p: &Parsed) -> bool {
    (1..=12).contains(&p.month)
        && (1..=31).contains(&p.day)
        && (0..=24).contains(&p.hour)
        && (0..=59).contains(&p.minute)
        && (0..=59).contains(&p.second)
        && p.year.abs() <= 275_760
}

// ── 로컬 오프셋 ─────────────────────────────────────────────────────────────

/// 그 **로컬 벽시계** 시각에 적용되는 UTC 오프셋(분, 동쪽이 양수). Windows는 DST 규칙까지
/// 반영해 물어보고(`TzSpecificLocalTimeToSystemTime`), 실패하면 현재 바이어스로 물러난다.
pub fn local_offset_minutes(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    #[cfg(test)]
    if let Some(fixed) = test_tz::get() {
        return fixed;
    }
    platform_local_offset(y, mo, d, h, mi, s)
}

#[cfg(windows)]
fn platform_local_offset(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
    if (1601..=30827).contains(&y) {
        let local = SYSTEMTIME {
            wYear: y as u16,
            wMonth: mo as u16,
            wDayOfWeek: 0,
            wDay: d as u16,
            wHour: h as u16,
            wMinute: mi as u16,
            wSecond: s as u16,
            wMilliseconds: 0,
        };
        let mut utc = SYSTEMTIME::default();
        if unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.is_ok() {
            let a = days_from_civil(y, mo, d) * 1440 + h * 60 + mi;
            let b = days_from_civil(utc.wYear as i64, utc.wMonth as i64, utc.wDay as i64) * 1440
                + utc.wHour as i64 * 60
                + utc.wMinute as i64;
            return a - b;
        }
    }
    current_bias_minutes()
}

#[cfg(windows)]
fn current_bias_minutes() -> i64 {
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    let mut tzi = TIME_ZONE_INFORMATION::default();
    let extra = match unsafe { GetTimeZoneInformation(&mut tzi) } {
        1 => tzi.StandardBias,
        2 => tzi.DaylightBias,
        _ => 0,
    };
    -((tzi.Bias + extra) as i64)
}

#[cfg(not(windows))]
fn platform_local_offset(_y: i64, _mo: i64, _d: i64, _h: i64, _mi: i64, _s: i64) -> i64 {
    0
}

#[cfg(test)]
mod test_tz {
    use std::cell::Cell;
    thread_local! { static FIXED: Cell<Option<i64>> = const { Cell::new(None) } }
    pub fn get() -> Option<i64> {
        FIXED.with(Cell::get)
    }
    /// 그 스레드에서만 로컬 오프셋을 고정한다 — 골든이 머신 타임존을 타지 않게.
    pub fn with<R>(minutes: i64, f: impl FnOnce() -> R) -> R {
        let prev = FIXED.with(|c| c.replace(Some(minutes)));
        let out = f();
        FIXED.with(|c| c.set(prev));
        out
    }
}
#[cfg(test)]
pub use test_tz::with as with_fixed_local_offset;

// ── 민간력 ↔ 일수 (Howard Hinnant) ──────────────────────────────────────────

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_is_js_not_as_bool() {
        // `as_bool()`이 못 보는 갈래 — 크리틱 §4-3의 `spend.enabled: 1` / `"yes"`
        assert!(truthy(Some(&json!(1))));
        assert!(truthy(Some(&json!("yes"))));
        assert!(truthy(Some(&json!("0"))), "문자열 \"0\"은 JS에서 참이다");
        assert!(truthy(Some(&json!({}))) && truthy(Some(&json!([]))));
        assert!(!truthy(Some(&json!(0))) && !truthy(Some(&json!(""))) && !truthy(Some(&json!(false))));
        assert!(!truthy(Some(&Value::Null)) && !truthy(None));
    }

    #[test]
    fn parse_float_reads_exponents_and_infinity() {
        assert_eq!(parse_float("1e2"), 100.0);
        assert_eq!(parse_float("1e-7"), 1e-7);
        assert_eq!(parse_float("Infinity"), f64::INFINITY);
        assert_eq!(parse_float("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(parse_float("1e"), 1.0, "지수부에 숫자가 없으면 지수를 안 먹는다");
        assert_eq!(parse_float("83%"), 83.0);
        assert_eq!(parse_float("  42  "), 42.0);
        assert_eq!(parse_float(".5"), 0.5);
        assert_eq!(parse_float("5."), 5.0);
        assert_eq!(parse_float("0x10"), 0.0, "parseFloat은 16진을 모른다 — \"0\"까지만 읽는다");
        assert!(parse_float("NaN").is_nan() && parse_float("abc").is_nan() && parse_float("").is_nan());
        assert!(parse_float("inf").is_nan(), "Rust의 f64::from_str이 받는 표기가 새면 안 된다");
    }

    #[test]
    fn to_number_is_whole_string_coercion() {
        assert_eq!(to_number(&json!("77")), 77.0);
        assert_eq!(to_number(&json!(true)), 1.0);
        assert_eq!(to_number(&json!(false)), 0.0);
        assert_eq!(to_number(&json!("")), 0.0);
        assert_eq!(to_number(&json!("0x10")), 16.0);
        assert_eq!(to_number(&Value::Null), 0.0);
        assert!(to_number(&json!("42abc")).is_nan(), "ToNumber는 부분 파싱을 안 한다");
        assert!(to_number(&json!({})).is_nan());
    }

    #[test]
    fn round_is_half_up_toward_plus_infinity() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0, "Rust의 f64::round는 -3을 준다 — JS와 다르다");
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(clamp_pct(150.0), 100);
        assert_eq!(clamp_pct(-5.0), 0);
        assert_eq!(clamp_pct(f64::INFINITY), 100);
    }

    fn kst<R>(f: impl FnOnce() -> R) -> R {
        with_fixed_local_offset(540, f)
    }

    #[test]
    fn date_parse_matches_v8_on_the_shapes_the_corpus_uses() {
        kst(|| {
            assert_eq!(date_parse("2026-08-20T15:00:00Z"), Some(1_787_238_000_000.0));
            assert_eq!(date_parse("2026-08-20T15:00Z"), Some(1_787_238_000_000.0), "초는 선택이다");
            assert_eq!(date_parse("2026-08-20"), Some(1_787_184_000_000.0), "날짜만은 UTC");
            assert_eq!(date_parse("2026-08-20T15:00:00"), Some(1_787_205_600_000.0), "존이 없는 시각은 로컬시(KST)");
            assert_eq!(date_parse("2026-08-20T15:00:00-0500"), Some(1_787_256_000_000.0));
            assert_eq!(date_parse("2026-08-20 15:00:00Z"), Some(1_787_238_000_000.0));
            assert_eq!(date_parse("2026-08-20t15:00:00Z"), Some(1_787_238_000_000.0));
            assert_eq!(date_parse("2026-08-20T15:00:00.123456789Z"), Some(1_787_238_000_123.0));
            assert_eq!(date_parse("12345"), Some(327_403_350_000_000.0), "5자리 맨 숫자는 연도(로컬)");
            assert_eq!(date_parse("2026-08"), Some(1_785_542_400_000.0));
            assert_eq!(date_parse("2026"), Some(1_767_225_600_000.0));
            assert_eq!(date_parse("2026-02-30T00:00:00Z"), Some(1_772_409_600_000.0), "넘치는 날짜는 굴린다");
            assert_eq!(date_parse("2026-08-20T24:00:00Z"), Some(1_787_270_400_000.0));
            // NaN 갈래
            assert_eq!(date_parse("2026-08-20T15:00:00+09"), None, "분이 빠진 오프셋은 무효");
            assert_eq!(date_parse("not-a-date"), None);
            assert_eq!(date_parse(""), None);
            assert_eq!(date_parse("2026-13-01"), None);
            assert_eq!(date_parse("2026-08-20T15:00:00Zfoo"), None);
            assert_eq!(date_parse(" 2026-08-20T15:00:00Z"), None, "JS도 앞 공백은 NaN이다");
            assert_eq!(date_parse("1234567"), None);
        });
    }

    #[test]
    fn zoneless_times_follow_the_injected_zone() {
        let z = |off| with_fixed_local_offset(off, || date_parse("2026-08-20T15:00:00").unwrap());
        assert_eq!(z(0), 1_787_238_000_000.0);
        assert_eq!(z(540), 1_787_205_600_000.0);
        assert_eq!(z(-300), 1_787_256_000_000.0);
    }

    /// 실환경 경로(주입 없음)가 **실제 OS 타임존**을 쓰는가.
    /// DST 규칙이 있는 존에서는 "지금"과 "2026-08-20"의 오프셋이 다를 수 있어 범위만 본다.
    #[cfg(windows)]
    #[test]
    fn production_path_uses_the_real_os_offset() {
        use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
        let utc = date_parse("2026-08-20T15:00:00Z").unwrap();
        let local = date_parse("2026-08-20T15:00:00").unwrap();
        let got = ((utc - local) / 60_000.0) as i64;
        assert!((-14 * 60..=14 * 60).contains(&got), "오프셋이 실존 범위를 벗어났다: {got}");
        let mut tzi = TIME_ZONE_INFORMATION::default();
        unsafe { GetTimeZoneInformation(&mut tzi) };
        if tzi.StandardDate.wMonth == 0 && tzi.DaylightDate.wMonth == 0 {
            // DST 없는 존(예: KST) — 그러면 현재 바이어스와 정확히 같아야 한다
            assert_eq!(got, current_bias_minutes(), "존 없는 시각이 OS 오프셋만큼 밀려야 한다");
        }
    }

    #[test]
    fn civil_roundtrip() {
        for z in [-719_468, -1, 0, 1, 20_000, 3_790_314] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z, "{z} → {y}-{m}-{d}");
        }
    }
}
