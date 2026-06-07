# AgentFlow SDK 가이드

각 디바이스의 에이전트 코드에 **이벤트 emit 몇 줄**만 넣으면, AgentFlow 대시보드에 흐름이 실시간으로 나타납니다. SDK는 4개 언어로 제공됩니다.

| 언어 | 파일 | 의존성 |
|------|------|--------|
| TypeScript/Node | [`ts/agentflow.ts`](ts/agentflow.ts) | 없음 (global `fetch`) |
| Python | [`python/agentflow_client.py`](python/agentflow_client.py) | 없음 (stdlib) |
| Rust | [`rust/`](rust/) | `serde_json`, `ureq` |
| Kotlin/JVM | [`kotlin/AgentFlowClient.kt`](kotlin/AgentFlowClient.kt) | 없음 (JDK) |

네 SDK는 **완전히 동일한 동작**을 합니다. 아래 설명은 모든 언어에 공통이며, 언어별 호출 예시는 맨 아래에 모았습니다.

---

## 1. 동작 원리 (왜 이렇게 만들었나)

```
당신의 코드 ──emit()──▶ [메모리 큐] ──배치로 묶어──▶ POST /ingest ──▶ Collector ──▶ 대시보드
                           ▲                              │
                           └──────  실패 시 재큐  ◀────────┘
```

- **fire-and-forget (실패해도 안 막힘)** — emit은 큐에 넣기만 하고 **즉시 반환**합니다. 네트워크 전송은 백그라운드에서 일어나고, Collector가 죽어 있어도 **예외를 던지지 않고** 당신의 에이전트 로직을 멈추지 않습니다. 관찰(observability)이 본 기능을 방해하면 안 되니까요.
- **배칭(batching)** — 이벤트를 모았다가 한 번에 보냅니다. `batchSize`(기본 20)개가 쌓이거나, `flushInterval`(기본 250ms)마다 전송. 요청 수를 줄여 부하를 낮춥니다.
- **재시도(re-queue)** — 전송 실패 시 그 배치를 큐 앞으로 되돌려 다음 기회에 다시 보냅니다. 단 `maxQueue`(기본 5000)를 넘으면 **오래된 것부터 버립니다** (메모리 폭주 방지).
- **종료 시 flush** — 프로세스 종료 전에 `close()`를 부르면 남은 큐를 마지막으로 보냅니다.

> 즉 당신은 "이런 일이 일어났다"를 알리기만 하면 되고, 모으기·보내기·재시도·정리는 SDK가 알아서 합니다.

---

## 2. 이벤트의 공통 좌표

모든 이벤트에는 **"누가"**를 나타내는 계층 좌표가 붙습니다.

| 필드 | 의미 | 예 |
|------|------|----|
| `space` | **워크스페이스** — 최상위 격리 키 (테스트 세션/사용자) | `"alice"` |
| `deviceId` | 디바이스 | `"device-A"` |
| `teamId` | 팀 | `"alpha"` |
| `agentId` | 행위 주체 에이전트 | `"w1"` |
| `taskId` | **작업(task) 병합 키** — 여러 디바이스가 같은 작업을 묶는 기준 | `"task-42"` |

`space`/`deviceId`/`teamId`는 클라이언트 생성 시 **기본값**으로 지정하면 매 호출에서 생략할 수 있습니다 (호출 시 넘기면 덮어씀). `eventId`·`ts`(타임스탬프)는 생략하면 **서버가 자동으로 채웁니다**. `space`를 안 주면 `"default"`로 들어갑니다.

에이전트의 풀 식별자는 `"device/team/agent"` 형식입니다 (예: `"device-A/alpha/w1"`). 메시지의 `from`/`to`에는 이 풀 식별자를 씁니다.

---

## 3. 동작(operation)별 상세

SDK가 제공하는 동작은 6가지입니다. 각각이 대시보드에서 **무엇으로 보이는지**까지 설명합니다.

### ① `online` / `offline` — 에이전트 등록(presence)

에이전트가 **시작될 때 `online`**, **종료될 때 `offline`**을 호출합니다.

- **왜**: 트래픽이 한 건도 없어도 토폴로지에 노드를 미리 띄우기 위함. 서버는 이걸 받기 전엔 그 에이전트의 존재를 모릅니다.
- **필드**: `agentId`(필수), `role`(`"comm"` | `"leader"` | `"worker"` 등), `team_id`/`device_id`(기본값 없으면).
- **대시보드 효과**: 해당 노드가 **즉시 생성**됩니다. `role`이 `comm`이면 금색 링+`✦`, `leader`면 흰 링+`★`로 표시됩니다. `offline`이면 노드가 **회색**으로 흐려집니다.
- **taskId 없음** — presence는 작업과 무관한 "상태"라서 어떤 task를 봐도 항상 보입니다.

### ② `message` — 에이전트 간 메시지

한 에이전트가 다른 에이전트에게 메시지를 보낼 때 (= 당신의 메시지 서버가 릴레이하는 지점) 호출합니다.

- **필드**: `agentId`(보내는 주체), `from`(풀 id), `to`(풀 id, 또는 `null`=broadcast), `msgType`(예: `"request"`,`"assign"`), `body`(**실제 데이터**), `taskId`, `tool`.
- **대시보드 효과**: `from → to` **직접 엣지**가 그려지고, 그 위에 **`body` 데이터가 라벨**로 잠깐 표시됩니다. 움직이는 점(pulse)으로 흐름이 애니메이션됩니다. 엣지에 마우스를 올리면 전체 payload가 뜹니다.
- `to`는 키가 **항상 존재**해야 합니다(브로드캐스트는 `null`).

### ③ `blackboardWrite` / `blackboardRead` — 공유 저장소 접근

블랙보드(공유 저장소)에 쓰거나 읽을 때 호출합니다.

- **필드**: `agentId`, `key`(블랙보드 id), `value`(쓸 값; write만), `version`, `taskId`.
- **대시보드 효과**: 흐름이 **Blackboard 노드를 거쳐갑니다**.
  - `write`: `agent → [Blackboard]` (노랑) — `value`가 라벨로 표시.
  - `read`: `[Blackboard] → agent` (초록).
  - Blackboard 패널에 key별 현재 값·버전·읽기 횟수가 갱신됩니다.

### ④ `tool` — 도구 사용 (에이전트가 지금 "무엇을 하는지")

에이전트가 도구를 호출(검색·코드 실행·브라우저·"생각" 등)할 때 호출합니다. 메시지 사이에 **그 에이전트가 무엇을 하고 있는지**를 보이게 합니다.

- **필드**: `agentId`, `tool`(도구 이름, 필수), `phase`(`"start"`=작업 시작 | `"end"`=해제, 생략 시 `"start"`), `status`(`"ok"`/`"error"`, end용), `summary`(요약), `taskId`.
- **대시보드 효과**: 해당 노드에 **보라색 회전 링 + `⚙ 도구이름` 라벨**이 떠서 "작업 중"임을 보여줍니다. Live Events엔 `TOOL` 뱃지로 표시되고, Tasks 목록엔 도구 사용 횟수(`nT`)가 붙습니다.
- **busy 상태 유지/해제**: `start` 후 5초가 지나면 자동으로 사라집니다. **도구를 연속 사용하면**(5초 이내 재호출) 링이 계속 켜져 있어 "계속 작업 중"으로 보입니다. 길게 도는 도구는 `start`/`end`로 감싸면 정확히 그 구간만 표시됩니다(`end` 누락돼도 TTL로 self-heal).
- **taskId 권장** — tool 이벤트는 task 상세이므로, 해당 task를 클릭(focus)했을 때 보입니다.

### ⑤ `emit` — 저수준(low-level)

위 헬퍼로 표현 안 되는 이벤트를 직접 넣고 싶을 때 쓰는 원시 API입니다. `kind`·필수 필드를 직접 채운 객체/맵을 넘깁니다. 보통은 ①~④로 충분합니다.

### ⑥ `flush` / `close`

- `flush()` — 지금 큐에 있는 것을 **즉시 전송**합니다. (평소엔 자동이라 거의 안 부름)
- `close()` — 백그라운드 타이머를 멈추고 마지막으로 flush합니다. **프로세스 종료 직전에 반드시 호출**하세요(안 그러면 마지막 배치가 유실될 수 있음).

---

## 4. `taskId`와 확장성 — 가장 중요한 개념

`taskId`는 **여러 디바이스에 흩어진 이벤트를 하나의 작업으로 묶는 병합 키**입니다.

- device-A의 에이전트가 작업을 시작하며 `taskId="task-42"`를 붙이고, 그 작업이 device-B로 넘어갈 때(comm 에이전트끼리 통신) **같은 `task-42`**를 실으면, 대시보드는 두 디바이스의 흐름을 **하나의 task로 합쳐서** 보여줍니다.
- 대시보드는 기본적으로 **task 목록(요약)만** 가볍게 받고, 사용자가 **task 하나를 클릭하면 그 task의 상세 흐름만** 구독합니다. 덕분에 **task가 아무리 많아져도 브라우저 부하는 "선택한 1개 task + 요약 목록"으로 상한이 고정**됩니다.

→ 그래서 흐름을 일으키는 모든 `message`/`blackboard` 이벤트에는 **가능하면 `taskId`를 넣어주세요.** 그래야 task 단위로 보고 확장성도 확보됩니다. (presence인 `online`/`offline`엔 불필요)

---

## 4-b. `space` — 동시 테스트를 격리하는 워크스페이스

여러 사람이 **동시에** 여러 디바이스로 테스트하면 서로의 에이전트·task가 한 화면에 섞입니다. `space`는 이를 막는 **최상위 격리 키**입니다.

- 클라이언트 생성 시 `space`를 지정하면, 그 클라이언트가 보내는 **모든 이벤트가 해당 워크스페이스에만** 들어갑니다. 서버는 presence·task·흐름을 **space별로 완전히 분리**합니다.
- 대시보드는 워크스페이스 단위로 봅니다: URL `?space=alice` (격리된 페이지) 또는 상단 **workspace 드롭다운**에서 선택. 한 워크스페이스에선 다른 워크스페이스의 것이 절대 안 보입니다.
- **왜 device가 아니라 space로 나누나**: task가 디바이스를 횡단하므로(device-A→device-B), 격리 경계는 device보다 **위**여야 합니다. `space`엔 보통 **사용자명·테스트 세션 id**를 넣습니다.
- 안 주면 `"default"` — 혼자 쓸 땐 신경 쓸 필요 없습니다.

```ts
// 예: 테스터 alice 의 세션
const af = new AgentFlowClient({ url, space: "alice", deviceId: "device-A", teamId: "alpha" });
```
> 같은 작업을 여러 디바이스/프로세스가 나눠 처리해도 **`space`만 같으면 한 워크스페이스로 합쳐집니다** (그 안에서 `taskId`로 다시 task 단위 병합).

---

## 5. 어디에 emit을 넣나 (연동 위치)

| 당신 코드의 위치 | 호출할 동작 |
|------------------|-------------|
| 에이전트 부팅 / 종료 | `online()` / `offline()` |
| 메시지 서버가 메시지를 **릴레이하는 지점** | `message()` |
| 블랙보드에 **쓰는 지점** | `blackboardWrite()` |
| 블랙보드에서 **읽는 지점** | `blackboardRead()` |
| 에이전트가 **도구를 호출하는 지점** | `tool()` |
| 새 작업을 시작할 때 | 그 작업의 `taskId`를 만들어 이후 모든 이벤트에 전달 |

---

## 6. 언어별 사용법 (동일 시나리오)

> 시나리오: device-A/alpha의 워커 `w1`이 작업 `t-1`을 시작 → 팀 통솔자 `lead`에게 요청 → lead가 블랙보드에 계획 작성 → w1이 계획을 읽음.

### TypeScript / Node
```ts
import { AgentFlowClient } from "./ts/agentflow";
const af = new AgentFlowClient({ url: "http://collector:3001/ingest", deviceId: "device-A", teamId: "alpha" });

af.online({ agentId: "lead", role: "comm" });
af.online({ agentId: "w1", role: "worker" });

af.message({ agentId: "w1", from: "device-A/alpha/w1", to: "device-A/alpha/lead",
             msgType: "request", taskId: "t-1", body: { task: "rank items" } });
af.blackboardWrite({ agentId: "lead", key: "bb:alpha:plan", value: { steps: 3 }, taskId: "t-1" });
af.blackboardRead({ agentId: "w1", key: "bb:alpha:plan", taskId: "t-1" });
af.tool({ agentId: "w1", tool: "search", phase: "start", taskId: "t-1" });

await af.close(); // 종료 시
```

### Python
```python
from python.agentflow_client import AgentFlowClient
af = AgentFlowClient(url="http://collector:3001/ingest", device_id="device-A", team_id="alpha")

af.online(agent_id="lead", role="comm")
af.online(agent_id="w1", role="worker")

af.message(agent_id="w1", frm="device-A/alpha/w1", to="device-A/alpha/lead",
           msg_type="request", task_id="t-1", body={"task": "rank items"})
af.blackboard_write(agent_id="lead", key="bb:alpha:plan", value={"steps": 3}, task_id="t-1")
af.blackboard_read(agent_id="w1", key="bb:alpha:plan", task_id="t-1")

af.tool(agent_id="w1", tool="search", phase="start", task_id="t-1")  # w1 "작업 중"
af.tool(agent_id="w1", tool="search", phase="end", status="ok", task_id="t-1")

af.close()
```

> **바로 돌려보기 (tool 사용 데모):** 콜렉터가 떠 있는 상태에서
> `python3 clients/python/demo_tool.py` — 워커 `w1`이 도구를 연속 사용하는 시나리오를
> 보냅니다. 웹 UI에서 해당 task를 클릭하면 `w1` 노드에 보라색 회전 링 + `⚙ 도구이름`이
> 켜지는 걸 볼 수 있습니다. (`INGEST_URL`, `SPACE` 환경변수로 대상 변경 가능)

### Rust
```rust
use agentflow_client::{AgentFlowClient, Options, Message, Blackboard, Agent, Tool};
use serde_json::json;

let af = AgentFlowClient::new(
    Options::new("http://collector:3001/ingest").device_id("device-A").team_id("alpha"),
);
af.online(Agent { agent_id: "lead", role: Some("comm"), ..Default::default() });
af.online(Agent { agent_id: "w1", role: Some("worker"), ..Default::default() });

af.message(Message { agent_id: "w1", from: "device-A/alpha/w1", to: Some("device-A/alpha/lead"),
    msg_type: Some("request"), task_id: Some("t-1"), body: Some(json!({"task": "rank items"})), ..Default::default() });
af.blackboard_write(Blackboard { agent_id: "lead", key: "bb:alpha:plan",
    value: Some(json!({"steps": 3})), task_id: Some("t-1"), ..Default::default() });
af.blackboard_read(Blackboard { agent_id: "w1", key: "bb:alpha:plan", task_id: Some("t-1"), ..Default::default() });
af.tool(Tool { agent_id: "w1", tool: "search", phase: Some("start"), task_id: Some("t-1"), ..Default::default() });

af.close(); // 종료 시 (Drop 시에도 자동 flush)
```
빌드/실행: `cd clients/rust && cargo run --example demo`

### Kotlin / JVM
```kotlin
import agentflow.AgentFlowClient
val af = AgentFlowClient("http://collector:3001/ingest", deviceId = "device-A", teamId = "alpha")

af.online(agentId = "lead", role = "comm")
af.online(agentId = "w1", role = "worker")

af.message(agentId = "w1", from = "device-A/alpha/w1", to = "device-A/alpha/lead",
           msgType = "request", taskId = "t-1", body = mapOf("task" to "rank items"))
af.blackboardWrite(agentId = "lead", key = "bb:alpha:plan", value = mapOf("steps" to 3), taskId = "t-1")
af.blackboardRead(agentId = "w1", key = "bb:alpha:plan", taskId = "t-1")
af.tool(agentId = "w1", tool = "search", phase = "start", taskId = "t-1")

af.close() // 종료 시
```
빌드/실행: `kotlinc AgentFlowClient.kt Demo.kt -include-runtime -d demo.jar && java -jar demo.jar`

---

## 7. 옵션 정리

| 옵션 | 기본값 | 의미 |
|------|--------|------|
| `url` | — | 수집 endpoint |
| `space` | `"default"` | 워크스페이스(격리 키). 모든 이벤트에 부착 |
| `deviceId` / `teamId` | — | 기본 디바이스/팀 |
| `batchSize` | 20 | 이 개수가 쌓이면 즉시 전송 |
| `flushInterval` | 250ms | 주기적 자동 전송 간격 (0이면 수동 flush만) |
| `maxQueue` | 5000 | 큐 상한. 넘으면 오래된 것부터 폐기 |
| `timeout` | 500ms | 전송 요청 타임아웃 |

---

## 8. 한눈에 보는 흐름

```
[에이전트 시작]  online(role)                      → 노드 생성
   │
   ├ message(from,to,body,taskId)                  → from→to 엣지 + 데이터 라벨
   ├ blackboardWrite(key,value,taskId)             → agent→Blackboard (노랑)
   ├ blackboardRead(key,taskId)                    → Blackboard→agent (초록)
   ├ tool(tool,phase,taskId)                       → 노드에 ⚙ 도구 라벨 + 보라색 작업 링
   │     … 모두 같은 taskId면 대시보드에서 한 task로 merge, 디바이스 넘나들어도 합쳐짐
   │
[에이전트 종료]  offline() → close()                → 노드 회색 + 남은 큐 flush
```
