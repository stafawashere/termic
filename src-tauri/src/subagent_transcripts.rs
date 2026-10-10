//! Claude subagent transcripts: find them, read them, summarise them.
//!
//! Claude Code writes every subagent's conversation to its own JSONL file
//! beside the parent session:
//!
//! ```text
//! <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)
//! <config>/projects/<slug>/<sessionId>/subagents/workflows/wf_<run>/agent-<id>.jsonl
//! ```
//!
//! Neither the layout nor the line format is documented upstream, so both are
//! parsed leniently: a line or key this module does not understand is counted
//! and skipped, never a failed read.
//!
//! Every path is derived here from host state (the task record, the agent
//! registry, the tab's session id). The webview hands over ids, never paths,
//! and each id is checked against a strict charset before it is joined. The
//! resolved file must then canonicalise to somewhere under the canonical
//! `subagents/` dir, which is what stops a symlink planted in that directory
//! from turning a read into a read of anything else on disk.
//!
//! Transcript text is untrusted. It goes out as plain strings with ANSI
//! escapes removed, and nothing here caches or persists it.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Entries returned per page of `subagent_transcript_read`.
pub(crate) const WINDOW: usize = 500;

/// Upper bound on any single text or tool body in a payload. A subagent that
/// cats a large file produces one tool result the size of that file, and one
/// such entry should not make the whole page heavy.
pub(crate) const BODY_BYTE_CAP: usize = 16 * 1024;

/// How much of a transcript's end `subagent_list` reads to decide its outcome.
const OUTCOME_TAIL_BYTES: u64 = 64 * 1024;

const DEFAULT_LIST_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolveError {
    InvalidId(String),
    NotFound,
    Escapes,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::InvalidId(what) => write!(f, "invalid {what}"),
            ResolveError::NotFound => write!(f, "subagent transcript not found"),
            ResolveError::Escapes => write!(f, "subagent transcript is outside its session directory"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Done,
    Failed,
    None,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    UserText,
    AssistantText,
    Thinking,
    RedactedThinking,
    ToolUse,
    ToolResult,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    pub kind: EntryKind,
    pub text: String,
    pub truncated: bool,
    /// Tool name, on `toolUse` entries only.
    pub name: Option<String>,
    pub is_error: bool,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tool_use_id: Option<String>,
    pub spawn_depth: Option<u64>,
    pub parent_agent_id: Option<String>,
    pub request_shape: Option<String>,
    pub request_non_interactive: Option<bool>,
    pub workflow_phase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSummary {
    pub agent_id: String,
    pub is_workflow: bool,
    pub workflow_run_id: Option<String>,
    #[serde(flatten)]
    pub meta: SubagentMeta,
    pub mtime_ms: u64,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub agent_id: String,
    pub entries: Vec<TranscriptEntry>,
    /// Entries in the whole transcript, and the index of `entries[0]` in it.
    /// Passing `start` back as `before` fetches the page above this one.
    pub total: usize,
    pub start: usize,
    pub skipped_lines: usize,
    pub outcome: Outcome,
    pub meta: SubagentMeta,
}

// ---------------------------------------------------------------------------
// paths

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn is_valid_id(raw: &str, allow_underscore: bool) -> bool {
    let has_valid_length = (1..=64).contains(&raw.len());
    let has_valid_chars = raw
        .chars()
        .all(|c| if allow_underscore { is_id_char(c) } else { c.is_ascii_alphanumeric() || c == '-' });
    has_valid_length && has_valid_chars
}

/// The bare agent id, with an optional `agent-` prefix removed. The hook
/// payloads and the file names disagree on whether the prefix is part of it.
pub(crate) fn validate_agent_id(raw: &str) -> Result<&str, ResolveError> {
    let bare = raw.strip_prefix("agent-").unwrap_or(raw);
    if !is_valid_id(bare, true) {
        return Err(ResolveError::InvalidId("agent id".into()));
    }
    Ok(bare)
}

pub(crate) fn validate_session_id(raw: &str) -> Result<&str, ResolveError> {
    if !is_valid_id(raw, false) {
        return Err(ResolveError::InvalidId("session id".into()));
    }
    Ok(raw)
}

pub(crate) fn validate_workflow_run_id(raw: &str) -> Result<&str, ResolveError> {
    let Some(rest) = raw.strip_prefix("wf_") else {
        return Err(ResolveError::InvalidId("workflow run id".into()));
    };
    if !is_valid_id(rest, true) {
        return Err(ResolveError::InvalidId("workflow run id".into()));
    }
    Ok(raw)
}

/// Where claude keeps its `projects/` tree for this agent entry.
///
/// Docker first: the container's config dir is a termic-owned host dir, and a
/// named account inside it has `projects` mounted from that same primary dir,
/// so the account never changes where transcripts land. On the host a named
/// account's store is a symlink farm whose `projects` points back at the
/// primary dir; reading through the store keeps that true even if the store
/// is ever given a `projects` of its own.
pub(crate) fn projects_root(
    agents: &[crate::Agent],
    agent_id: &str,
    docker: bool,
    home: &Path,
    account_store: Option<PathBuf>,
) -> Option<PathBuf> {
    if docker {
        return Some(crate::docker::agent_config_host_dir(agent_id).join("projects"));
    }

    if let Some(store) = account_store {
        return Some(store.join("projects"));
    }

    Some(crate::agent_dirs::instance_config_dir(agents, agent_id, home)?.join("projects"))
}

pub(crate) fn session_subagents_dir(
    projects_root: &Path,
    task_path: &str,
    session_id: &str,
) -> Result<PathBuf, ResolveError> {
    let session_id = validate_session_id(session_id)?;
    let slug = crate::cli_server::claude_project_dir_name(task_path);
    Ok(projects_root.join(slug).join(session_id).join("subagents"))
}

fn confine(subagents_dir: &Path, candidate: &Path) -> Result<PathBuf, ResolveError> {
    let root = fs::canonicalize(subagents_dir).map_err(|_| ResolveError::NotFound)?;
    let file = fs::canonicalize(candidate).map_err(|_| ResolveError::NotFound)?;
    if !file.starts_with(&root) {
        return Err(ResolveError::Escapes);
    }

    if !file.is_file() {
        return Err(ResolveError::NotFound);
    }
    Ok(file)
}

fn agent_file_path(
    subagents_dir: &Path,
    agent_id: &str,
    workflow_run_id: Option<&str>,
    suffix: &str,
) -> Result<PathBuf, ResolveError> {
    let bare = validate_agent_id(agent_id)?;
    let mut dir = subagents_dir.to_path_buf();
    if let Some(run) = workflow_run_id {
        dir = dir.join("workflows").join(validate_workflow_run_id(run)?);
    }
    Ok(dir.join(format!("agent-{bare}{suffix}")))
}

/// The canonical path of one agent's transcript, confined to `subagents_dir`.
pub(crate) fn resolve_agent_file(
    subagents_dir: &Path,
    agent_id: &str,
    workflow_run_id: Option<&str>,
) -> Result<PathBuf, ResolveError> {
    let candidate = agent_file_path(subagents_dir, agent_id, workflow_run_id, ".jsonl")?;
    confine(subagents_dir, &candidate)
}

fn read_meta(subagents_dir: &Path, agent_id: &str, workflow_run_id: Option<&str>) -> SubagentMeta {
    agent_file_path(subagents_dir, agent_id, workflow_run_id, ".meta.json")
        .and_then(|candidate| confine(subagents_dir, &candidate))
        .ok()
        .and_then(|file| fs::read_to_string(file).ok())
        .map(|raw| parse_meta(&raw))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// parsing

pub(crate) fn parse_meta(raw: &str) -> SubagentMeta {
    let Ok(serde_json::Value::Object(v)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return SubagentMeta::default();
    };
    let text = |key: &str| v.get(key).and_then(|x| x.as_str()).map(str::to_string);

    SubagentMeta {
        agent_type: text("agentType"),
        description: text("description"),
        model: text("model"),
        tool_use_id: text("toolUseId"),
        spawn_depth: v.get("spawnDepth").and_then(|x| x.as_u64()),
        parent_agent_id: text("parentAgentId"),
        request_shape: text("requestShape"),
        request_non_interactive: v.get("requestNonInteractive").and_then(|x| x.as_bool()),
        workflow_phase: text("workflowPhase"),
    }
}

pub(crate) fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }

        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    let is_string_terminator = next == '\u{1b}' && chars.peek() == Some(&'\\');
                    if is_string_terminator {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn cap_body(raw: &str) -> (String, bool) {
    let clean = strip_ansi(raw);
    if clean.len() <= BODY_BYTE_CAP {
        return (clean, false);
    }

    let mut end = BODY_BYTE_CAP;
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    (clean[..end].to_string(), true)
}

fn entry(kind: EntryKind, body: &str, timestamp: &Option<String>) -> TranscriptEntry {
    let (text, truncated) = cap_body(body);
    TranscriptEntry { kind, text, truncated, name: None, is_error: false, timestamp: timestamp.clone() }
}

fn block_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b.get("text").and_then(|t| t.as_str()).map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What one transcript line contributes: its entries, and whether this line,
/// were it the last meaningful one, ends the run.
struct ParsedLine {
    entries: Vec<TranscriptEntry>,
    outcome: Outcome,
}

fn parse_user(message: &serde_json::Value, timestamp: &Option<String>) -> Vec<TranscriptEntry> {
    let Some(content) = message.get("content") else { return Vec::new() };
    if let Some(s) = content.as_str() {
        return vec![entry(EntryKind::UserText, s, timestamp)];
    }

    let Some(blocks) = content.as_array() else { return Vec::new() };
    let mut out = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block.get("text").and_then(|t| t.as_str()).unwrap_or_default();
                out.push(entry(EntryKind::UserText, text, timestamp));
            }
            Some("tool_result") => {
                let body = block.get("content").map(block_text).unwrap_or_default();
                let mut result = entry(EntryKind::ToolResult, &body, timestamp);
                result.is_error = block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                out.push(result);
            }
            _ => {}
        }
    }
    out
}

fn parse_assistant(message: &serde_json::Value, timestamp: &Option<String>) -> Vec<TranscriptEntry> {
    let Some(content) = message.get("content") else { return Vec::new() };
    if let Some(s) = content.as_str() {
        return vec![entry(EntryKind::AssistantText, s, timestamp)];
    }

    let Some(blocks) = content.as_array() else { return Vec::new() };
    let mut out = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block.get("text").and_then(|t| t.as_str()).unwrap_or_default();
                out.push(entry(EntryKind::AssistantText, text, timestamp));
            }
            Some("thinking") => {
                let text = block.get("thinking").and_then(|t| t.as_str()).unwrap_or_default();
                out.push(entry(EntryKind::Thinking, text, timestamp));
            }
            Some("redacted_thinking") => {
                out.push(entry(EntryKind::RedactedThinking, "", timestamp));
            }
            Some("tool_use") => {
                let input = block.get("input").map(|i| i.to_string()).unwrap_or_default();
                let mut call = entry(EntryKind::ToolUse, &input, timestamp);
                call.name = block.get("name").and_then(|n| n.as_str()).map(str::to_string);
                out.push(call);
            }
            _ => {}
        }
    }
    out
}

fn assistant_outcome(message: &serde_json::Value, entries: &[TranscriptEntry]) -> Outcome {
    let stop_reason = message.get("stop_reason").and_then(|s| s.as_str());
    let calls_a_tool = entries.iter().any(|e| e.kind == EntryKind::ToolUse);
    let says_something = entries.iter().any(|e| e.kind == EntryKind::AssistantText);
    let waits_on_tool = stop_reason == Some("tool_use");
    let ends_turn = says_something && !calls_a_tool && !waits_on_tool;
    if ends_turn { Outcome::Done } else { Outcome::None }
}

/// One JSONL line. `None` means the line was not understood and is counted
/// as skipped.
fn parse_line(line: &str) -> Option<ParsedLine> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let timestamp = v.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
    let line_type = v.get("type").and_then(|t| t.as_str())?;

    match line_type {
        "user" => {
            let entries = parse_user(v.get("message")?, &timestamp);
            let ends_on_error = entries
                .last()
                .is_some_and(|e| e.kind == EntryKind::ToolResult && e.is_error);
            let outcome = if ends_on_error { Outcome::Failed } else { Outcome::None };
            Some(ParsedLine { entries, outcome })
        }
        "assistant" => {
            let message = v.get("message")?;
            let is_api_error = v.get("isApiErrorMessage").and_then(|e| e.as_bool()).unwrap_or(false);
            if is_api_error {
                let body = message.get("content").map(block_text).unwrap_or_default();
                let entries = vec![entry(EntryKind::Error, &body, &timestamp)];
                return Some(ParsedLine { entries, outcome: Outcome::Failed });
            }

            let entries = parse_assistant(message, &timestamp);
            let outcome = assistant_outcome(message, &entries);
            Some(ParsedLine { entries, outcome })
        }
        "system" => {
            let level = v.get("level").and_then(|l| l.as_str()).unwrap_or_default();
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or_default();
            let is_error = level == "error" || subtype.contains("error");
            if !is_error {
                return None;
            }

            let body = v
                .get("content")
                .and_then(|c| c.as_str())
                .map(str::to_string)
                .or_else(|| v.get("error").map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())))
                .unwrap_or_default();
            let entries = vec![entry(EntryKind::Error, &body, &timestamp)];
            Some(ParsedLine { entries, outcome: Outcome::Failed })
        }
        _ => None,
    }
}

pub(crate) struct ParsedTranscript {
    pub entries: Vec<TranscriptEntry>,
    pub skipped_lines: usize,
    pub outcome: Outcome,
}

/// Every complete line of `raw`. Text after the last newline is a line Claude
/// is still writing and is left alone until it is finished.
pub(crate) fn parse_transcript(raw: &str) -> ParsedTranscript {
    let mut entries = Vec::new();
    let mut skipped_lines = 0;
    let mut outcome = Outcome::None;

    let complete = match raw.rfind('\n') {
        Some(end) => &raw[..end],
        None => "",
    };
    for line in complete.split('\n') {
        if line.trim().is_empty() {
            continue;
        }

        let Some(parsed) = parse_line(line) else {
            skipped_lines += 1;
            continue;
        };
        if !parsed.entries.is_empty() {
            outcome = parsed.outcome;
        }
        entries.extend(parsed.entries);
    }
    ParsedTranscript { entries, skipped_lines, outcome }
}

/// The outcome of one transcript file, reading only its last
/// `OUTCOME_TAIL_BYTES`. A file that is not there any more is `Expired`.
pub(crate) fn outcome_of_file(path: &Path) -> Outcome {
    let Ok(mut file) = fs::File::open(path) else { return Outcome::Expired };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(OUTCOME_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Outcome::None;
    }

    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Outcome::None;
    }
    let tail = String::from_utf8_lossy(&bytes);
    let tail = if start > 0 {
        match tail.find('\n') {
            Some(first_break) => &tail[first_break + 1..],
            None => "",
        }
    } else {
        &tail[..]
    };
    parse_transcript(tail).outcome
}

/// One page of entries ending just before `before` (or at the end).
pub(crate) fn window(total: usize, before: Option<usize>) -> (usize, usize) {
    let end = before.unwrap_or(total).min(total);
    (end.saturating_sub(WINDOW), end)
}

// ---------------------------------------------------------------------------
// reading

pub(crate) fn read_transcript(
    subagents_dir: &Path,
    agent_id: &str,
    workflow_run_id: Option<&str>,
    before: Option<usize>,
) -> Result<TranscriptPage, ResolveError> {
    let bare = validate_agent_id(agent_id)?.to_string();
    let file = match resolve_agent_file(subagents_dir, agent_id, workflow_run_id) {
        Ok(file) => file,
        Err(ResolveError::NotFound) => {
            return Ok(TranscriptPage {
                agent_id: bare,
                entries: Vec::new(),
                total: 0,
                start: 0,
                skipped_lines: 0,
                outcome: Outcome::Expired,
                meta: SubagentMeta::default(),
            });
        }
        Err(e) => return Err(e),
    };

    let bytes = fs::read(&file).map_err(|_| ResolveError::NotFound)?;
    let parsed = parse_transcript(&String::from_utf8_lossy(&bytes));
    let total = parsed.entries.len();
    let (start, end) = window(total, before);
    let mut entries = parsed.entries;
    entries.truncate(end);
    entries.drain(..start);

    Ok(TranscriptPage {
        agent_id: bare,
        entries,
        total,
        start,
        skipped_lines: parsed.skipped_lines,
        outcome: parsed.outcome,
        meta: read_meta(subagents_dir, agent_id, workflow_run_id),
    })
}

fn agent_ids_in(dir: &Path) -> Vec<String> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    read.flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let stem = name.strip_suffix(".jsonl")?;
            let id = stem.strip_prefix("agent-")?;
            validate_agent_id(id).ok().map(str::to_string)
        })
        .collect()
}

fn summarise(subagents_dir: &Path, agent_id: &str, workflow_run_id: Option<&str>) -> Option<SubagentSummary> {
    let file = resolve_agent_file(subagents_dir, agent_id, workflow_run_id).ok()?;
    let mtime_ms = fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Some(SubagentSummary {
        agent_id: agent_id.to_string(),
        is_workflow: workflow_run_id.is_some(),
        workflow_run_id: workflow_run_id.map(str::to_string),
        meta: read_meta(subagents_dir, agent_id, workflow_run_id),
        mtime_ms,
        outcome: outcome_of_file(&file),
    })
}

pub(crate) fn list_subagents(subagents_dir: &Path, limit: usize) -> Vec<SubagentSummary> {
    let mut out: Vec<SubagentSummary> = agent_ids_in(subagents_dir)
        .iter()
        .filter_map(|id| summarise(subagents_dir, id, None))
        .collect();

    if let Ok(runs) = fs::read_dir(subagents_dir.join("workflows")) {
        for run in runs.flatten() {
            let Ok(run_id) = run.file_name().into_string() else { continue };
            if validate_workflow_run_id(&run_id).is_err() {
                continue;
            }

            for id in agent_ids_in(&run.path()) {
                out.extend(summarise(subagents_dir, &id, Some(&run_id)));
            }
        }
    }

    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out.truncate(limit);
    out
}

// ---------------------------------------------------------------------------
// commands

/// The `subagents/` dir of one tab's claude session, from host state only.
///
/// The tab is found by its session id, which also names the agent entry it
/// runs (a clone carries its own `CLAUDE_CONFIG_DIR`). The task's own agent
/// is the fallback for a session minted before tabs were persisted.
pub(crate) fn subagents_dir_for(task_id: &str, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id).map_err(|e| e.to_string())?;
    let task = crate::load_tasks_all()
        .into_iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("no task {task_id}"))?;
    let settings = crate::load_settings_in(&task.profile);

    let agent_id = task
        .persisted_tabs
        .iter()
        .chain(task.right_split_tabs.iter())
        .find(|tab| tab.session_id.as_deref() == Some(session_id))
        .map(|tab| tab.cli.clone())
        .or_else(|| {
            task.agent_session_ids
                .iter()
                .find(|(_, sid)| sid.as_str() == session_id)
                .map(|(agent, _)| agent.clone())
        })
        .unwrap_or_else(|| task.cli.clone());

    let docker = task.docker_sandbox_enabled && settings.docker_sandbox_enabled;
    let account_store = if docker {
        None
    } else {
        crate::relocating_account(Some(&task), &agent_id, &settings.agents)
            .and_then(|account| crate::login_store_dir(&agent_id, Some(&account), crate::LoginRealm::Host))
    };
    let home = dirs::home_dir().ok_or("no home dir")?;
    let root = projects_root(&settings.agents, &agent_id, docker, &home, account_store)
        .ok_or_else(|| format!("{agent_id} has no known config dir"))?;

    session_subagents_dir(&root, &task.path, session_id).map_err(|e| e.to_string())
}

/// Every subagent of one session, newest first.
#[tauri::command]
pub async fn subagent_list(
    task_id: String,
    session_id: String,
    limit: Option<usize>,
) -> Result<Vec<SubagentSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = subagents_dir_for(&task_id, &session_id)?;
        Ok(list_subagents(&dir, limit.unwrap_or(DEFAULT_LIST_LIMIT)))
    })
    .await
    .map_err(|e| format!("subagent list failed: {e}"))?
}

/// One page of one subagent's transcript. `before` is the `start` of the page
/// already shown; omit it for the newest page.
#[tauri::command]
pub async fn subagent_transcript_read(
    task_id: String,
    session_id: String,
    agent_id: String,
    workflow_run_id: Option<String>,
    before: Option<usize>,
) -> Result<TranscriptPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = subagents_dir_for(&task_id, &session_id)?;
        read_transcript(&dir, &agent_id, workflow_run_id.as_deref(), before).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("subagent transcript read failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0b1c2d3e-0000-4000-8000-000000000001";
    const OTHER_SESSION: &str = "0b1c2d3e-0000-4000-8000-000000000002";
    const TASK_PATH: &str = "/Users/u/dev/acme";

    fn agent(id: &str, extends: Option<&str>, env: &[(&str, &str)]) -> crate::Agent {
        let mut a = crate::default_agents().into_iter().next().unwrap();
        a.id = id.to_string();
        a.extends = extends.map(|s| s.to_string());
        a.env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        a
    }

    fn user_text(text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn assistant_text(text: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
                "stop_reason": "end_turn",
            },
        })
        .to_string()
    }

    fn tool_call(name: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "toolu_x", "name": name, "input": { "path": "/Users/u/dev/acme/README.md" } }],
                "stop_reason": "tool_use",
            },
        })
        .to_string()
    }

    fn tool_result(body: &str, is_error: bool) -> String {
        serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "toolu_x", "content": body, "is_error": is_error }],
            },
        })
        .to_string()
    }

    fn jsonl(lines: &[String]) -> String {
        lines.iter().map(|l| format!("{l}\n")).collect()
    }

    /// `<root>/<slug>/<session>/subagents/`, created.
    fn session_dir(root: &Path, session: &str) -> PathBuf {
        let dir = session_subagents_dir(root, TASK_PATH, session).unwrap();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn projects_root_honours_claude_config_dir() {
        let home = Path::new("/Users/u");
        let agents = vec![
            agent("claude", None, &[]),
            agent("next-claude", Some("claude"), &[("CLAUDE_CONFIG_DIR", "~/.next-claude")]),
        ];

        assert_eq!(
            projects_root(&agents, "claude", false, home, None),
            Some(PathBuf::from("/Users/u/.claude/projects")),
        );
        assert_eq!(
            projects_root(&agents, "next-claude", false, home, None),
            Some(PathBuf::from("/Users/u/.next-claude/projects")),
        );

        let store = PathBuf::from("/Users/u/termic/logins/claude/work");
        assert_eq!(
            projects_root(&agents, "claude", false, home, Some(store.clone())),
            Some(store.join("projects")),
        );
    }

    #[test]
    fn projects_root_uses_docker_agent_dir() {
        let home = Path::new("/Users/u");
        let agents = vec![agent("claude", None, &[])];
        let store = PathBuf::from("/Users/u/termic/logins/claude/work");

        let expected = crate::docker::agent_config_host_dir("claude").join("projects");
        assert_eq!(projects_root(&agents, "claude", true, home, None), Some(expected.clone()));
        assert_eq!(projects_root(&agents, "claude", true, home, Some(store)), Some(expected));
    }

    #[cfg(unix)]
    #[test]
    fn account_store_symlinked_projects_is_readable() {
        let tmp = tempfile::tempdir().unwrap();
        let primary_projects = tmp.path().join("primary").join("projects");
        let dir = session_dir(&primary_projects, SESSION);
        fs::write(dir.join("agent-a0000000000000001.jsonl"), jsonl(&[assistant_text("hello")])).unwrap();

        let store = tmp.path().join("logins").join("claude").join("work");
        fs::create_dir_all(&store).unwrap();
        std::os::unix::fs::symlink(&primary_projects, store.join("projects")).unwrap();

        let agents = vec![agent("claude", None, &[])];
        let root = projects_root(&agents, "claude", false, Path::new("/Users/u"), Some(store)).unwrap();
        let through_store = session_subagents_dir(&root, TASK_PATH, SESSION).unwrap();

        let page = read_transcript(&through_store, "a0000000000000001", None, None).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].text, "hello");
        assert_eq!(list_subagents(&through_store, 10).len(), 1);
    }

    #[test]
    fn rejects_traversal_agent_id() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = session_dir(tmp.path(), SESSION);

        for bad in ["../x", "a/b", "agent-..", "", "agent-", "a b", "a\\b", &"a".repeat(65)] {
            assert!(
                matches!(resolve_agent_file(&dir, bad, None), Err(ResolveError::InvalidId(_))),
                "{bad:?} was accepted",
            );
        }
        for bad in ["../wf_x", "wf_../x", "x", "wf_"] {
            assert!(matches!(
                resolve_agent_file(&dir, "a0000000000000001", Some(bad)),
                Err(ResolveError::InvalidId(_)),
            ));
        }
        for bad in ["../s", "s_1", "", "s/1"] {
            assert!(matches!(
                session_subagents_dir(tmp.path(), TASK_PATH, bad),
                Err(ResolveError::InvalidId(_)),
            ));
        }

        assert_eq!(validate_agent_id("agent-a0000000000000001"), Ok("a0000000000000001"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escaping_subagents_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = session_dir(&tmp.path().join("projects"), SESSION);
        let outside = tmp.path().join("secret.jsonl");
        fs::write(&outside, jsonl(&[assistant_text("not yours")])).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("agent-aZZZ.jsonl")).unwrap();

        assert_eq!(resolve_agent_file(&dir, "aZZZ", None), Err(ResolveError::Escapes));
        assert_eq!(read_transcript(&dir, "aZZZ", None, None).unwrap_err(), ResolveError::Escapes);
        assert!(list_subagents(&dir, 10).is_empty());
    }

    #[test]
    fn wrong_session_cannot_reach_other_sessions_agent() {
        let tmp = tempfile::tempdir().unwrap();
        session_dir(tmp.path(), SESSION);
        let other = session_dir(tmp.path(), OTHER_SESSION);
        fs::write(other.join("agent-aBBB.jsonl"), jsonl(&[assistant_text("b")])).unwrap();

        let asked = session_subagents_dir(tmp.path(), TASK_PATH, SESSION).unwrap();
        assert_eq!(resolve_agent_file(&asked, "aBBB", None), Err(ResolveError::NotFound));
        assert!(resolve_agent_file(&other, "aBBB", None).is_ok());
    }

    #[test]
    fn skips_malformed_and_partial_lines() {
        let raw = format!(
            "{}\n{{not json\n{}\n{}\n{}\n{}",
            user_text("go"),
            r#"{"type":"file-history-snapshot","snapshot":{}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok","extra":1}]},"unknownKey":true}"#,
            r#"{"noType":1}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"half"#,
        );

        let parsed = parse_transcript(&raw);
        let texts: Vec<&str> = parsed.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, ["go", "ok"]);
        assert_eq!(parsed.skipped_lines, 3);

        let complete_but_unterminated = assistant_text("never parsed");
        assert!(parse_transcript(&complete_but_unterminated).entries.is_empty());
    }

    #[test]
    fn meta_fields_are_all_optional() {
        let full = parse_meta(
            r#"{"agentType":"general-purpose","description":"Look around","model":"sonnet","toolUseId":"toolu_x","spawnDepth":2,"parentAgentId":"a0000000000000001","requestShape":"background","requestNonInteractive":true,"workflowPhase":"Verify","later":1}"#,
        );
        assert_eq!(full.agent_type.as_deref(), Some("general-purpose"));
        assert_eq!(full.spawn_depth, Some(2));
        assert_eq!(full.request_non_interactive, Some(true));
        assert_eq!(full.workflow_phase.as_deref(), Some("Verify"));
        assert_eq!(full.parent_agent_id.as_deref(), Some("a0000000000000001"));

        let older = parse_meta(r#"{"agentType":"Explore","spawnDepth":1}"#);
        assert_eq!(older.agent_type.as_deref(), Some("Explore"));
        assert_eq!(older.description, None);

        assert_eq!(parse_meta(r#"{"spawnDepth":"deep","model":3}"#), SubagentMeta::default());
        assert_eq!(parse_meta("not json"), SubagentMeta::default());
        assert_eq!(parse_meta("[]"), SubagentMeta::default());

        let tmp = tempfile::tempdir().unwrap();
        let dir = session_dir(tmp.path(), SESSION);
        fs::write(dir.join("agent-aNoMeta.jsonl"), jsonl(&[assistant_text("x")])).unwrap();
        assert_eq!(list_subagents(&dir, 10)[0].meta, SubagentMeta::default());
    }

    #[test]
    fn returns_last_500_and_pages_backwards() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = session_dir(tmp.path(), SESSION);
        let lines: Vec<String> = (0..1200).map(|i| user_text(&format!("m{i}"))).collect();
        fs::write(dir.join("agent-aLong.jsonl"), jsonl(&lines)).unwrap();

        let newest = read_transcript(&dir, "aLong", None, None).unwrap();
        assert_eq!((newest.total, newest.start, newest.entries.len()), (1200, 700, 500));
        assert_eq!(newest.entries[0].text, "m700");
        assert_eq!(newest.entries[499].text, "m1199");

        let earlier = read_transcript(&dir, "aLong", None, Some(newest.start)).unwrap();
        assert_eq!((earlier.start, earlier.entries.len()), (200, 500));
        assert_eq!(earlier.entries[0].text, "m200");

        let first = read_transcript(&dir, "aLong", None, Some(earlier.start)).unwrap();
        assert_eq!((first.start, first.entries.len()), (0, 200));
        assert_eq!(first.entries[199].text, "m199");

        assert_eq!(window(10, Some(9999)), (0, 10));
    }

    #[test]
    fn caps_oversized_entry_bodies() {
        let huge = "é".repeat(BODY_BYTE_CAP);
        let parsed = parse_transcript(&jsonl(&[tool_result(&huge, false), user_text("short")]));

        let capped = &parsed.entries[0];
        assert!(capped.truncated);
        assert!(capped.text.len() <= BODY_BYTE_CAP);
        assert!(capped.text.len() > BODY_BYTE_CAP - 4);
        assert!(!parsed.entries[1].truncated);
    }

    #[test]
    fn maps_entry_kinds_and_strips_ansi() {
        let thinking = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "redacted_thinking", "data": "opaque" },
            ]},
        })
        .to_string();
        let api_error = serde_json::json!({
            "type": "assistant",
            "isApiErrorMessage": true,
            "message": { "content": [{ "type": "text", "text": "API Error: overloaded" }] },
        })
        .to_string();
        let system_error = r#"{"type":"system","subtype":"api_error","level":"error","content":"retrying"}"#.to_string();
        let system_info = r#"{"type":"system","subtype":"informational","content":"hi"}"#.to_string();

        let parsed = parse_transcript(&jsonl(&[
            user_text("\u{1b}[31mred\u{1b}[0m and \u{1b}]8;;https://acme.com\u{7}link\u{1b}]8;;\u{7}"),
            assistant_text("answer"),
            thinking,
            tool_call("Read"),
            tool_result("boom", true),
            api_error,
            system_error,
            system_info,
        ]));

        let kinds: Vec<EntryKind> = parsed.entries.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            [
                EntryKind::UserText,
                EntryKind::AssistantText,
                EntryKind::Thinking,
                EntryKind::RedactedThinking,
                EntryKind::ToolUse,
                EntryKind::ToolResult,
                EntryKind::Error,
                EntryKind::Error,
            ],
        );
        assert_eq!(parsed.entries[0].text, "red and link");
        assert_eq!(parsed.entries[0].timestamp.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(parsed.entries[3].text, "");
        assert_eq!(parsed.entries[4].name.as_deref(), Some("Read"));
        assert!(parsed.entries[4].text.contains("README.md"));
        assert!(parsed.entries[5].is_error);
        assert_eq!(parsed.entries[6].text, "API Error: overloaded");
        assert_eq!(parsed.skipped_lines, 1);

        let json = serde_json::to_value(&parsed.entries[5]).unwrap();
        assert_eq!(json["kind"], "toolResult");
        assert_eq!(json["isError"], true);
    }

    #[test]
    fn outcome_done_failed_none_expired() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = session_dir(tmp.path(), SESSION);
        let write = |id: &str, lines: &[String]| {
            let path = dir.join(format!("agent-{id}.jsonl"));
            fs::write(&path, jsonl(lines)).unwrap();
            path
        };

        let done = write("aDone", &[user_text("go"), tool_call("Read"), tool_result("ok", false), assistant_text("finished")]);
        let tool_failed = write("aToolErr", &[user_text("go"), tool_call("Bash"), tool_result("exit 1", true)]);
        let api_failed = write(
            "aApiErr",
            &[user_text("go"), r#"{"type":"assistant","isApiErrorMessage":true,"message":{"content":"API Error"}}"#.to_string()],
        );
        let system_failed = write("aSysErr", &[user_text("go"), r#"{"type":"system","level":"error","content":"x"}"#.to_string()]);
        let mid_tool = write("aBusy", &[user_text("go"), tool_call("Read")]);
        let awaiting_reply = write("aWaiting", &[user_text("go"), tool_call("Read"), tool_result("ok", false)]);
        let done_then_noise = write(
            "aNoise",
            &[assistant_text("finished"), r#"{"type":"file-history-snapshot"}"#.to_string(), "garbage".to_string()],
        );

        assert_eq!(outcome_of_file(&done), Outcome::Done);
        assert_eq!(outcome_of_file(&tool_failed), Outcome::Failed);
        assert_eq!(outcome_of_file(&api_failed), Outcome::Failed);
        assert_eq!(outcome_of_file(&system_failed), Outcome::Failed);
        assert_eq!(outcome_of_file(&mid_tool), Outcome::None);
        assert_eq!(outcome_of_file(&awaiting_reply), Outcome::None);
        assert_eq!(outcome_of_file(&done_then_noise), Outcome::Done);
        assert_eq!(outcome_of_file(&dir.join("agent-aGone.jsonl")), Outcome::Expired);
        assert_eq!(read_transcript(&dir, "aGone", None, None).unwrap().outcome, Outcome::Expired);

        let long_done: Vec<String> = (0..3000)
            .map(|i| user_text(&format!("padding line {i}")))
            .chain(std::iter::once(assistant_text("finished")))
            .collect();
        assert_eq!(outcome_of_file(&write("aLongDone", &long_done)), Outcome::Done);
    }

    #[test]
    fn lists_plain_and_workflow_agents_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = session_dir(tmp.path(), SESSION);
        let run = dir.join("workflows").join("wf_run1");
        fs::create_dir_all(&run).unwrap();

        fs::write(dir.join("agent-aOld.jsonl"), jsonl(&[assistant_text("a")])).unwrap();
        fs::write(dir.join("agent-aOld.meta.json"), r#"{"agentType":"Explore","spawnDepth":1}"#).unwrap();
        fs::write(run.join("agent-aWf.jsonl"), jsonl(&[tool_call("Read")])).unwrap();
        fs::write(run.join("agent-aWf.meta.json"), r#"{"agentType":"workflow-subagent","workflowPhase":"Verify"}"#).unwrap();
        fs::write(run.join("journal.jsonl"), "{}\n").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();

        let old = fs::File::options().write(true).open(dir.join("agent-aOld.jsonl")).unwrap();
        old.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_000)).unwrap();

        let all = list_subagents(&dir, 10);
        let ids: Vec<&str> = all.iter().map(|s| s.agent_id.as_str()).collect();
        assert_eq!(ids, ["aWf", "aOld"]);
        assert!(all[0].is_workflow);
        assert_eq!(all[0].workflow_run_id.as_deref(), Some("wf_run1"));
        assert_eq!(all[0].meta.workflow_phase.as_deref(), Some("Verify"));
        assert_eq!(all[0].outcome, Outcome::None);
        assert_eq!(all[1].meta.agent_type.as_deref(), Some("Explore"));
        assert_eq!(all[1].outcome, Outcome::Done);

        assert_eq!(list_subagents(&dir, 1).len(), 1);

        let page = read_transcript(&dir, "agent-aWf", Some("wf_run1"), None).unwrap();
        assert_eq!(page.entries[0].kind, EntryKind::ToolUse);

        let json = serde_json::to_value(&all[0]).unwrap();
        assert_eq!(json["workflowRunId"], "wf_run1");
        assert_eq!(json["agentType"], "workflow-subagent");
        assert_eq!(json["outcome"], "none");
    }
}
