//! stdin JSON 배열 → collate::name_cmp로 정렬 → stdout JSON 배열.
use std::io::Read;

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let mut v: Vec<String> = serde_json::from_str(&s).unwrap();
    v.sort_by(|a, b| ccg_fs::collate::name_cmp(a, b));
    println!("{}", serde_json::to_string(&v).unwrap());
}
