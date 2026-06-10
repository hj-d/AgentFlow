# AgentFlow

**HomeHub · PC · TV** 세 에이전트가 협력해 작업을 처리하는 흐름을 **실시간 웹 대시보드**로 시각화하는 관찰(observability) 레이어.

- **관찰 전용**: 기존 에이전트 코드를 수정하지 않고, 이벤트만 수집해서 보여줌.
- **라이브 전용**: DB 없음. 최근 N개만 인메모리 보관.
- **실시간**: `POST /ingest` → WebSocket fanout (1초 이내 반영).

```
Agents ──(POST /ingest)──▶  server(:3001)  ──(WebSocket /ws)──▶  web(:8080)
  hub / pc / tv                  │                              3-panel dashboard
                         in-memory ring buffer
```

---

## 데모 시나리오

두 시나리오가 번갈아 실행됩니다.

**Scenario 1 — Hub가 능력을 알고 있는 경우**
```
[Task Input]  사용자 → Hub: "가족 사진으로 엄마 생일파티 영상 만들어줘"
[Tool]        Hub: discover_agents → PC·TV 능력 확인
[Tool]        Hub: analyze_and_plan → 계획 수립
[Delegate]    Hub → TV: "선호 음악 정보 알려줘"
  [Tool]      TV: get_music_preferences
  [BB Write]  TV: music_preferences
[Delegate]    Hub → PC: "사진으로 생일 영상 편집해줘"
  [Tool]      PC: select_photos → edit_video
  [BB Write]  PC: selected_photos, video_result
[Task Output] Hub → 사용자: { video: "birthday_mom_2024.mp4" }
```

**Scenario 2 — Hub가 에이전트 능력을 모르는 경우**
```
[Task Input]  사용자 → Hub
[Tool]        Hub: analyze_requirements
[BB Write]    Hub: task_requirements  ← 필요 능력 목록 기록
[Noti broadcast] Hub → PC·TV: "task_requirements 확인해"
  [BB Read]   PC/TV: task_requirements 읽기
  [BB Write]  PC: capabilities_pc  /  TV: capabilities_tv
  [Noti ack]  PC → Hub: "작성 완료"  /  TV → Hub: "작성 완료"
[BB Read]     Hub: capabilities_pc, capabilities_tv
[Tool]        Hub: create_plan → 계획 수립
              ↓ 이후 Scenario 1과 동일
[Task Output] Hub → 사용자
```

---

## 실행

### Docker (권장)

```bash
docker compose up --build           # web:8080, server:3001
docker compose --profile demo up    # + 시뮬레이터 포함
```

브라우저에서 http://localhost:8080

### 로컬 개발

```bash
# 터미널 1 — 수집 서버
cd server && npm install && npm run dev

# 터미널 2 — 웹 대시보드
cd web && npm install && npm run dev      # http://localhost:8080

# 터미널 3 — 데모 트래픽 (선택)
cd server && npm run sim
```

> 시뮬레이터 속도 조절: `SIM_INTERVAL_MS`(스텝 간격, 기본 1800ms) · `SPACES`(워크스페이스)

---

## 포트

| 서비스 | 포트 |
|--------|------|
| web (대시보드) | `8080` |
| server (수집/WS) | `3001` |

---

## 이벤트 스키마

6가지 이벤트를 `POST /ingest` 로 전송합니다. `eventId`·`ts`는 생략 시 서버가 자동 채웁니다.

### Agent — 에이전트 생존 주기

```json
{
  "kind": "agent",
  "agentId": "hub",
  "phase": "start",
  "role": "orchestrator",
  "label": "HomeHub"
}
```

| `phase` | 의미 |
|---------|------|
| `"start"` | 에이전트 온라인 — 토폴로지에 카드 생성 |
| `"end"` | 에이전트 오프라인 — 카드 흐리게 |

### Tool — 도구 호출

```json
{
  "kind": "tool",
  "agentId": "pc",
  "tool": "edit_video",
  "phase": "start",
  "input": { "photos": 24, "music": "K-Pop 발라드" },
  "taskId": "task-1"
}
```

`phase: "start"` → 디바이스 카드에 ⚙ 도구이름 + 작업 중 표시. `phase: "end"` → 해제.

### Delegate — 에이전트 간 위임

```json
{
  "kind": "delegate",
  "agentId": "hub",
  "phase": "dispatch",
  "from": "hub",
  "to": "pc",
  "task": "엄마 생일 영상 편집해줘",
  "taskId": "task-1"
}
```

| `phase` | 의미 |
|---------|------|
| `"dispatch"` | 작업 위임 — 왼쪽 Delegate Log에 → 버블 |
| `"return"` | 결과 반환 — 왼쪽 Delegate Log에 ← 버블 |

### Blackboard — 공유 상태 읽기/쓰기

```json
{
  "kind": "blackboard",
  "agentId": "tv",
  "op": "write",
  "key": "music_preferences",
  "value": { "genre": "K-Pop 발라드" },
  "taskId": "task-1"
}
```

### Noti — 블랙보드 변경 알림

```json
{
  "kind": "noti",
  "agentId": "hub",
  "phase": "broadcast",
  "from": "hub",
  "to": ["pc", "tv"],
  "key": "task_requirements",
  "message": "새 작업 요청 확인해",
  "taskId": "task-1"
}
```

| `phase` | 의미 |
|---------|------|
| `"broadcast"` | Hub → 에이전트들: "블랙보드 확인해" |
| `"ack"` | 에이전트 → Hub: "확인 완료" |

### Task — 사용자 작업 진입/결과 (Hub 전용)

```json
{
  "kind": "task",
  "agentId": "hub",
  "phase": "input",
  "request": "가족 사진으로 엄마 생일파티 영상 만들어줘",
  "scenario": "scenario-1",
  "taskId": "task-1"
}
```

---

## SDK 연동

드롭인 SDK가 준비돼 있습니다 (배칭 + fire-and-forget). 상세 가이드: **[clients/README.md](clients/README.md)**

| 언어 | 파일 |
|------|------|
| TypeScript/Node | [`clients/ts/agentflow.ts`](clients/ts/agentflow.ts) |
| Python | [`clients/python/agentflow_client.py`](clients/python/agentflow_client.py) |
| Rust | [`clients/rust/`](clients/rust/) |
| Kotlin/JVM | [`clients/kotlin/AgentFlowClient.kt`](clients/kotlin/AgentFlowClient.kt) |

```ts
import { AgentFlowClient } from "./clients/ts/agentflow";
const af = new AgentFlowClient({ url: "http://collector:3001/ingest", agentId: "hub" });

af.agentStart({ role: "orchestrator", label: "HomeHub" });
af.taskInput({ request: "영상 만들어줘", taskId: "t-1", scenario: "scenario-1" });
af.dispatch({ from: "hub", to: "pc", task: "사진으로 영상 편집해줘", taskId: "t-1" });
af.toolStart({ tool: "edit_video", taskId: "t-1" });
af.toolEnd({ tool: "edit_video", status: "ok", output: { file: "out.mp4" }, taskId: "t-1" });
af.bbWrite({ key: "video_result", value: { file: "out.mp4" }, taskId: "t-1" });
af.taskOutput({ result: { video: "out.mp4" }, taskId: "t-1" });
await af.close();
```

```python
from agentflow_client import AgentFlowClient
af = AgentFlowClient(url="http://collector:3001/ingest", agent_id="hub")

af.agent_start(role="orchestrator", label="HomeHub")
af.task_input(request="영상 만들어줘", task_id="t-1", scenario="scenario-1")
af.dispatch(frm="hub", to="pc", task="사진으로 영상 편집해줘", task_id="t-1")
af.tool_start(tool="edit_video", task_id="t-1")
af.tool_end(tool="edit_video", status="ok", output={"file": "out.mp4"}, task_id="t-1")
af.bb_write(key="video_result", value={"file": "out.mp4"}, task_id="t-1")
af.task_output(result={"video": "out.mp4"}, task_id="t-1")
af.close()
```

---

## UI 구성

```
┌──────────────┬──────────────────────────┬──────────────────┐
│              │                          │                  │
│  Delegate    │   🖥️ PC  ←──→  📡 Hub   │  Blackboard      │
│  Log         │          ←──→  📺 TV    │  Notifications   │
│              │                          │  Events / Tasks  │
│  (위임 내역  │  디바이스 카드 + 연결선  │                  │
│   채팅 버블) │  펄스 애니메이션         │  Task I/O 배너   │
│              │                          │                  │
└──────────────┴──────────────────────────┴──────────────────┘
```

- **Delegate Log** (왼쪽): Hub↔PC·TV 간 dispatch/return을 채팅 버블 스타일로 표시.
- **Network** (중앙): 3개 디바이스 카드 (🖥️PC · 📡Hub · 📺TV). 현재 사용 중인 툴, 온라인/오프라인 상태, 연결선 펄스 애니메이션.
- **Info Panel** (오른쪽): Blackboard 키/값 · Noti 내역 · Event 스트림 · Task 목록 탭. 상단에 현재 Task Input/Output 배너.

---

## 구조

```
server/    Node + TS. /ingest 수집, 링버퍼, WebSocket fanout, 시뮬레이터.
web/       React + Vite + TS + Zustand. 3-panel 대시보드.
clients/   드롭인 SDK (ts/, python/, rust/, kotlin/) + 가이드.
```

---

## 테스트

```bash
cd server && npm test          # 서버 유닛/통합 테스트
cd web && npm test             # 웹 store 로직 테스트
cd clients/python && python3 -m unittest   # Python SDK 테스트
```
