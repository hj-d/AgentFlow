//! AgentFlow SDK — Rust (serde_json + ureq only; batched, fire-and-forget).
//!
//! 7 event kinds: agent · tool · delegate · blackboard · noti · task · message
//! Events are queued and flushed from a background thread; a collector outage
//! never panics or blocks your agent logic.
//!
//! ```no_run
//! use agentflow_client::{
//!     Agent, AgentFlowClient, Blackboard, Delegate, Noti, Options, Task, To, Tool,
//! };
//! use serde_json::json;
//!
//! let af = AgentFlowClient::new(
//!     Options::new("http://collector:3001/ingest").space("home").agent_id("hub"),
//! );
//!
//! af.agent_start(Agent { role: Some("orchestrator"), label: Some("HomeHub"), ..Default::default() });
//! af.task_input(Task { request: Some("영상 만들어줘"), task_id: Some("t-1"), ..Default::default() });
//! af.dispatch(Delegate { from: "hub", to: "pc", task: Some("영상 편집해줘"),
//!     task_id: Some("t-1"), ..Default::default() });
//! af.tool_start(Tool { agent_id: "pc", tool: "edit_video", task_id: Some("t-1"), ..Default::default() });
//! af.bb_write(Blackboard { agent_id: "pc", key: "video_result",
//!     value: Some(json!({"file": "out.mp4"})), task_id: Some("t-1"), ..Default::default() });
//! af.broadcast(Noti { from: "hub", to: To::Many(&["pc", "tv"]), key: Some("video_result"),
//!     task_id: Some("t-1"), ..Default::default() });
//!
//! af.close(); // flush + stop on shutdown
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Result type returned by a [`Options::sender`] implementation.
pub type SendResult = Result<(), String>;

type Sender = Box<dyn Fn(&str, &str) -> SendResult + Send + Sync>;

// ---- options ----

/// Client configuration. Build with the fluent setters.
pub struct Options {
    /// Collector ingest endpoint, e.g. `http://collector:3001/ingest`.
    pub url: String,
    /// Workspace (top-level isolation key) applied to every event.
    pub space: Option<String>,
    /// Default `agentId` applied to every event (overridable per call).
    pub agent_id: Option<String>,
    /// Flush when this many events are queued. Default 20.
    pub batch_size: usize,
    /// Auto-flush interval. `Duration::ZERO` disables the timer. Default 250 ms.
    pub flush_interval: Duration,
    /// Drop oldest when the queue exceeds this. Default 5000.
    pub max_queue: usize,
    /// HTTP timeout for the default sender. Default 500 ms.
    pub timeout: Duration,
    sender: Option<Sender>,
}

impl Options {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            space: None,
            agent_id: None,
            batch_size: 20,
            flush_interval: Duration::from_millis(250),
            max_queue: 5000,
            timeout: Duration::from_millis(500),
            sender: None,
        }
    }
    /// Workspace (top-level isolation key) applied to every event.
    pub fn space(mut self, v: impl Into<String>) -> Self {
        self.space = Some(v.into());
        self
    }
    /// Default `agentId` applied to every event (overridable per call).
    pub fn agent_id(mut self, v: impl Into<String>) -> Self {
        self.agent_id = Some(v.into());
        self
    }
    pub fn batch_size(mut self, v: usize) -> Self {
        self.batch_size = v;
        self
    }
    pub fn flush_interval(mut self, v: Duration) -> Self {
        self.flush_interval = v;
        self
    }
    pub fn max_queue(mut self, v: usize) -> Self {
        self.max_queue = v;
        self
    }
    pub fn timeout(mut self, v: Duration) -> Self {
        self.timeout = v;
        self
    }
    /// Injectable transport `(url, json_body) -> Result` — replaces the
    /// default ureq POST. Useful for tests.
    pub fn sender<F>(mut self, f: F) -> Self
    where
        F: Fn(&str, &str) -> SendResult + Send + Sync + 'static,
    {
        self.sender = Some(Box::new(f));
        self
    }
}

// ---- event params (struct-literal style with `..Default::default()`) ----

/// Recipient(s) of a noti — a single agent or many.
#[derive(Clone, Copy, Debug)]
pub enum To<'a> {
    One(&'a str),
    Many(&'a [&'a str]),
}

impl Default for To<'_> {
    fn default() -> Self {
        To::One("")
    }
}

impl<'a> From<&'a str> for To<'a> {
    fn from(s: &'a str) -> Self {
        To::One(s)
    }
}

impl<'a> From<&'a [&'a str]> for To<'a> {
    fn from(list: &'a [&'a str]) -> Self {
        To::Many(list)
    }
}

impl To<'_> {
    fn value(&self) -> Value {
        match *self {
            To::One(s) => json!(s),
            To::Many(list) => json!(list),
        }
    }
}

/// `agent` event params. Empty `agent_id` falls back to the client default.
#[derive(Debug, Default)]
pub struct Agent<'a> {
    pub agent_id: &'a str,
    pub role: Option<&'a str>,
    pub label: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

/// `tool` event params. `tool` is required.
#[derive(Debug, Default)]
pub struct Tool<'a> {
    pub agent_id: &'a str,
    pub tool: &'a str,
    /// `"ok"` or `"error"` — typically set on [`AgentFlowClient::tool_end`].
    pub status: Option<&'a str>,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub summary: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

/// `delegate` event params. `from` and `to` are required; empty `agent_id`
/// falls back to `from`.
#[derive(Debug, Default)]
pub struct Delegate<'a> {
    pub agent_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub task: Option<&'a str>,
    pub payload: Option<Value>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

/// `blackboard` event params. `key` is required; `value` is only sent on writes.
#[derive(Debug, Default)]
pub struct Blackboard<'a> {
    pub agent_id: &'a str,
    pub key: &'a str,
    pub value: Option<Value>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

/// `noti` event params. `from` and `to` are required; empty `agent_id`
/// falls back to `from`. `to` accepts one agent or many (see [`To`]).
#[derive(Debug, Default)]
pub struct Noti<'a> {
    pub agent_id: &'a str,
    pub from: &'a str,
    pub to: To<'a>,
    pub key: Option<&'a str>,
    pub message: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

/// `task` event params (Hub only). `request` for input, `result` for output.
#[derive(Debug, Default)]
pub struct Task<'a> {
    pub agent_id: &'a str,
    pub request: Option<&'a str>,
    pub result: Option<Value>,
    pub scenario: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

/// `message` event params. `title` and `content` are required.
#[derive(Debug, Default)]
pub struct Message<'a> {
    pub agent_id: &'a str,
    pub title: &'a str,
    pub content: &'a str,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

// ---- json helpers ----

fn base(kind: &str) -> Map<String, Value> {
    let mut o = Map::new();
    o.insert("kind".into(), json!(kind));
    o
}

fn put_str(o: &mut Map<String, Value>, k: &str, v: Option<&str>) {
    if let Some(s) = v {
        o.insert(k.into(), json!(s));
    }
}

fn put_val(o: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(x) = v {
        o.insert(k.into(), x);
    }
}

fn put_id(o: &mut Map<String, Value>, agent_id: &str) {
    if !agent_id.is_empty() {
        o.insert("agentId".into(), json!(agent_id));
    }
}

// ---- shared state ----

struct Shared {
    url: String,
    space: Option<String>,
    agent_id: Option<String>,
    batch_size: usize,
    max_queue: usize,
    sender: Sender,
    queue: Mutex<Vec<Value>>,
}

impl Shared {
    fn lock_queue(&self) -> MutexGuard<'_, Vec<Value>> {
        // A poisoned lock only means another thread panicked mid-push;
        // recover the data rather than propagating the panic to the caller.
        self.queue.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn enqueue(&self, event: Value) {
        let event = match event {
            Value::Object(mut obj) => {
                if !obj.contains_key("agentId") {
                    if let Some(a) = &self.agent_id {
                        obj.insert("agentId".into(), json!(a));
                    }
                }
                if !obj.contains_key("space") {
                    if let Some(s) = &self.space {
                        obj.insert("space".into(), json!(s));
                    }
                }
                Value::Object(obj)
            }
            other => other,
        };
        let full;
        {
            let mut q = self.lock_queue();
            q.push(event);
            let over = q.len().saturating_sub(self.max_queue);
            if over > 0 {
                q.drain(0..over); // drop oldest
            }
            full = q.len() >= self.batch_size;
        }
        if full {
            self.flush();
        }
    }

    fn flush(&self) {
        let batch: Vec<Value> = {
            let mut q = self.lock_queue();
            if q.is_empty() {
                return;
            }
            std::mem::take(&mut *q)
        };
        let body = Value::Array(batch.clone()).to_string();
        if (self.sender)(&self.url, &body).is_err() {
            // Re-queue (bounded) so a transient outage doesn't lose recent events.
            let mut q = self.lock_queue();
            let mut combined = batch;
            combined.append(&mut q);
            let over = combined.len().saturating_sub(self.max_queue);
            if over > 0 {
                combined.drain(0..over);
            }
            *q = combined;
        }
    }
}

// ---- client ----

/// Batched, fire-and-forget client. Construct once per agent/process.
pub struct AgentFlowClient {
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl AgentFlowClient {
    pub fn new(opts: Options) -> Self {
        let Options {
            url,
            space,
            agent_id,
            batch_size,
            flush_interval,
            max_queue,
            timeout,
            sender,
        } = opts;
        let sender: Sender = sender.unwrap_or_else(|| {
            let agent = ureq::AgentBuilder::new().timeout(timeout).build();
            Box::new(move |url: &str, body: &str| {
                agent
                    .post(url)
                    .set("Content-Type", "application/json")
                    .send_string(body)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
        });
        let shared = Arc::new(Shared {
            url,
            space,
            agent_id,
            batch_size,
            max_queue,
            sender,
            queue: Mutex::new(Vec::new()),
        });
        let stop = Arc::new(AtomicBool::new(false));

        let worker = if flush_interval > Duration::ZERO {
            let s = Arc::clone(&shared);
            let st = Arc::clone(&stop);
            Some(thread::spawn(move || {
                while !st.load(Ordering::Relaxed) {
                    thread::sleep(flush_interval);
                    s.flush();
                }
            }))
        } else {
            None
        };

        Self { shared, stop, worker }
    }

    /// Low-level: enqueue any event object. Default `agentId`/`space` are
    /// filled in when missing. Never blocks on the network, never panics.
    pub fn emit(&self, event: Value) {
        self.shared.enqueue(event);
    }

    // ---- Agent ----

    /// Agent comes online — call once at startup so it appears in the topology immediately.
    pub fn agent_start(&self, a: Agent) {
        self.agent_event(a, "start");
    }
    /// Agent goes offline.
    pub fn agent_end(&self, a: Agent) {
        self.agent_event(a, "end");
    }

    fn agent_event(&self, a: Agent, phase: &str) {
        let mut o = base("agent");
        o.insert("phase".into(), json!(phase));
        put_id(&mut o, a.agent_id);
        put_str(&mut o, "role", a.role);
        put_str(&mut o, "label", a.label);
        put_str(&mut o, "taskId", a.task_id);
        put_str(&mut o, "traceId", a.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- Tool ----

    /// Mark the agent as busy with a tool.
    pub fn tool_start(&self, t: Tool) {
        self.tool_event(t, "start");
    }
    /// Release the busy state and record the result.
    pub fn tool_end(&self, t: Tool) {
        self.tool_event(t, "end");
    }

    fn tool_event(&self, t: Tool, phase: &str) {
        let mut o = base("tool");
        o.insert("phase".into(), json!(phase));
        o.insert("tool".into(), json!(t.tool));
        put_id(&mut o, t.agent_id);
        put_str(&mut o, "status", t.status);
        put_val(&mut o, "input", t.input);
        put_val(&mut o, "output", t.output);
        put_str(&mut o, "summary", t.summary);
        put_str(&mut o, "taskId", t.task_id);
        put_str(&mut o, "traceId", t.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- Delegate ----

    /// Dispatch work to another agent.
    pub fn dispatch(&self, d: Delegate) {
        self.delegate_event(d, "dispatch");
    }
    /// Return results to the delegating agent. (`return` is a Rust keyword.)
    pub fn delegate_return(&self, d: Delegate) {
        self.delegate_event(d, "return");
    }

    fn delegate_event(&self, d: Delegate, phase: &str) {
        let mut o = base("delegate");
        o.insert("phase".into(), json!(phase));
        let id = if d.agent_id.is_empty() { d.from } else { d.agent_id };
        put_id(&mut o, id);
        o.insert("from".into(), json!(d.from));
        o.insert("to".into(), json!(d.to));
        put_str(&mut o, "task", d.task);
        put_val(&mut o, "payload", d.payload);
        put_str(&mut o, "taskId", d.task_id);
        put_str(&mut o, "traceId", d.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- Blackboard ----

    /// Write a value to the shared blackboard.
    pub fn bb_write(&self, b: Blackboard) {
        self.bb_event(b, "write", true);
    }
    /// Read a value from the shared blackboard.
    pub fn bb_read(&self, b: Blackboard) {
        self.bb_event(b, "read", false);
    }

    fn bb_event(&self, b: Blackboard, op: &str, with_value: bool) {
        let mut o = base("blackboard");
        o.insert("op".into(), json!(op));
        o.insert("key".into(), json!(b.key));
        put_id(&mut o, b.agent_id);
        if with_value {
            put_val(&mut o, "value", b.value);
        }
        put_str(&mut o, "taskId", b.task_id);
        put_str(&mut o, "traceId", b.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- Noti ----

    /// Broadcast to agents: "check the blackboard at `key`".
    pub fn broadcast(&self, n: Noti) {
        self.noti_event(n, "broadcast");
    }
    /// Acknowledge a broadcast: "I've read and responded to `key`".
    pub fn ack(&self, n: Noti) {
        self.noti_event(n, "ack");
    }

    fn noti_event(&self, n: Noti, phase: &str) {
        let mut o = base("noti");
        o.insert("phase".into(), json!(phase));
        let id = if n.agent_id.is_empty() { n.from } else { n.agent_id };
        put_id(&mut o, id);
        o.insert("from".into(), json!(n.from));
        o.insert("to".into(), n.to.value());
        put_str(&mut o, "key", n.key);
        put_str(&mut o, "message", n.message);
        put_str(&mut o, "taskId", n.task_id);
        put_str(&mut o, "traceId", n.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- Task (Hub only) ----

    /// Hub receives a task from the user.
    pub fn task_input(&self, t: Task) {
        self.task_event(t, "input");
    }
    /// Hub returns the final result to the user.
    pub fn task_output(&self, t: Task) {
        self.task_event(t, "output");
    }

    fn task_event(&self, t: Task, phase: &str) {
        let mut o = base("task");
        o.insert("phase".into(), json!(phase));
        put_id(&mut o, t.agent_id);
        put_str(&mut o, "request", t.request);
        put_val(&mut o, "result", t.result);
        put_str(&mut o, "scenario", t.scenario);
        put_str(&mut o, "taskId", t.task_id);
        put_str(&mut o, "traceId", t.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- Message (agent narration) ----

    /// Agent narrates what it's doing — shown in the Agent 대화 panel.
    pub fn message(&self, m: Message) {
        let mut o = base("message");
        o.insert("title".into(), json!(m.title));
        o.insert("content".into(), json!(m.content));
        put_id(&mut o, m.agent_id);
        put_str(&mut o, "taskId", m.task_id);
        put_str(&mut o, "traceId", m.trace_id);
        self.emit(Value::Object(o));
    }

    // ---- flush / close ----

    /// Send everything queued now (also runs on the background timer).
    pub fn flush(&self) {
        self.shared.flush();
    }

    /// Number of events waiting to be sent.
    pub fn pending(&self) -> usize {
        self.shared.lock_queue().len()
    }

    /// Explicit shutdown (same as dropping): stop the timer thread, join it,
    /// then flush whatever is left.
    pub fn close(self) {
        drop(self);
    }
}

impl Drop for AgentFlowClient {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        self.shared.flush();
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = Arc<Mutex<Vec<Value>>>;

    /// Client with an injected capturing sender and the timer disabled.
    fn client_with(opts: Options) -> (AgentFlowClient, Seen) {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let s = Arc::clone(&seen);
        let af = AgentFlowClient::new(opts.flush_interval(Duration::ZERO).sender(
            move |_url: &str, body: &str| {
                let v: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
                let arr = v.as_array().cloned().unwrap_or_default();
                s.lock().unwrap().extend(arr);
                Ok(())
            },
        ));
        (af, seen)
    }

    fn capture() -> (AgentFlowClient, Seen) {
        client_with(Options::new("http://test/ingest").space("home").agent_id("hub"))
    }

    fn first(af: &AgentFlowClient, seen: &Seen) -> Value {
        af.flush();
        seen.lock().unwrap()[0].clone()
    }

    #[test]
    fn agent_start_json() {
        let (af, seen) = capture();
        af.agent_start(Agent {
            role: Some("orchestrator"),
            label: Some("HomeHub"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "agent", "phase": "start", "agentId": "hub", "space": "home",
                "role": "orchestrator", "label": "HomeHub"
            })
        );
    }

    #[test]
    fn agent_end_json_with_explicit_agent_id() {
        let (af, seen) = capture();
        af.agent_end(Agent { agent_id: "tv", ..Default::default() });
        assert_eq!(
            first(&af, &seen),
            json!({"kind": "agent", "phase": "end", "agentId": "tv", "space": "home"})
        );
    }

    #[test]
    fn tool_start_json() {
        let (af, seen) = capture();
        af.tool_start(Tool {
            agent_id: "pc",
            tool: "edit_video",
            input: Some(json!({"file": "raw.mp4"})),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "tool", "phase": "start", "tool": "edit_video", "agentId": "pc",
                "space": "home", "input": {"file": "raw.mp4"}, "taskId": "t-1"
            })
        );
    }

    #[test]
    fn tool_end_json() {
        let (af, seen) = capture();
        af.tool_end(Tool {
            agent_id: "pc",
            tool: "edit_video",
            status: Some("ok"),
            output: Some(json!({"file": "out.mp4"})),
            summary: Some("2m30s cut"),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "tool", "phase": "end", "tool": "edit_video", "agentId": "pc",
                "space": "home", "status": "ok", "output": {"file": "out.mp4"},
                "summary": "2m30s cut", "taskId": "t-1"
            })
        );
    }

    #[test]
    fn dispatch_json_agent_id_falls_back_to_from() {
        let (af, seen) = capture();
        af.dispatch(Delegate {
            from: "hub",
            to: "pc",
            task: Some("edit video"),
            payload: Some(json!({"n": 1})),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "delegate", "phase": "dispatch", "agentId": "hub", "space": "home",
                "from": "hub", "to": "pc", "task": "edit video", "payload": {"n": 1},
                "taskId": "t-1"
            })
        );
    }

    #[test]
    fn delegate_return_json() {
        let (af, seen) = capture();
        af.delegate_return(Delegate {
            from: "pc",
            to: "hub",
            payload: Some(json!({"ok": true})),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "delegate", "phase": "return", "agentId": "pc", "space": "home",
                "from": "pc", "to": "hub", "payload": {"ok": true}, "taskId": "t-1"
            })
        );
    }

    #[test]
    fn bb_write_json() {
        let (af, seen) = capture();
        af.bb_write(Blackboard {
            agent_id: "pc",
            key: "video_result",
            value: Some(json!({"file": "out.mp4"})),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "blackboard", "op": "write", "key": "video_result", "agentId": "pc",
                "space": "home", "value": {"file": "out.mp4"}, "taskId": "t-1"
            })
        );
    }

    #[test]
    fn bb_read_json_never_carries_value() {
        let (af, seen) = capture();
        af.bb_read(Blackboard {
            agent_id: "tv",
            key: "video_result",
            value: Some(json!("ignored")),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "blackboard", "op": "read", "key": "video_result", "agentId": "tv",
                "space": "home", "taskId": "t-1"
            })
        );
    }

    #[test]
    fn broadcast_json_to_many() {
        let (af, seen) = capture();
        af.broadcast(Noti {
            from: "hub",
            to: To::Many(&["pc", "tv"]),
            key: Some("task_req"),
            message: Some("check the blackboard"),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "noti", "phase": "broadcast", "agentId": "hub", "space": "home",
                "from": "hub", "to": ["pc", "tv"], "key": "task_req",
                "message": "check the blackboard", "taskId": "t-1"
            })
        );
    }

    #[test]
    fn ack_json_to_single() {
        let (af, seen) = capture();
        af.ack(Noti {
            from: "tv",
            to: "hub".into(),
            key: Some("task_req"),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "noti", "phase": "ack", "agentId": "tv", "space": "home",
                "from": "tv", "to": "hub", "key": "task_req", "taskId": "t-1"
            })
        );
    }

    #[test]
    fn task_input_json() {
        let (af, seen) = capture();
        af.task_input(Task {
            request: Some("영상 만들어줘"),
            scenario: Some("S1"),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "task", "phase": "input", "agentId": "hub", "space": "home",
                "request": "영상 만들어줘", "scenario": "S1", "taskId": "t-1"
            })
        );
    }

    #[test]
    fn task_output_json() {
        let (af, seen) = capture();
        af.task_output(Task {
            result: Some(json!({"file": "out.mp4"})),
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "task", "phase": "output", "agentId": "hub", "space": "home",
                "result": {"file": "out.mp4"}, "taskId": "t-1"
            })
        );
    }

    #[test]
    fn message_json() {
        let (af, seen) = capture();
        af.message(Message {
            title: "Planning",
            content: "Splitting work between pc and tv",
            task_id: Some("t-1"),
            ..Default::default()
        });
        assert_eq!(
            first(&af, &seen),
            json!({
                "kind": "message", "title": "Planning",
                "content": "Splitting work between pc and tv",
                "agentId": "hub", "space": "home", "taskId": "t-1"
            })
        );
    }

    #[test]
    fn emit_applies_defaults_without_overriding() {
        let (af, seen) = capture();
        af.emit(json!({"kind": "agent", "phase": "start"}));
        af.emit(json!({"kind": "agent", "phase": "start", "agentId": "pc", "space": "lab"}));
        af.flush();
        let got = seen.lock().unwrap().clone();
        assert_eq!(
            got[0],
            json!({"kind": "agent", "phase": "start", "agentId": "hub", "space": "home"})
        );
        assert_eq!(
            got[1],
            json!({"kind": "agent", "phase": "start", "agentId": "pc", "space": "lab"})
        );
    }

    #[test]
    fn auto_flushes_at_batch_size() {
        let (af, seen) =
            client_with(Options::new("http://test/ingest").agent_id("hub").batch_size(2));
        af.bb_read(Blackboard { key: "k1", ..Default::default() });
        assert_eq!(seen.lock().unwrap().len(), 0);
        af.bb_read(Blackboard { key: "k2", ..Default::default() });
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_eq!(af.pending(), 0);
    }

    #[test]
    fn drops_oldest_on_overflow() {
        let (af, seen) = client_with(
            Options::new("http://test/ingest")
                .agent_id("hub")
                .batch_size(100)
                .max_queue(3),
        );
        for c in ["a", "b", "c", "d", "e"] {
            af.message(Message { title: "n", content: c, ..Default::default() });
        }
        assert_eq!(af.pending(), 3);
        af.flush();
        let got = seen.lock().unwrap().clone();
        let contents: Vec<&str> = got.iter().map(|e| e["content"].as_str().unwrap()).collect();
        assert_eq!(contents, vec!["c", "d", "e"]);
    }

    #[test]
    fn requeues_on_send_failure_then_resends() {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(Mutex::new(true));
        let (s, f) = (Arc::clone(&seen), Arc::clone(&fail));
        let af = AgentFlowClient::new(
            Options::new("http://test/ingest")
                .agent_id("hub")
                .flush_interval(Duration::ZERO)
                .sender(move |_url: &str, body: &str| {
                    if *f.lock().unwrap() {
                        return Err("collector down".to_string());
                    }
                    let v: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
                    s.lock().unwrap().extend(v.as_array().cloned().unwrap_or_default());
                    Ok(())
                }),
        );
        af.message(Message { title: "hi", content: "there", ..Default::default() });
        af.flush(); // fails → re-queued, never panics
        assert_eq!(af.pending(), 1);
        assert_eq!(seen.lock().unwrap().len(), 0);

        *fail.lock().unwrap() = false;
        af.flush();
        assert_eq!(af.pending(), 0);
        assert_eq!(seen.lock().unwrap().len(), 1);
        af.close();
    }

    #[test]
    fn close_flushes_pending() {
        let (af, seen) = capture();
        af.message(Message { title: "bye", content: "now", ..Default::default() });
        assert_eq!(af.pending(), 1);
        af.close();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn background_thread_flushes() {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let s = Arc::clone(&seen);
        let af = AgentFlowClient::new(
            Options::new("http://test/ingest")
                .agent_id("hub")
                .flush_interval(Duration::from_millis(10))
                .sender(move |_url: &str, body: &str| {
                    let v: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
                    s.lock().unwrap().extend(v.as_array().cloned().unwrap_or_default());
                    Ok(())
                }),
        );
        af.message(Message { title: "tick", content: "tock", ..Default::default() });
        for _ in 0..200 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(seen.lock().unwrap().len(), 1);
        af.close();
    }
}
