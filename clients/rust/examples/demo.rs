// Run a tiny demo against a running collector:
//   INGEST_URL=http://localhost:3001/ingest cargo run --example demo
use agentflow_client::{Agent, AgentFlowClient, Blackboard, Message, Options, Tool};
use serde_json::json;

fn main() {
    let url = std::env::var("INGEST_URL").unwrap_or_else(|_| "http://localhost:3001/ingest".into());
    let af = AgentFlowClient::new(Options::new(url).device_id("device-A").team_id("alpha"));

    // register agents
    af.online(Agent { agent_id: "lead", role: Some("comm"), ..Default::default() });
    af.online(Agent { agent_id: "w1", role: Some("worker"), ..Default::default() });

    let task = "task-demo-1";
    // worker -> leader, leader -> blackboard, worker reads it back
    af.message(Message { agent_id: "w1", from: "device-A/alpha/w1", to: Some("device-A/alpha/lead"),
        msg_type: Some("request"), task_id: Some(task), body: Some(json!({"task": "rank items"})), ..Default::default() });
    af.blackboard_write(Blackboard { agent_id: "lead", key: "bb:alpha:plan",
        value: Some(json!({"steps": 3})), task_id: Some(task), ..Default::default() });
    af.blackboard_read(Blackboard { agent_id: "w1", key: "bb:alpha:plan", task_id: Some(task), ..Default::default() });
    // worker uses a tool (busy ring + ⚙ label on the node)
    af.tool(Tool { agent_id: "w1", tool: "search", phase: Some("start"), task_id: Some(task), ..Default::default() });
    af.tool(Tool { agent_id: "w1", tool: "search", phase: Some("end"), status: Some("ok"), task_id: Some(task), ..Default::default() });

    af.close();
    println!("sent demo events for {task}");
}
