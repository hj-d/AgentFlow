package agentflow

// Tiny demo against a running collector. Compile with the SDK file:
//   kotlinc AgentFlowClient.kt Demo.kt -include-runtime -d demo.jar
//   INGEST_URL=http://localhost:3001/ingest java -jar demo.jar
fun main() {
    val url = System.getenv("INGEST_URL") ?: "http://localhost:3001/ingest"
    val af = AgentFlowClient(url, deviceId = "device-B", teamId = "gamma")

    af.online(agentId = "lead", role = "comm")
    af.online(agentId = "w1", role = "worker")

    val task = "task-demo-kt"
    af.message(agentId = "w1", from = "device-B/gamma/w1", to = "device-B/gamma/lead",
        msgType = "request", taskId = task, body = mapOf("task" to "summarize", "n" to 12))
    af.blackboardWrite(agentId = "lead", key = "bb:gamma:plan",
        value = mapOf("steps" to 4), taskId = task)
    af.blackboardRead(agentId = "w1", key = "bb:gamma:plan", taskId = task)
    af.tool(agentId = "w1", tool = "search", phase = "start", taskId = task) // w1 busy
    af.tool(agentId = "w1", tool = "search", phase = "end", status = "ok", taskId = task)

    af.close()
    println("sent demo events for $task")
}
