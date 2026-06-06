# AgentFlow

여러 **Device → Team → Agent** 계층에서, Agent들이 **메시지 서버(릴레이)** 와 **블랙보드(공유 저장소)** 를 통해 주고받는 통신 흐름을 **실시간 웹 대시보드**로 시각화하는 관찰(observability) 레이어.

- **관찰 전용**: 기존 에이전트/통신 시스템은 수정하지 않음. 이벤트를 *읽어서* 보여줌.
- **라이브 전용**: DB 없음. 최근 N개만 인메모리 보관(늦게 접속한 클라이언트 스냅샷용).
- **실시간**: `POST /ingest` → WebSocket fanout (1초 이내 즉시 반영).

```
Devices ──(POST /ingest)──▶  server(:3001)  ──(WebSocket /ws)──▶  web(:8080)
 message server / blackboard       │                                토폴로지 / 라이브 피드 / 블랙보드
                            in-memory ring buffer
```

## 실행

### Docker (배포)

```bash
docker compose up --build           # web:8080, server:3001
docker compose --profile demo up    # + 데모 트래픽 시뮬레이터
```

브라우저에서 http://localhost:8080

### 로컬 개발

```bash
# 터미널 1 — 수집 서버
cd server && npm install && npm run dev

# 터미널 2 — 웹
cd web && npm install && npm run dev      # http://localhost:8080

# 터미널 3 — (선택) 데모 트래픽
cd server && npm run sim
```

> 데모 트래픽은 눈으로 따라가기 쉽게 **천천히** 흐른다. 속도/양은 환경변수로 조절:
> `SIM_INTERVAL_MS`(스텝 간격, 기본 1500) · `SIM_MAX_ACTIVE`(동시 task, 기본 2) · `SIM_SPAWN_PROB`(생성 확률, 기본 0.25) · `SPACES`(워크스페이스 목록).

## 포트

| 서비스 | 포트 |
|--------|------|
| web (대시보드) | `8080` |
| server (수집/WS) | `3001` |

웹은 기본적으로 `ws://<현재호스트>:3001/ws` 로 접속한다. 다른 위치라면 `index.html`에서
`window.__AGENTFLOW_WS__ = "ws://host:3001/ws"` 로 덮어쓸 수 있다.

## 내 시스템 연동하기

각 디바이스의 **메시지 서버**와 **블랙보드** 코드에 이벤트 emit 한 줄만 추가하면 된다.
서버는 `eventId`/`ts`가 없으면 자동으로 채운다. `traceId`/`correlationId`는 흐름을
한 줄기로 잇는 데 쓰이니 가지고 있는 값을 넣어주는 것이 좋다.

드롭인 SDK가 4개 언어로 준비돼 있다 (배칭 + fire-and-forget). 각 동작의 자세한 설명·언어별 예제는 **[SDK 가이드: `clients/README.md`](clients/README.md)** 참고:

- **TypeScript/Node**: [`clients/ts/agentflow.ts`](clients/ts/agentflow.ts)
- **Python**: [`clients/python/agentflow_client.py`](clients/python/agentflow_client.py)
- **Rust**: [`clients/rust/`](clients/rust/)
- **Kotlin/JVM**: [`clients/kotlin/AgentFlowClient.kt`](clients/kotlin/AgentFlowClient.kt)

```ts
import { AgentFlowClient } from "./clients/ts/agentflow";
const af = new AgentFlowClient({ url: "http://collector:3001/ingest", deviceId: "edge-1" });

// 1) 에이전트 시작 시 등록 → 트래픽 전에 토폴로지에 바로 표시됨
af.online({ teamId, agentId, role: "planner" });

// 2) 메시지 릴레이 지점에서  (sender → [Message Server] → recipient 로 시각화)
af.message({ teamId, agentId: from, from, to, msgType, traceId, body });
// 3) 블랙보드 write / read 지점에서  ([Blackboard] 노드를 거쳐 시각화)
af.blackboardWrite({ teamId, agentId, key, value, traceId });
af.blackboardRead({ teamId, agentId, key, traceId });

// 4) 에이전트 종료 시
af.offline({ teamId, agentId });
await af.close(); // 종료 시 flush
```

```python
from agentflow_client import AgentFlowClient
af = AgentFlowClient(url="http://collector:3001/ingest", device_id="edge-1")
af.message(team_id=team, agent_id=src, frm=src, to=dst, msg_type="task", trace_id=tid, body={"x": 1})
af.blackboard_write(team_id=team, agent_id=a, key=k, value=v, trace_id=tid)
af.blackboard_read(team_id=team, agent_id=a, key=k, trace_id=tid)
af.close()
```

SDK 없이 직접 POST 하려면 아래 스키마대로 보내면 된다.

### 이벤트 스키마 (`server/src/types.ts`)

```ts
// 에이전트 라이프사이클 (시작/종료 시) — 토폴로지에 노드 생성/표시
{
  kind: "agent",
  deviceId, teamId, agentId,
  status: "online" | "offline",
  role?, capabilities?, traceId?
}

// 메시지 (릴레이 송신/전달)
{
  kind: "message",
  deviceId, teamId, agentId,        // 보내는 주체
  from: "device/team/agent",
  to:   "device/team/agent" | topic | null,   // null = broadcast. 키는 항상 존재해야 함
  op: "send" | "deliver",
  msgType?, tool?, traceId?, correlationId?,
  body?: <실제 페이로드>             // UI에 그대로 표시됨
}

// 블랙보드 (id로 write / read)
{
  kind: "blackboard",
  deviceId, teamId, agentId,
  op: "write" | "read" | "update" | "delete",
  key: "<블랙보드 id>",
  value?: <저장/조회 값>, version?, traceId?
}
```

### 예시 (JS) — 메시지 서버 릴레이 지점

```js
async function emit(event) {
  try {
    await fetch("http://<collector-host>:3001/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch {} // 관찰 실패가 본 로직을 막지 않도록 무시
}

// 메시지를 relay 할 때
emit({ kind: "message", deviceId, teamId, agentId: from,
       from, to, op: "send", msgType, traceId, body });

// 블랙보드 write/read 시
emit({ kind: "blackboard", deviceId, teamId, agentId,
       op: "write", key, value, traceId });
```

### 예시 (Python)

```python
import requests
def emit(event):
    try:
        requests.post("http://<collector-host>:3001/ingest", json=event, timeout=0.5)
    except Exception:
        pass
```

> 배열로 한 번에 여러 이벤트를 보내도 된다: `POST /ingest` body = `[event, event, ...]`.

## UI 구성

- **Topology**: 상단 중앙에 공유 인프라 백본 노드 **Blackboard**. 아래로 Device(큰 박스) → Team(점선 박스) → Agent(원).
  - 에이전트는 `online` 이벤트로 **시작 시 바로 생성**되고, `offline`이면 회색으로 표시. `comm`(금색 링 · ✦) / `leader`(흰 링 · ★) 역할이 강조됨.
  - 메시지는 sender → recipient **직접 엣지**(움직이는 점 + 최근 데이터 라벨), 블랙보드 write는 agent → **Blackboard**, read는 **Blackboard** → agent 흐름으로 애니메이션.
- **Tasks**: 현재 워크스페이스의 task 요약 목록(메시지/블랙보드 수, device 수, 갱신 시각). 클릭하면 그 **task의 흐름만** Topology·Live Events에 표시. 각 행의 ✕로 task를 삭제하고, 헤더의 **전체 삭제**로 워크스페이스의 task를 한 번에 비움.
- **Live Events**: **선택한 task의 이벤트만** 시간순 스트림(메시지/블랙보드 payload 포함). task 미선택 시 안내만 표시.
- **Blackboard**: 현재 key별 값/버전/읽기 횟수/갱신 시각.
- **상단바**: 워크스페이스 드롭다운(전환·생성·🗑 삭제), 연결 상태, 초당 이벤트율, 일시정지(스냅샷), 선택 task 해제.
- **필터바**: device / team / kind / 페이로드 검색 + 엣지 데이터 라벨 토글.

## 구조

```
server/    Node + TS. /ingest 수집, 링버퍼, WebSocket fanout, 시뮬레이터.
web/       React + Vite + TS + Zustand. 커스텀 SVG 토폴로지, 패널들.
clients/   드롭인 SDK (ts/, python/, rust/, kotlin/) + 가이드(README.md).
```

## 테스트

```bash
cd server && npm test                       # 63 tests (ringbuffer/ingest/hub/tasks/spaces/delete/통합)
cd web && npm test                          # 44 tests (store 로직: 라이프사이클·라우팅·task/space 삭제)
cd clients/python && python3 -m unittest    # 12 tests (Python SDK)
```

## 확장 여지 (필요 시)

- 이벤트율이 매우 높아지면: 서버측 필터 구독, 집계/샘플링(백프레셔).
- 흐름 재생/이력: 라이브 전용 대신 Redis Streams/시계열 저장 추가.
- trace ID가 없는 경우: 휴리스틱 연결 또는 경량 계측(SDK 훅).
