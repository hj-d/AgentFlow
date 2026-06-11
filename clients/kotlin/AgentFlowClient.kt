package agentflow

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI

/**
 * AgentFlow SDK — Kotlin/JVM (drop-in, **zero external deps**, JDK 11+).
 *
 * 7 event kinds: agent · tool · delegate · blackboard · noti · task · message
 * Events are batched and sent fire-and-forget from a background daemon thread;
 * a collector outage never throws into your agent logic.
 *
 * ```
 * val af = AgentFlowClient("http://collector:3001/ingest", agentId = "hub")
 *
 * af.agentStart(role = "orchestrator", label = "HomeHub")
 * af.taskInput(request = "영상 만들어줘", scenario = "scenario-1", taskId = "t-1")
 * af.dispatch(from = "hub", to = "pc", task = "영상 편집해줘", taskId = "t-1")
 * af.toolStart(tool = "edit_video", agentId = "pc", taskId = "t-1")
 * af.bbWrite(key = "video_result", value = mapOf("file" to "out.mp4"), taskId = "t-1")
 * af.broadcast(from = "hub", to = listOf("pc", "tv"), key = "task_req", taskId = "t-1")
 *
 * af.close()  // flush + stop on shutdown
 * ```
 *
 * @param url             Collector ingest endpoint, e.g. http://collector:3001/ingest
 * @param space           Workspace (top-level isolation key). Omitted if null.
 * @param agentId         Default agentId applied to every event (overridable per call).
 * @param batchSize       Flush when this many events are queued. Default 20.
 * @param flushIntervalMs Auto-flush interval in ms. 0 disables the timer. Default 250.
 * @param maxQueue        Drop oldest when queue exceeds this. Default 5000.
 * @param timeoutMs       HTTP connect/read timeout in ms. Default 500.
 * @param onError         Called on send failure (default: swallow).
 * @param sender          Injectable transport for tests (url, jsonBody) — defaults to HTTP POST.
 */
class AgentFlowClient(
    private val url: String,
    private val space: String? = null,
    private val agentId: String? = null,
    private val batchSize: Int = 20,
    private val flushIntervalMs: Long = 250,
    private val maxQueue: Int = 5000,
    private val timeoutMs: Int = 500,
    private val onError: ((Exception) -> Unit)? = null,
    sender: ((String, ByteArray) -> Unit)? = null,
) {
    private val send: (String, ByteArray) -> Unit = sender ?: ::httpSend
    private val queue = ArrayList<Map<String, Any?>>()
    private val lock = Any()
    @Volatile private var running = true

    private val worker: Thread? =
        if (flushIntervalMs > 0)
            Thread {
                while (running) {
                    try {
                        Thread.sleep(flushIntervalMs)
                    } catch (_: InterruptedException) {
                        break
                    }
                    flush()
                }
            }.apply { isDaemon = true; name = "agentflow-flusher"; start() }
        else null

    // ---- low-level ----

    /** Enqueue any event map. Applies default agentId/space. Never blocks on the network. */
    fun emit(event: Map<String, Any?>) {
        val e = HashMap(event)
        if (e["space"] == null && space != null) e["space"] = space
        if (e["agentId"] == null && agentId != null) e["agentId"] = agentId
        var full = false
        synchronized(lock) {
            queue.add(e)
            val over = queue.size - maxQueue
            if (over > 0) repeat(over) { queue.removeAt(0) }
            full = queue.size >= batchSize
        }
        if (full) flush()
    }

    // ---- Agent ----

    /** Agent comes online — call once at startup so it appears in the topology immediately. */
    fun agentStart(
        agentId: String? = null,
        role: String? = null,
        label: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "agent", "phase" to "start",
        "agentId" to agentId, "role" to role, "label" to label,
        "taskId" to taskId, "traceId" to traceId))

    /** Agent goes offline. */
    fun agentEnd(
        agentId: String? = null,
        taskId: String? = null,
    ) = emit(noNulls(
        "kind" to "agent", "phase" to "end",
        "agentId" to agentId, "taskId" to taskId))

    // ---- Tool ----

    /** Mark the agent as busy with a tool. */
    fun toolStart(
        tool: String,
        agentId: String? = null,
        input: Any? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "tool", "phase" to "start",
        "agentId" to agentId, "tool" to tool, "input" to input,
        "taskId" to taskId, "traceId" to traceId))

    /** Release the busy state and record the result. `status`: "ok" | "error". */
    fun toolEnd(
        tool: String,
        agentId: String? = null,
        status: String? = null,
        output: Any? = null,
        summary: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "tool", "phase" to "end",
        "agentId" to agentId, "tool" to tool,
        "status" to status, "output" to output, "summary" to summary,
        "taskId" to taskId, "traceId" to traceId))

    // ---- Delegate ----

    /** Dispatch work to another agent. agentId defaults to [from]. */
    fun dispatch(
        from: String,
        to: String,
        agentId: String? = null,
        task: String? = null,
        payload: Any? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "delegate", "phase" to "dispatch",
        "agentId" to (agentId ?: from), "from" to from, "to" to to,
        "task" to task, "payload" to payload,
        "taskId" to taskId, "traceId" to traceId))

    /** Return results to the delegating agent. agentId defaults to [from]. */
    fun delegateReturn(
        from: String,
        to: String,
        agentId: String? = null,
        payload: Any? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "delegate", "phase" to "return",
        "agentId" to (agentId ?: from), "from" to from, "to" to to,
        "payload" to payload, "taskId" to taskId, "traceId" to traceId))

    // ---- Blackboard ----

    /** Write a value to the shared blackboard. */
    fun bbWrite(
        key: String,
        value: Any? = null,
        agentId: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "blackboard", "op" to "write",
        "agentId" to agentId, "key" to key, "value" to value,
        "taskId" to taskId, "traceId" to traceId))

    /** Read a value from the shared blackboard. */
    fun bbRead(
        key: String,
        agentId: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "blackboard", "op" to "read",
        "agentId" to agentId, "key" to key,
        "taskId" to taskId, "traceId" to traceId))

    // ---- Noti ----

    /** Broadcast to several agents: "check the blackboard at [key]". agentId defaults to [from]. */
    fun broadcast(
        from: String,
        to: List<String>,
        agentId: String? = null,
        key: String? = null,
        message: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "noti", "phase" to "broadcast",
        "agentId" to (agentId ?: from), "from" to from, "to" to to,
        "key" to key, "message" to message,
        "taskId" to taskId, "traceId" to traceId))

    /** Broadcast to a single agent: "check the blackboard at [key]". agentId defaults to [from]. */
    fun broadcast(
        from: String,
        to: String,
        agentId: String? = null,
        key: String? = null,
        message: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "noti", "phase" to "broadcast",
        "agentId" to (agentId ?: from), "from" to from, "to" to to,
        "key" to key, "message" to message,
        "taskId" to taskId, "traceId" to traceId))

    /** Acknowledge a broadcast: "I've read and responded to [key]". agentId defaults to [from]. */
    fun ack(
        from: String,
        to: String,
        agentId: String? = null,
        key: String? = null,
        message: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "noti", "phase" to "ack",
        "agentId" to (agentId ?: from), "from" to from, "to" to to,
        "key" to key, "message" to message,
        "taskId" to taskId, "traceId" to traceId))

    // ---- Task (Hub only) ----

    /** Hub receives a task from the user. */
    fun taskInput(
        request: String? = null,
        agentId: String? = null,
        scenario: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "task", "phase" to "input",
        "agentId" to agentId, "request" to request, "scenario" to scenario,
        "taskId" to taskId, "traceId" to traceId))

    /** Hub returns the final result to the user. */
    fun taskOutput(
        result: Any? = null,
        agentId: String? = null,
        scenario: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "task", "phase" to "output",
        "agentId" to agentId, "result" to result, "scenario" to scenario,
        "taskId" to taskId, "traceId" to traceId))

    // ---- Message (agent narration) ----

    /** Agent narrates what it's doing — shown in the Agent 대화 panel. */
    fun message(
        title: String,
        content: String,
        agentId: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls(
        "kind" to "message",
        "agentId" to agentId, "title" to title, "content" to content,
        "taskId" to taskId, "traceId" to traceId))

    // ---- flush / close ----

    /** Send everything queued now (also runs on the background timer). Never throws. */
    fun flush() {
        val batch: List<Map<String, Any?>>
        synchronized(lock) {
            if (queue.isEmpty()) return
            batch = ArrayList(queue)
            queue.clear()
        }
        try {
            send(url, jsonEncode(batch).toByteArray(Charsets.UTF_8))
        } catch (err: Exception) {
            // re-queue (bounded, drop-oldest) so a transient outage doesn't lose recent events
            synchronized(lock) {
                queue.addAll(0, batch)
                val over = queue.size - maxQueue
                if (over > 0) repeat(over) { queue.removeAt(0) }
            }
            try {
                onError?.invoke(err)
            } catch (_: Exception) {
                // a broken onError callback must not propagate either
            }
        }
    }

    /** Number of events queued but not yet sent. */
    val pending: Int
        get() = synchronized(lock) { queue.size }

    /** Stop the flush timer and send the final batch. Call on shutdown. */
    fun close() {
        running = false
        worker?.interrupt()
        try {
            worker?.join(2000)
        } catch (_: InterruptedException) {
        }
        flush()
    }

    // ---- internals ----

    private fun httpSend(target: String, body: ByteArray) {
        val conn = URI.create(target).toURL().openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { os: OutputStream -> os.write(body) }
            conn.responseCode // force the request to be sent
        } finally {
            conn.disconnect()
        }
    }
}

/** Build a map dropping null values (so optional fields are simply omitted from JSON). */
private fun noNulls(vararg pairs: Pair<String, Any?>): Map<String, Any?> {
    val m = LinkedHashMap<String, Any?>()
    for ((k, v) in pairs) if (v != null) m[k] = v
    return m
}

/**
 * Minimal JSON encoder for Map / Iterable / Array / String / Number / Boolean / null.
 * Strings are escaped per RFC 8259; Korean/emoji pass through as UTF-8 untouched.
 * Non-finite doubles/floats encode as null (JSON has no NaN/Infinity).
 */
internal fun jsonEncode(v: Any?): String = when (v) {
    null -> "null"
    is String -> "\"" + escape(v) + "\""
    is Boolean -> v.toString()
    is Double -> if (v.isFinite()) v.toString() else "null"
    is Float -> if (v.isFinite()) v.toString() else "null"
    is Number -> v.toString()
    is Map<*, *> -> v.entries.joinToString(",", "{", "}") {
        "\"" + escape(it.key.toString()) + "\":" + jsonEncode(it.value)
    }
    is Iterable<*> -> v.joinToString(",", "[", "]") { jsonEncode(it) }
    is Array<*> -> v.joinToString(",", "[", "]") { jsonEncode(it) }
    else -> "\"" + escape(v.toString()) + "\""
}

private fun escape(s: String): String {
    val sb = StringBuilder(s.length + 8)
    for (c in s) when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
    }
    return sb.toString()
}
