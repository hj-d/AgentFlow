package agentflow

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * AgentFlow client SDK for Kotlin/JVM — batched, fire-and-forget, **zero external deps**
 * (JDK HttpURLConnection + a tiny JSON encoder). Drop this file into your project.
 *
 * Add emit calls at your message-server relay point, blackboard read/write, and at
 * agent start/stop. Events are queued and flushed from a background daemon thread;
 * a collector outage never throws into your agent logic.
 *
 * ```
 * val af = AgentFlowClient("http://collector:3001/ingest", deviceId = "edge-1", teamId = "planner")
 * af.online(agentId = "a1", role = "leader")
 * af.message(agentId = "a1", from = "a1", to = "a2", msgType = "task", taskId = "t-1", body = mapOf("n" to 1))
 * af.blackboardWrite(agentId = "a1", key = "bb:plan", value = mapOf("step" to 2), taskId = "t-1")
 * af.blackboardRead(agentId = "a2", key = "bb:plan", taskId = "t-1")
 * af.tool(agentId = "a2", tool = "search", phase = "start", taskId = "t-1")
 * af.offline(agentId = "a1")
 * af.close()  // flush + stop on shutdown
 * ```
 */
class AgentFlowClient(
    private val url: String,
    private val space: String? = null,
    private val deviceId: String? = null,
    private val teamId: String? = null,
    private val batchSize: Int = 20,
    private val flushIntervalMs: Long = 250,
    private val maxQueue: Int = 5000,
    private val timeoutMs: Int = 500,
) {
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

    // ---- public API ----

    /** Low-level: enqueue any event map. Never blocks on the network. */
    fun emit(event: Map<String, Any?>) {
        val e = HashMap(event)
        if (e["space"] == null && space != null) e["space"] = space
        if (e["deviceId"] == null && deviceId != null) e["deviceId"] = deviceId
        if (e["teamId"] == null && teamId != null) e["teamId"] = teamId
        var full = false
        synchronized(lock) {
            queue.add(e)
            val over = queue.size - maxQueue
            if (over > 0) repeat(over) { queue.removeAt(0) }
            full = queue.size >= batchSize
        }
        if (full) flush()
    }

    /** Announce an agent has started — call once on startup so it shows up immediately. */
    fun online(agentId: String, teamId: String? = null, deviceId: String? = null, role: String? = null) =
        emit(noNulls("kind" to "agent", "status" to "online", "agentId" to agentId,
            "teamId" to teamId, "deviceId" to deviceId, "role" to role))

    /** Announce an agent has stopped. */
    fun offline(agentId: String, teamId: String? = null, deviceId: String? = null) =
        emit(noNulls("kind" to "agent", "status" to "offline", "agentId" to agentId,
            "teamId" to teamId, "deviceId" to deviceId))

    /** A message relayed between agents (shown as a direct edge carrying [body]). */
    fun message(
        agentId: String,
        from: String,
        to: String?,
        teamId: String? = null,
        deviceId: String? = null,
        op: String = "send",
        msgType: String? = null,
        body: Any? = null,
        taskId: String? = null,
        traceId: String? = null,
        tool: String? = null,
    ) {
        // 'to' must always be present (null = broadcast), so it bypasses noNulls
        val e = noNulls("kind" to "message", "op" to op, "agentId" to agentId, "from" to from,
            "teamId" to teamId, "deviceId" to deviceId, "msgType" to msgType, "body" to body,
            "taskId" to taskId, "traceId" to traceId, "tool" to tool).toMutableMap()
        e["to"] = to
        emit(e)
    }

    /** Write to the blackboard (agent → Blackboard node, carrying [value]). */
    fun blackboardWrite(
        agentId: String, key: String, value: Any? = null,
        teamId: String? = null, deviceId: String? = null,
        version: Int? = null, taskId: String? = null, traceId: String? = null,
    ) = emit(noNulls("kind" to "blackboard", "op" to "write", "agentId" to agentId, "key" to key,
        "value" to value, "version" to version, "teamId" to teamId, "deviceId" to deviceId,
        "taskId" to taskId, "traceId" to traceId))

    /** Read from the blackboard (Blackboard node → agent). */
    fun blackboardRead(
        agentId: String, key: String,
        teamId: String? = null, deviceId: String? = null,
        taskId: String? = null, traceId: String? = null,
    ) = emit(noNulls("kind" to "blackboard", "op" to "read", "agentId" to agentId, "key" to key,
        "teamId" to teamId, "deviceId" to deviceId, "taskId" to taskId, "traceId" to traceId))

    /**
     * Record a tool invocation (shown as a busy ring + ⚙ label on the agent node).
     * Bracket long-running tools with [phase] "start"/"end"; a single call (default
     * "start") suffices for a quick tool — the busy state expires on its own.
     */
    fun tool(
        agentId: String,
        tool: String,
        phase: String? = null,
        status: String? = null,
        summary: String? = null,
        teamId: String? = null,
        deviceId: String? = null,
        taskId: String? = null,
        traceId: String? = null,
    ) = emit(noNulls("kind" to "tool", "agentId" to agentId, "tool" to tool,
        "phase" to phase, "status" to status, "summary" to summary,
        "teamId" to teamId, "deviceId" to deviceId, "taskId" to taskId, "traceId" to traceId))

    /** Send everything queued now (also runs on the background timer). */
    fun flush() {
        val batch: List<Map<String, Any?>>
        synchronized(lock) {
            if (queue.isEmpty()) return
            batch = ArrayList(queue)
            queue.clear()
        }
        try {
            post(jsonEncode(batch))
        } catch (_: Exception) {
            // re-queue (bounded) so a transient outage doesn't lose recent events
            synchronized(lock) {
                queue.addAll(0, batch)
                val over = queue.size - maxQueue
                if (over > 0) repeat(over) { queue.removeAt(0) }
            }
        }
    }

    val pending: Int
        get() = synchronized(lock) { queue.size }

    /** Flush and stop the timer. Call on shutdown. */
    fun close() {
        running = false
        worker?.interrupt()
        worker?.join(2000)
        flush()
    }

    // ---- internals ----
    private fun post(body: String) {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { os: OutputStream -> os.write(body.toByteArray(Charsets.UTF_8)) }
        conn.responseCode // force the request to be sent
        conn.disconnect()
    }
}

/** Build a map dropping null values (so optional fields are simply omitted). */
private fun noNulls(vararg pairs: Pair<String, Any?>): Map<String, Any?> =
    pairs.filter { it.second != null }.toMap()

/** Minimal JSON encoder for Map / List / String / Number / Boolean / null. */
internal fun jsonEncode(v: Any?): String = when (v) {
    null -> "null"
    is String -> "\"" + escape(v) + "\""
    is Boolean -> v.toString()
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
