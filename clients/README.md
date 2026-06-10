# AgentFlow SDK Guide

에이전트 코드에 드롭인으로 추가해 이벤트를 수집 서버로 전송합니다.  
배칭 + fire-and-forget 구조 — 수집 서버가 다운돼도 에이전트 로직에 예외가 전파되지 않습니다.

```
your agent  ──emit()──▶  in-memory queue  ──batch POST──▶  /ingest  ──WS──▶  web dashboard
```

---

## 설치

파일을 프로젝트에 직접 복사해서 사용합니다. 외부 의존성 없음.

| 언어 | 파일 |
|------|------|
| TypeScript/Node | `ts/agentflow.ts` |
| Python | `python/agentflow_client.py` |
| Rust | `rust/` |
| Kotlin/JVM | `kotlin/AgentFlowClient.kt` |

---

## 7가지 이벤트

| 이벤트 | 의미 |
|--------|------|
| `agent` | 에이전트 온라인/오프라인 |
| `tool` | 도구 호출 시작/종료 |
| `delegate` | 에이전트 간 작업 위임/반환 |
| `blackboard` | 공유 상태 읽기/쓰기 |
| `noti` | 블랙보드 변경 알림 (broadcast/ack) |
| `task` | 사용자 작업 입력/결과 (Hub 전용) |
| `message` | 에이전트 내부 상태 메시지 (Agent 대화 패널에 표시) |

---

## TypeScript / Node

### 초기화

```ts
import { AgentFlowClient } from "./agentflow";

const af = new AgentFlowClient({
  url: "http://collector:3001/ingest",
  agentId: "hub",     // 기본 agentId — 모든 emit에 자동 적용
  space: "default",   // 워크스페이스 (선택)
});
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `url` | — | 수집 서버 엔드포인트 (필수) |
| `agentId` | — | 기본 agentId |
| `space` | — | 워크스페이스 |
| `batchSize` | `20` | 이 개수가 쌓이면 즉시 flush |
| `flushIntervalMs` | `250` | 자동 flush 주기 (ms). `0`이면 비활성화 |
| `maxQueue` | `5000` | 큐 최대 크기 (초과 시 오래된 것 드롭) |
| `fetchImpl` | `globalThis.fetch` | 커스텀 fetch |
| `onError` | — | 전송 실패 콜백 |

### API

#### Agent

```ts
af.agentStart({ role: "orchestrator", label: "HomeHub" });
af.agentEnd();
```

#### Tool

```ts
af.toolStart({ tool: "edit_video", input: { photos: 24 }, taskId: "t-1" });
af.toolEnd({ tool: "edit_video", status: "ok", output: { file: "out.mp4" }, taskId: "t-1" });
```

`status`: `"ok"` | `"error"`

#### Delegate

```ts
af.dispatch({ from: "hub", to: "pc", task: "영상 편집해줘", taskId: "t-1" });
af.return({ from: "pc", to: "hub", payload: { file: "out.mp4" }, taskId: "t-1" });
```

#### Blackboard

```ts
af.bbWrite({ key: "video_result", value: { file: "out.mp4" }, taskId: "t-1" });
af.bbRead({ key: "video_result", taskId: "t-1" });
```

#### Noti (broadcast / ack)

```ts
// Hub가 PC·TV에게 블랙보드 확인 요청
af.broadcast({ from: "hub", to: ["pc", "tv"], key: "task_requirements", message: "확인해줘", taskId: "t-1" });

// PC가 Hub에게 완료 알림
af.ack({ from: "pc", to: "hub", key: "task_requirements", message: "작성 완료", taskId: "t-1" });
```

#### Task (Hub 전용)

```ts
af.taskInput({ request: "가족 사진으로 엄마 생일 영상 만들어줘", scenario: "scenario-1", taskId: "t-1" });
af.taskOutput({ result: { video: "birthday.mp4" }, taskId: "t-1" });
```

#### flush / close

```ts
await af.flush();  // 큐 즉시 전송
await af.close();  // 타이머 중지 + 마지막 flush (종료 시 호출 권장)
af.pending;        // 미전송 이벤트 수
```

### 전체 예시 — HomeHub (Scenario 1)

```ts
const af = new AgentFlowClient({ url: "http://localhost:3001/ingest", agentId: "hub" });

af.agentStart({ role: "orchestrator", label: "HomeHub" });
af.taskInput({ request: "엄마 생일 영상 만들어줘", scenario: "scenario-1", taskId: "t-1" });

af.toolStart({ tool: "discover_agents", taskId: "t-1" });
af.toolEnd({ tool: "discover_agents", status: "ok", taskId: "t-1" });

af.dispatch({ from: "hub", to: "tv", task: "음악 취향 알려줘", taskId: "t-1" });
af.return({ from: "tv", to: "hub", payload: { genre: "K-Pop 발라드" }, taskId: "t-1" });

af.dispatch({ from: "hub", to: "pc", task: "영상 편집해줘", taskId: "t-1" });
af.return({ from: "pc", to: "hub", payload: { file: "birthday.mp4" }, taskId: "t-1" });

af.taskOutput({ result: { video: "birthday.mp4" }, taskId: "t-1" });
await af.close();
```

### 전체 예시 — HomeHub (Scenario 2, Noti 기반 에이전트 탐색)

```ts
const af = new AgentFlowClient({ url: "http://localhost:3001/ingest", agentId: "hub" });

af.taskInput({ request: "영상 만들어줘", scenario: "scenario-2", taskId: "t-2" });

af.toolStart({ tool: "analyze_requirements", taskId: "t-2" });
af.toolEnd({ tool: "analyze_requirements", status: "ok", taskId: "t-2" });

af.bbWrite({ key: "task_requirements", value: { need: ["video_edit", "music"] }, taskId: "t-2" });
af.broadcast({ from: "hub", to: ["pc", "tv"], key: "task_requirements", message: "능력 목록 작성해줘", taskId: "t-2" });

// pc 에이전트 (별도 AgentFlowClient에서 전송)
// af_pc.bbRead({ key: "task_requirements", taskId: "t-2" });
// af_pc.bbWrite({ key: "capabilities_pc", value: { can: ["video_edit"] }, taskId: "t-2" });
// af_pc.ack({ from: "pc", to: "hub", key: "capabilities_pc", taskId: "t-2" });

af.bbRead({ key: "capabilities_pc", taskId: "t-2" });
af.bbRead({ key: "capabilities_tv", taskId: "t-2" });
// ... 이후 Scenario 1과 동일
```

---

## Python

### 초기화

```python
from agentflow_client import AgentFlowClient

af = AgentFlowClient(
    url="http://collector:3001/ingest",
    agent_id="hub",     # 기본 agent_id
    space="default",    # 워크스페이스 (선택)
)
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `url` | — | 수집 서버 엔드포인트 (필수) |
| `agent_id` | `None` | 기본 agent_id |
| `space` | `None` | 워크스페이스 |
| `batch_size` | `20` | 이 개수가 쌓이면 즉시 flush |
| `flush_interval` | `0.25` | 자동 flush 주기 (초) |
| `max_queue` | `5000` | 큐 최대 크기 |
| `timeout` | `0.5` | HTTP 요청 타임아웃 (초) |
| `on_error` | `None` | 전송 실패 콜백 |

### API

#### Agent

```python
af.agent_start(role="orchestrator", label="HomeHub")
af.agent_end()
```

#### Tool

```python
af.tool_start(tool="edit_video", input={"photos": 24}, task_id="t-1")
af.tool_end(tool="edit_video", status="ok", output={"file": "out.mp4"}, task_id="t-1")
```

#### Delegate

```python
af.dispatch(frm="hub", to="pc", task="영상 편집해줘", task_id="t-1")
af.delegate_return(frm="pc", to="hub", payload={"file": "out.mp4"}, task_id="t-1")
```

#### Blackboard

```python
af.bb_write(key="video_result", value={"file": "out.mp4"}, task_id="t-1")
af.bb_read(key="video_result", task_id="t-1")
```

#### Noti

```python
af.broadcast(frm="hub", to=["pc", "tv"], key="task_requirements", message="확인해줘", task_id="t-1")
af.ack(frm="pc", to="hub", key="task_requirements", message="작성 완료", task_id="t-1")
```

#### Task (Hub 전용)

```python
af.task_input(request="엄마 생일 영상 만들어줘", scenario="scenario-1", task_id="t-1")
af.task_output(result={"video": "birthday.mp4"}, task_id="t-1")
```

#### flush / close

```python
af.flush()   # 큐 즉시 전송
af.close()   # 타이머 중지 + 마지막 flush
af.pending   # 미전송 이벤트 수
```

### 전체 예시

```python
from agentflow_client import AgentFlowClient

af = AgentFlowClient(url="http://localhost:3001/ingest", agent_id="hub")

af.agent_start(role="orchestrator", label="HomeHub")
af.task_input(request="엄마 생일 영상 만들어줘", scenario="scenario-1", task_id="t-1")

af.tool_start(tool="discover_agents", task_id="t-1")
af.tool_end(tool="discover_agents", status="ok", task_id="t-1")

af.dispatch(frm="hub", to="tv", task="음악 취향 알려줘", task_id="t-1")
af.delegate_return(frm="tv", to="hub", payload={"genre": "K-Pop 발라드"}, task_id="t-1")

af.dispatch(frm="hub", to="pc", task="영상 편집해줘", task_id="t-1")
af.delegate_return(frm="pc", to="hub", payload={"file": "birthday.mp4"}, task_id="t-1")

af.task_output(result={"video": "birthday.mp4"}, task_id="t-1")
af.close()
```

---

## 이벤트 스키마 레퍼런스

모든 이벤트에 공통으로 포함할 수 있는 필드:

| 필드 | 타입 | 설명 |
|------|------|------|
| `agentId` | string | 이벤트를 발생시킨 에이전트 ID |
| `taskId` | string | 관련 작업 ID |
| `traceId` | string | 분산 추적 ID |
| `space` | string | 워크스페이스 |
| `ts` | number | 타임스탬프 (ms). 생략 시 서버에서 채움 |
| `eventId` | string | 이벤트 고유 ID. 생략 시 서버에서 채움 |

### agent

```json
{ "kind": "agent", "agentId": "hub", "phase": "start", "role": "orchestrator", "label": "HomeHub" }
{ "kind": "agent", "agentId": "hub", "phase": "end" }
```

### tool

```json
{ "kind": "tool", "agentId": "pc", "tool": "edit_video", "phase": "start", "input": { "photos": 24 } }
{ "kind": "tool", "agentId": "pc", "tool": "edit_video", "phase": "end", "status": "ok", "output": { "file": "out.mp4" } }
```

### delegate

```json
{ "kind": "delegate", "agentId": "hub", "phase": "dispatch", "from": "hub", "to": "pc", "task": "영상 편집해줘" }
{ "kind": "delegate", "agentId": "pc",  "phase": "return",   "from": "pc",  "to": "hub", "payload": { "file": "out.mp4" } }
```

### blackboard

```json
{ "kind": "blackboard", "agentId": "tv", "op": "write", "key": "music_preferences", "value": { "genre": "K-Pop" } }
{ "kind": "blackboard", "agentId": "hub", "op": "read",  "key": "music_preferences" }
```

### noti

```json
{ "kind": "noti", "agentId": "hub", "phase": "broadcast", "from": "hub", "to": ["pc","tv"], "key": "task_requirements" }
{ "kind": "noti", "agentId": "pc",  "phase": "ack",       "from": "pc",  "to": "hub",        "key": "task_requirements" }
```

### task

```json
{ "kind": "task", "agentId": "hub", "phase": "input",  "request": "영상 만들어줘", "scenario": "scenario-1", "taskId": "t-1" }
{ "kind": "task", "agentId": "hub", "phase": "output", "result": { "video": "out.mp4" },                       "taskId": "t-1" }
```

### message

에이전트가 지금 무엇을 하고 있는지 대화 형식으로 설명합니다. Agent 대화 패널에 채팅 말풍선으로 표시됩니다.

```json
{ "kind": "message", "agentId": "hub",  "title": "계획 수립 중 🧠",     "content": "TV→음악 취향, PC→영상 편집 순으로 처리할게.", "taskId": "t-1" }
{ "kind": "message", "agentId": "pc",   "title": "영상 편집 시작! ✂️", "content": "사진 28장으로 생일 영상을 만들기 시작할게.", "taskId": "t-1" }
```

---

## Noti 패턴 (Scenario 2)

Hub가 에이전트 능력을 사전에 모를 때 Blackboard + Noti로 능력을 탐색하는 패턴:

```
Hub                     PC                      TV
 │                       │                       │
 ├─bb_write──────────────► task_requirements     │
 ├─broadcast─────────────►──────────────────────►│
 │                       │ bb_read task_req       │
 │                       │ bb_write capabilities_pc
 │                       ├─ack────────────────────►Hub
 │                       │                       │ bb_read task_req
 │                       │                       │ bb_write capabilities_tv
 │                       │                       ├─ack──────────►Hub
 ├─bb_read capabilities_pc                       │
 ├─bb_read capabilities_tv                       │
 │ (이후 Scenario 1과 동일)                       │
```
