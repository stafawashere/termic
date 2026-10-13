use serde::Serialize;
use similar::{DiffOp, TextDiff};

pub const MAX_BYTES: usize = 2_000_000;
pub const MAX_LINES: usize = 50_000;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct LineChanges {
    pub added: Vec<[u32; 2]>,
    pub modified: Vec<[u32; 2]>,
    pub deleted: Vec<u32>,
    pub truncated: bool,
}

fn push_range(ranges: &mut Vec<[u32; 2]>, start: u32, end: u32) {
    if let Some(last) = ranges.last_mut() {
        let touches_last = last[1] + 1 >= start;
        if touches_last {
            last[1] = last[1].max(end);
            return;
        }
    }
    ranges.push([start, end]);
}

/// 1-based buffer line ranges that differ from `old`. A deletion is reported as
/// the buffer line that now sits where the removed lines were, clamped to the
/// last line.
pub fn line_changes(old: &str, new: &str) -> LineChanges {
    let new_line_count = new.lines().count();
    let is_new_oversized = new.len() > MAX_BYTES || new_line_count > MAX_LINES;
    let is_old_oversized = old.len() > MAX_BYTES || old.lines().count() > MAX_LINES;
    let is_oversized = is_new_oversized || is_old_oversized;
    if is_oversized {
        return LineChanges { truncated: true, ..Default::default() };
    }

    let old = old.replace("\r\n", "\n");
    let new = new.replace("\r\n", "\n");
    let diff = TextDiff::from_lines(old.as_str(), new.as_str());
    let last_line = (new_line_count as u32).max(1);
    let mut changes = LineChanges::default();

    for op in diff.ops() {
        match *op {
            DiffOp::Equal { .. } => {}
            DiffOp::Insert { new_index, new_len, .. } => {
                let start = new_index as u32 + 1;
                push_range(&mut changes.added, start, start + new_len as u32 - 1);
            }
            DiffOp::Delete { new_index, .. } => {
                let line = (new_index as u32 + 1).min(last_line);
                if changes.deleted.last() != Some(&line) {
                    changes.deleted.push(line);
                }
            }
            DiffOp::Replace { old_len, new_index, new_len, .. } => {
                let start = new_index as u32 + 1;
                let paired = old_len.min(new_len) as u32;
                push_range(&mut changes.modified, start, start + paired - 1);

                let has_extra_new = new_len > old_len;
                if has_extra_new {
                    push_range(&mut changes.added, start + paired, start + new_len as u32 - 1);
                }

                let has_extra_old = old_len > new_len;
                if has_extra_old {
                    let line = (start + paired).min(last_line);
                    if changes.deleted.last() != Some(&line) {
                        changes.deleted.push(line);
                    }
                }
            }
        }
    }

    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_changes_pure_add() {
        let out = line_changes("a\nb\n", "a\nx\ny\nb\n");
        assert_eq!(out.added, vec![[2, 3]]);
        assert!(out.modified.is_empty());
        assert!(out.deleted.is_empty());
        assert!(!out.truncated);
    }

    #[test]
    fn line_changes_pure_delete() {
        let out = line_changes("a\nb\nc\n", "a\nc\n");
        assert!(out.added.is_empty());
        assert!(out.modified.is_empty());
        assert_eq!(out.deleted, vec![2]);
    }

    #[test]
    fn line_changes_delete_at_end_clamps_to_last_line() {
        let out = line_changes("a\nb\nc\n", "a\n");
        assert_eq!(out.deleted, vec![1]);
    }

    #[test]
    fn line_changes_modify_in_place() {
        let out = line_changes("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(out.modified, vec![[2, 2]]);
        assert!(out.added.is_empty());
        assert!(out.deleted.is_empty());
    }

    #[test]
    fn line_changes_mixed_hunks() {
        let old = "a\nb\nc\nd\ne\nf\ng\n";
        let new = "a\nB\nc\nd\nnew1\nnew2\ne\ng\n";
        let out = line_changes(old, new);
        assert_eq!(out.modified, vec![[2, 2]]);
        assert_eq!(out.added, vec![[5, 6]]);
        assert_eq!(out.deleted, vec![8]);
    }

    #[test]
    fn line_changes_replace_with_more_new_lines_splits_modified_and_added() {
        let out = line_changes("a\nb\nc\n", "a\nx\ny\nz\nc\n");
        assert_eq!(out.modified, vec![[2, 2]]);
        assert_eq!(out.added, vec![[3, 4]]);
    }

    #[test]
    fn line_changes_crlf_buffer_against_lf_blob_is_clean() {
        let out = line_changes("a\nb\n", "a\r\nb\r\n");
        assert_eq!(out, LineChanges::default());
    }

    #[test]
    fn line_changes_crlf_still_reports_real_edits() {
        let out = line_changes("a\r\nb\r\n", "a\r\nX\r\n");
        assert_eq!(out.modified, vec![[2, 2]]);
    }

    #[test]
    fn line_changes_empty_old_marks_every_line_added() {
        let out = line_changes("", "a\nb\nc\n");
        assert_eq!(out.added, vec![[1, 3]]);
    }

    #[test]
    fn line_changes_size_cap_by_bytes() {
        let big = "x".repeat(MAX_BYTES + 1);
        let out = line_changes("a\n", &big);
        assert!(out.truncated);
        assert!(out.added.is_empty() && out.modified.is_empty() && out.deleted.is_empty());
    }

    #[test]
    fn line_changes_size_cap_applies_to_the_head_blob_too() {
        let big_head = "x".repeat(MAX_BYTES + 1);
        let by_bytes = line_changes(&big_head, "a\n");
        assert!(by_bytes.truncated);
        assert!(by_bytes.added.is_empty() && by_bytes.deleted.is_empty());

        let many_head_lines = "\n".repeat(MAX_LINES + 1);
        let by_lines = line_changes(&many_head_lines, "a\n");
        assert!(by_lines.truncated);
        assert!(by_lines.modified.is_empty());
    }

    #[test]
    fn line_changes_size_cap_by_lines() {
        let many = "\n".repeat(MAX_LINES + 1);
        let out = line_changes("", &many);
        assert!(out.truncated);
        assert!(out.added.is_empty());
    }
}
