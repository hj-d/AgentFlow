//! AgentFlow client SDK for Rust — batched, fire-and-forget.
//!
//! Add emit calls at your message-server relay point, your blackboard read/write,
//! and at agent start/stop. Events are queued and flushed from a background
//! thread; a collector outage never panics or blocks your agent logic.
//!
//! ```no_run
//! use agentflow_client::{AgentFlowClient, Options, Message, Blackboard, Agent, Tool};
//! use serde_json::json;
//!
//! let af = AgentFlowClient::new(
//!     Options::new("http://collector:3001/ingest").device_id("edge-1").team_id("planner"),
//! );
//! af.online(Agent { agent_id: "a1", role: Some("leader"), ..Default::default() });
//! af.message(Message { agent_id: "a1", from: "a1", to: Some("a2"),
//!     msg_type: Some("task"), task_id: Some("t-1"), body: Some(json!({"n": 1})), ..Default::default() });
//! af.blackboard_write(Blackboard { agent_id: "a1", key: "bb:plan", value: Some(json!({"step": 2})),
//!     task_id: Some("t-1"), ..Default::default() });
//! af.blackboard_read(Blackboard { agent_id: "a2", key: "bb:plan", task_id: Some("t-1"), ..Default::default() });
//! af.tool(Tool { agent_id: "a2", tool: "search", phase: Some("start"), task_id: Some("t-1"), ..Default::default() });
//! af.offline(Agent { agent_id: "a1", ..Default::default() });
//! af.close(); // flush + stop on shutdown
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Client configuration. Build with the fluent setters.
pub struct Options {
    pub url: String,
    pub space: Option<String>,
    pub device_id: Option<String>,
    pub team_id: Option<String>,
    pub batch_size: usize,
    pub flush_interval: Duration,
    pub max_queue: usize,
    pub timeout: Duration,
}

impl Options {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            space: None,
            device_id: None,
            team_id: None,
            batch_size: 20,
            flush_interval: Duration::from_millis(250),
            max_queue: 5000,
            timeout: Duration::from_millis(500),
        }
    }
    /// Workspace (top-level isolation key) applied to every event.
    pub fn space(mut self, v: impl Into<String>) -> Self {
        self.space = Some(v.into());
        self
    }
    pub fn device_id(mut self, v: impl Into<String>) -> Self {
        self.device_id = Some(v.into());
        self
    }
    pub fn team_id(mut self, v: impl Into<String>) -> Self {
        self.team_id = Some(v.into());
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
}

struct Shared {
    opts: Options,
    agent: ureq::Agent,
    queue: Mutex<Vec<Value>>,
}

impl Shared {
    fn enqueue(&self, mut obj: Map<String, Value>) {
        if !obj.contains_key("space") {
            if let Some(sp) = &self.opts.space {
                obj.insert("space".into(), json!(sp));
            }
        }
        if !obj.contains_key("deviceId") {
            if let Some(d) = &self.opts.device_id {
                obj.insert("deviceId".into(), json!(d));
            }
        }
        if !obj.contains_key("teamId") {
            if let Some(t) = &self.opts.team_id {
                obj.insert("teamId".into(), json!(t));
            }
        }
        let full;
        {
            let mut q = self.queue.lock().unwrap();
            q.push(Value::Object(obj));
            let over = q.len().saturating_sub(self.opts.max_queue);
            if over > 0 {
                q.drain(0..over);
            }
            full = q.len() >= self.opts.batch_size;
        }
        if full {
            self.flush();
        }
    }

    fn flush(&self) {
        let batch: Vec<Value> = {
            let mut q = self.queue.lock().unwrap();
            if q.is_empty() {
                return;
            }
            std::mem::take(&mut *q)
        };
        let body = Value::Array(batch.clone()).to_string();
        let res = self
            .agent
            .post(&self.opts.url)
            .set("Content-Type", "application/json")
            .send_string(&body);
        if res.is_err() {
            // re-queue (bounded) so a transient outage doesn't lose recent events
            let mut q = self.queue.lock().unwrap();
            let mut combined = batch;
            combined.append(&mut q);
            let over = combined.len().saturating_sub(self.opts.max_queue);
            if over > 0 {
                combined.drain(0..over);
            }
            *q = combined;
        }
    }
}

/// Optional parameters for a message event. `agent_id` and `from` are required;
/// the rest default to `None`/unset via `..Default::default()`.
#[derive(Default)]
pub struct Message<'a> {
    pub agent_id: &'a str,
    pub from: &'a str,
    pub to: Option<&'a str>,
    pub team_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub msg_type: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
    pub tool: Option<&'a str>,
    pub body: Option<Value>,
}

#[derive(Default)]
pub struct Blackboard<'a> {
    pub agent_id: &'a str,
    pub key: &'a str,
    pub team_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub value: Option<Value>,
    pub version: Option<i64>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

#[derive(Default)]
pub struct Agent<'a> {
    pub agent_id: &'a str,
    pub team_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub role: Option<&'a str>,
}

/// A tool invocation. `agent_id` and `tool` are required; `phase` is
/// `"start"` (default when unset) or `"end"`.
#[derive(Default)]
pub struct Tool<'a> {
    pub agent_id: &'a str,
    pub tool: &'a str,
    pub team_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub phase: Option<&'a str>,
    pub status: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
}

fn put_str(o: &mut Map<String, Value>, k: &str, v: Option<&str>) {
    if let Some(s) = v {
        o.insert(k.into(), json!(s));
    }
}

/// Batched, fire-and-forget client. Construct once per device/process.
pub struct AgentFlowClient {
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl AgentFlowClient {
    pub fn new(opts: Options) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(opts.timeout).build();
        let interval = opts.flush_interval;
        let shared = Arc::new(Shared {
            opts,
            agent,
            queue: Mutex::new(Vec::new()),
        });
        let stop = Arc::new(AtomicBool::new(false));

        let worker = if interval > Duration::ZERO {
            let s = shared.clone();
            let st = stop.clone();
            Some(thread::spawn(move || {
                while !st.load(Ordering::Relaxed) {
                    thread::sleep(interval);
                    s.flush();
                }
            }))
        } else {
            None
        };

        Self { shared, stop, worker }
    }

    /// Low-level: enqueue any event object. Never blocks on the network.
    pub fn emit(&self, obj: Map<String, Value>) {
        self.shared.enqueue(obj);
    }

    /// Announce an agent has started — call once on startup so it shows up immediately.
    pub fn online(&self, a: Agent) {
        self.agent_event(a, "online");
    }
    /// Announce an agent has stopped.
    pub fn offline(&self, a: Agent) {
        self.agent_event(a, "offline");
    }

    fn agent_event(&self, a: Agent, status: &str) {
        let mut o = Map::new();
        o.insert("kind".into(), json!("agent"));
        o.insert("status".into(), json!(status));
        o.insert("agentId".into(), json!(a.agent_id));
        put_str(&mut o, "teamId", a.team_id);
        put_str(&mut o, "deviceId", a.device_id);
        put_str(&mut o, "role", a.role);
        self.emit(o);
    }

    /// A message relayed between agents (shown as a direct edge carrying `body`).
    pub fn message(&self, m: Message) {
        let mut o = Map::new();
        o.insert("kind".into(), json!("message"));
        o.insert("op".into(), json!("send"));
        o.insert("agentId".into(), json!(m.agent_id));
        o.insert("from".into(), json!(m.from));
        o.insert("to".into(), m.to.map(|s| json!(s)).unwrap_or(Value::Null)); // key must exist (null = broadcast)
        put_str(&mut o, "teamId", m.team_id);
        put_str(&mut o, "deviceId", m.device_id);
        put_str(&mut o, "msgType", m.msg_type);
        put_str(&mut o, "taskId", m.task_id);
        put_str(&mut o, "traceId", m.trace_id);
        put_str(&mut o, "tool", m.tool);
        if let Some(b) = m.body {
            o.insert("body".into(), b);
        }
        self.emit(o);
    }

    /// Write to the blackboard (agent → Blackboard node, carrying `value`).
    pub fn blackboard_write(&self, b: Blackboard) {
        self.blackboard(b, "write", true);
    }
    /// Read from the blackboard (Blackboard node → agent).
    pub fn blackboard_read(&self, b: Blackboard) {
        self.blackboard(b, "read", false);
    }

    fn blackboard(&self, b: Blackboard, op: &str, with_value: bool) {
        let mut o = Map::new();
        o.insert("kind".into(), json!("blackboard"));
        o.insert("op".into(), json!(op));
        o.insert("agentId".into(), json!(b.agent_id));
        o.insert("key".into(), json!(b.key));
        put_str(&mut o, "teamId", b.team_id);
        put_str(&mut o, "deviceId", b.device_id);
        put_str(&mut o, "taskId", b.task_id);
        put_str(&mut o, "traceId", b.trace_id);
        if let Some(v) = b.version {
            o.insert("version".into(), json!(v));
        }
        if with_value {
            if let Some(v) = b.value {
                o.insert("value".into(), v);
            }
        }
        self.emit(o);
    }

    /// Record a tool invocation (shown as a busy ring + ⚙ label on the agent node).
    /// Bracket long-running tools with `phase: Some("start")` / `Some("end")`; a
    /// single call (default "start") suffices for a quick tool — the busy state
    /// expires on its own.
    pub fn tool(&self, t: Tool) {
        let mut o = Map::new();
        o.insert("kind".into(), json!("tool"));
        o.insert("agentId".into(), json!(t.agent_id));
        o.insert("tool".into(), json!(t.tool));
        put_str(&mut o, "teamId", t.team_id);
        put_str(&mut o, "deviceId", t.device_id);
        put_str(&mut o, "phase", t.phase);
        put_str(&mut o, "status", t.status);
        put_str(&mut o, "summary", t.summary);
        put_str(&mut o, "taskId", t.task_id);
        put_str(&mut o, "traceId", t.trace_id);
        self.emit(o);
    }

    /// Send everything queued now (also runs on the background timer).
    pub fn flush(&self) {
        self.shared.flush();
    }

    /// Number of events waiting to be sent.
    pub fn pending(&self) -> usize {
        self.shared.queue.lock().unwrap().len()
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

impl AgentFlowClient {
    /// Explicit shutdown (same as dropping): stop the timer and flush.
    pub fn close(self) {
        drop(self);
    }
}
