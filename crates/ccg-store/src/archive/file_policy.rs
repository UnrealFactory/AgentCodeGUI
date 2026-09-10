//! Automatic capture follows project ignore rules. Explicit tool/attachment
//! paths can bypass those rules, but never the archive or live app internals.
use super::files::{inside, key};
use ignore::{IncrementalIgnore, WalkBuilder};
use std::path::{Path, PathBuf};

pub struct Policy {
    archive: PathBuf,
    roots: Vec<PathBuf>,
    matchers: Vec<IncrementalIgnore>,
}

impl Policy {
    pub fn new(archive: PathBuf, roots: Vec<PathBuf>) -> Self {
        let matchers = roots
            .iter()
            .flat_map(|p| builder(p).build_matchers())
            .collect();
        Self {
            archive,
            roots,
            matchers,
        }
    }

    pub fn refresh(&mut self) {
        self.matchers = self
            .roots
            .iter()
            .flat_map(|p| builder(p).build_matchers())
            .collect();
    }

    pub fn automatic(&mut self, path: &Path, is_dir: bool) -> bool {
        if automatic_excluded(path, &self.archive, &self.roots, is_dir) {
            return false;
        }
        for (root, matcher) in self.roots.iter().zip(&mut self.matchers) {
            if inside(path, root) {
                let p = key(path);
                let r = key(root);
                let relative = p
                    .strip_prefix(r.trim_end_matches('/'))
                    .unwrap_or("")
                    .trim_start_matches('/');
                return !matcher.matched(relative, is_dir).is_ignore();
            }
        }
        false
    }

    pub fn explicit(&self, path: &Path) -> bool {
        !hard_excluded(path, &self.archive, &self.roots)
    }
}

pub fn builder(root: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.standard_filters(false)
        .git_ignore(true)
        .require_git(false)
        .follow_links(false)
        .ignore_case_insensitive(cfg!(windows));
    b
}

pub fn hard_excluded(path: &Path, archive: &Path, roots: &[PathBuf]) -> bool {
    if inside(path, archive) {
        return true;
    }
    // Compare components below an explicit workspace root. A workspace may itself
    // be named "target"; neither its name nor unrelated ancestor names exclude it.
    let p = key(path);
    let relative = roots
        .iter()
        .filter(|r| inside(path, r))
        .map(|r| key(r))
        .max_by_key(String::len)
        .map(|r| {
            p[r.trim_end_matches('/').len()..]
                .trim_start_matches('/')
                .to_owned()
        })
        .unwrap_or_else(|| p.clone());
    let parts: Vec<_> = relative.split('/').collect();
    for part in parts {
        let name = part.to_ascii_lowercase();
        // Runtime profiles remain excluded even when explicitly referenced.
        if matches!(
            name.as_str(),
            ".git" | ".hg" | ".svn" | "webview2" | "ebwebview"
        ) || name.starts_with(".poc-home")
            || name.starts_with(".bench-home")
            || name.starts_with(".crit-home")
            || name.starts_with(".ccg-home")
            || matches!(name.as_str(), ".dev-home" | ".devhome")
        {
            return true;
        }
    }
    false
}

pub fn automatic_excluded(path: &Path, archive: &Path, roots: &[PathBuf], is_dir: bool) -> bool {
    if hard_excluded(path, archive, roots) {
        return true;
    }
    let p = key(path);
    let relative = roots
        .iter()
        .filter(|r| inside(path, r))
        .map(|r| key(r))
        .max_by_key(String::len)
        .map(|r| {
            p[r.trim_end_matches('/').len()..]
                .trim_start_matches('/')
                .to_owned()
        })
        .unwrap_or_default();
    let parts: Vec<_> = relative.split('/').collect();
    parts.iter().enumerate().any(|(i, part)| {
        let name = part.to_ascii_lowercase();
        (is_dir || i + 1 < parts.len())
            && matches!(
                name.as_str(),
                "node_modules"
                    | "target"
                    | "dist"
                    | "out"
                    | ".cache"
                    | "__pycache__"
                    | ".venv"
                    | "venv"
                    | ".next"
                    | ".nuxt"
            )
    })
}
