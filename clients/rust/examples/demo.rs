// Run a tiny S1-style demo against a running collector:
//   INGEST_URL=http://localhost:3001/ingest cargo run --example demo
use agentflow_client::{
    Agent, AgentFlowClient, Blackboard, Delegate, Message, Noti, Options, Task, To, Tool,
};
use serde_json::json;

fn main() {
    let url = std::env::var("INGEST_URL").unwrap_or_else(|_| "http://localhost:3001/ingest".into());
    let af = AgentFlowClient::new(Options::new(url).space("home").agent_id("hub"));

    // agents come online
    af.agent_start(Agent { role: Some("orchestrator"), label: Some("HomeHub"), ..Default::default() });
    af.agent_start(Agent { agent_id: "pc", role: Some("worker"), label: Some("Desktop PC"), ..Default::default() });
    af.agent_start(Agent { agent_id: "tv", role: Some("worker"), label: Some("Living-room TV"), ..Default::default() });

    let task = "task-demo-1";

    // user request arrives at the hub
    af.task_input(Task {
        request: Some("휴가 영상 편집해서 TV로 틀어줘"),
        scenario: Some("S1"),
        task_id: Some(task),
        ..Default::default()
    });
    af.message(Message {
        title: "Planning",
        content: "편집은 pc에게, 재생은 tv에게 맡깁니다",
        task_id: Some(task),
        ..Default::default()
    });

    // hub delegates the edit to the pc; pc runs a tool
    af.dispatch(Delegate {
        from: "hub",
        to: "pc",
        task: Some("휴가 영상 편집"),
        task_id: Some(task),
        ..Default::default()
    });
    af.tool_start(Tool {
        agent_id: "pc",
        tool: "edit_video",
        input: Some(json!({"file": "holiday_raw.mp4"})),
        task_id: Some(task),
        ..Default::default()
    });
    af.tool_end(Tool {
        agent_id: "pc",
        tool: "edit_video",
        status: Some("ok"),
        output: Some(json!({"file": "holiday_final.mp4"})),
        summary: Some("2m30s cut"),
        task_id: Some(task),
        ..Default::default()
    });

    // pc publishes the result on the blackboard and returns to the hub
    af.bb_write(Blackboard {
        agent_id: "pc",
        key: "video_result",
        value: Some(json!({"file": "holiday_final.mp4"})),
        task_id: Some(task),
        ..Default::default()
    });
    af.delegate_return(Delegate {
        from: "pc",
        to: "hub",
        payload: Some(json!({"key": "video_result"})),
        task_id: Some(task),
        ..Default::default()
    });

    // hub broadcasts "check the blackboard"; tv reads it and acks
    af.broadcast(Noti {
        from: "hub",
        to: To::Many(&["pc", "tv"]),
        key: Some("video_result"),
        message: Some("영상 준비 완료"),
        task_id: Some(task),
        ..Default::default()
    });
    af.bb_read(Blackboard { agent_id: "tv", key: "video_result", task_id: Some(task), ..Default::default() });
    af.ack(Noti {
        from: "tv",
        to: "hub".into(),
        key: Some("video_result"),
        message: Some("재생 시작"),
        task_id: Some(task),
        ..Default::default()
    });

    // hub reports the final result to the user
    af.task_output(Task {
        result: Some(json!({"status": "playing", "file": "holiday_final.mp4"})),
        scenario: Some("S1"),
        task_id: Some(task),
        ..Default::default()
    });

    // agents go offline
    af.agent_end(Agent { agent_id: "tv", ..Default::default() });
    af.agent_end(Agent { agent_id: "pc", ..Default::default() });
    af.agent_end(Agent::default()); // hub (client default agentId)

    af.close(); // flush + stop
    println!("sent demo events for {task}");
}
