package agentflow

// Scenario-1-style demo against a running collector:
// Hub discovers agents, delegates to TV (music) and PC (video edit), then plays the result.
//
// Compile & run (no external deps):
//   kotlinc AgentFlowClient.kt Demo.kt -include-runtime -d demo.jar
//   INGEST_URL=http://localhost:3001/ingest java -jar demo.jar
fun main() {
    val url = System.getenv("INGEST_URL") ?: "http://localhost:3001/ingest"
    val af = AgentFlowClient(url, agentId = "hub")
    val t = "task-demo-kt"

    // Agents come online
    af.agentStart(role = "orchestrator", label = "HomeHub")
    af.agentStart(agentId = "tv", role = "worker", label = "거실 TV")
    af.agentStart(agentId = "pc", role = "worker", label = "서재 PC")

    // User request arrives at the Hub
    af.taskInput(request = "가족 사진으로 엄마 생일 영상 만들어줘", scenario = "scenario-1", taskId = t)
    af.message(title = "새 요청 수신 📨", content = "엄마 생일 영상 요청이 들어왔어. 어떤 Agent가 있는지 먼저 확인할게.", taskId = t)

    // Hub discovers agent capabilities
    af.toolStart(tool = "discover_agents", taskId = t)
    af.toolEnd(tool = "discover_agents", status = "ok", taskId = t,
        output = mapOf(
            "pc" to listOf("edit_birthday_video"),
            "tv" to listOf("get_family_music_preferences", "play_video")))

    // Hub → TV: collect music preferences
    af.dispatch(from = "hub", to = "tv", task = "가족 음악 취향 분석해줘", taskId = t)
    af.toolStart(tool = "get_family_music_preferences", agentId = "tv", taskId = t)
    af.toolEnd(tool = "get_family_music_preferences", agentId = "tv", status = "ok", taskId = t,
        output = mapOf("genre" to "K-Pop 발라드", "track" to "사랑해 엄마"))
    af.delegateReturn(from = "tv", to = "hub", taskId = t,
        payload = mapOf("genre" to "K-Pop 발라드", "track" to "사랑해 엄마"))

    // Hub → PC: edit the birthday video
    af.dispatch(from = "hub", to = "pc", task = "사진 28장으로 생일 영상 편집해줘. BGM: 사랑해 엄마", taskId = t)
    af.toolStart(tool = "edit_birthday_video", agentId = "pc", taskId = t,
        input = mapOf("photos" to 28, "bgm" to "사랑해 엄마"))
    af.message(title = "영상 편집 시작! ✂️", content = "사진 28장으로 감동적인 생일 영상을 만드는 중이야.",
        agentId = "pc", taskId = t)
    af.toolEnd(tool = "edit_birthday_video", agentId = "pc", status = "ok", taskId = t,
        output = mapOf("file" to "birthday_mom.mp4", "duration" to "3분 24초"))
    af.delegateReturn(from = "pc", to = "hub", taskId = t,
        payload = mapOf("file" to "birthday_mom.mp4"))

    // Hub → TV: play the finished video
    af.dispatch(from = "hub", to = "tv", task = "birthday_mom.mp4 풀스크린으로 재생해줘", taskId = t)
    af.toolStart(tool = "play_video", agentId = "tv", taskId = t,
        input = mapOf("file" to "birthday_mom.mp4", "fullscreen" to true))
    af.toolEnd(tool = "play_video", agentId = "tv", status = "ok", taskId = t)
    af.delegateReturn(from = "tv", to = "hub", taskId = t,
        payload = mapOf("status" to "playing"))

    // Final result back to the user
    af.taskOutput(taskId = t,
        result = mapOf("video" to "birthday_mom.mp4", "message" to "엄마 생일 영상이 TV에서 재생 중! 🎉"))

    af.close()
    println("sent scenario-1 demo events for $t")
}
