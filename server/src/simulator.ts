// Simulator — HomeHub orchestration demo.
//
// Agents:
//   hub     🏠 HomeHub   Orchestrator + family photo/video storage
//   pc      💻 PC Agent   Content creation, video editing, music library
//   tv      📺 TV Agent   Content preferences, family music favorites
//   mobile  📱 Mobile     Family notifications, presence
//   speaker 🔈 Speaker    Living-room audio (generic/common device)
//
// Scenario 1 — Hub discovers capabilities via tool, then delegates work.
// Scenario 2 — Hub uses Blackboard+Noti first (parallel PC·TV), then delegates.
// Scenario 3 — Movie night: TV + Speaker + Mobile (dynamic multi-device fan-out).

import { makeEventId } from "./id.js";
import type { FlowEventInput } from "./types.js";

const INGEST_URL = process.env.INGEST_URL ?? "http://localhost:3001/ingest";
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS ?? 3000);
const SPACES = (process.env.SPACES ?? "demo").split(",").map((s) => s.trim()).filter(Boolean);

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function ts(): number { return Date.now(); }
function eid(): string { return makeEventId(ts()); }

// ---- event factory helpers ----
function agentEv(agentId: string, phase: "start" | "end", role: string, label: string, space: string, taskId?: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId, kind: "agent", phase, role, label, taskId };
}
function toolStart(agentId: string, tool: string, input: unknown, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId, kind: "tool", tool, phase: "start", input, taskId };
}
function toolEnd(agentId: string, tool: string, status: "ok" | "error", output: unknown, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId, kind: "tool", tool, phase: "end", status, output, taskId };
}
function delegate(from: string, to: string, phase: "dispatch" | "return", task: string | undefined, payload: unknown, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId: from, kind: "delegate", phase, from, to, task, payload, taskId };
}
function bbWrite(agentId: string, key: string, value: unknown, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId, kind: "blackboard", op: "write", key, value, taskId };
}
function bbRead(agentId: string, key: string, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId, kind: "blackboard", op: "read", key, taskId };
}
function noti(from: string, to: string | string[], phase: "broadcast" | "ack", key: string, message: string, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId: from, kind: "noti", phase, from, to, key, message, taskId };
}
function taskEv(phase: "input" | "output", request: string | undefined, result: unknown, scenario: string, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId: "hub", kind: "task", phase, request, result, scenario, taskId };
}
function msg(agentId: string, title: string, content: string, space: string, taskId: string): FlowEventInput {
  return { eventId: eid(), ts: ts(), space, agentId, kind: "message", title, content, taskId };
}

async function post(batch: FlowEventInput[]) {
  try {
    await fetch(INGEST_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
  } catch (err) {
    console.error("[sim] ingest failed:", (err as Error).message);
  }
}

// ---- presence management ----
const seen = new Set<string>();
const AGENTS = [
  { agentId: "hub",     role: "orchestrator", label: "HomeHub" },
  { agentId: "pc",      role: "creator",      label: "PC Agent" },
  { agentId: "tv",      role: "display",      label: "TV Agent" },
  { agentId: "mobile",  role: "notifier",     label: "Mobile" },
  { agentId: "speaker", role: "audio",        label: "Speaker" },
];

function ensurePresence(agentIds: string[], space: string): FlowEventInput[] {
  const out: FlowEventInput[] = [];
  for (const id of agentIds) {
    const key = `${space}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = AGENTS.find((a) => a.agentId === id);
    out.push(agentEv(id, "start", spec?.role ?? "agent", spec?.label ?? id, space));
  }
  return out;
}

// ---- task runner ----
type ScenarioNo = 1 | 2 | 3;
interface ScenarioTask { id: string; space: string; step: number; scenario: ScenarioNo }

// S1: 0~27 + default → S1_LAST = 28
// S2: 0~33 + default → S2_LAST = 34
// S3: 0~17 + default → S3_LAST = 18
const S1_LAST = 28;
const S2_LAST = 34;
const S3_LAST = 18;

let taskSeq = 0;
const active: ScenarioTask[] = [];
let nextScenario: ScenarioNo = 1;

function spawnTask(): ScenarioTask {
  taskSeq++;
  const scenario = nextScenario;
  nextScenario = scenario === 1 ? 2 : scenario === 2 ? 3 : 1;
  return {
    id: `task-${taskSeq.toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`,
    space: pick(SPACES),
    step: 0,
    scenario,
  };
}

// ============================================================
// Scenario 1: Hub knows capabilities via discover_agents (no BB)
// ============================================================
function advanceS1(task: ScenarioTask): FlowEventInput[] {
  const { id: t, space: sp } = task;
  switch (task.step++) {

    // ── 0. Task arrives ──────────────────────────────────────
    case 0: return [
      taskEv("input", "가족 사진으로 엄마 생일파티 때 틀 영상 만들어줘", undefined, "scenario-1", sp, t),
      msg("hub", "새 요청 수신 📨", "엄마 생일파티 영상 제작 요청이 들어왔어. 어떤 Agent들이 있는지 먼저 파악해야겠어.", sp, t),
    ];

    // ── 1~2. Hub discovers agents ─────────────────────────────
    case 1: return [
      toolStart("hub", "discover_agents", { query: "all_registered" }, sp, t),
      msg("hub", "네트워크 스캔 시작 🔍", "홈 네트워크에 연결된 Agent들을 검색하고 있어. 누가 뭘 할 수 있는지 확인해볼게.", sp, t),
    ];
    case 2: return [
      toolEnd("hub", "discover_agents", "ok", {
        pc: { tools: ["edit_birthday_video", "find_family_photos"], memory: ["photo_library"] },
        tv: { tools: ["get_family_music_preferences", "play_video"], memory: ["music_favorites"] },
      }, sp, t),
      msg("hub", "Agent 능력 파악 완료! 📋", "PC Agent: 영상 편집 + 가족 사진 보관소\nTV Agent: 음악 취향 분석 + 영상 재생\n두 Agent가 협력하면 생일 영상을 완성할 수 있어!", sp, t),
    ];

    // ── 3~4. Hub creates plan ──────────────────────────────────
    case 3: return [
      msg("hub", "실행 계획 수립 중 🧠", "Agent 능력을 바탕으로 최적의 작업 순서를 생각하고 있어. TV에서 음악 취향 → PC에서 영상 편집 → TV에서 재생하는 순서가 좋겠어.", sp, t),
    ];
    case 4: return [
      toolStart("hub", "create_plan", { agents: ["pc", "tv"], goal: "birthday_video_with_music" }, sp, t),
    ];
    case 5: return [
      toolEnd("hub", "create_plan", "ok", {
        steps: ["TV → 음악 취향 수집", "PC → 생일 영상 편집", "TV → 영상 재생"],
        estimated_time: "15분",
      }, sp, t),
      msg("hub", "계획 수립 완료! ✅", "① TV에게 가족 음악 취향 수집 요청\n② PC에게 사진으로 생일 영상 편집 위임\n③ 완성된 영상을 TV에서 재생\n이제 실행에 옮길게!", sp, t),
    ];

    // ── 5. Hub delegates to TV ─────────────────────────────────
    case 6: return [
      delegate("hub", "tv", "dispatch", "가족이 생일파티에서 좋아할 음악 취향 분석해줘", null, sp, t),
      msg("hub", "TV에게 음악 취향 요청 📺", "가족 모두가 좋아하는 생일 분위기 음악을 TV Agent에게 조사해달라고 했어. 결과 기다리는 중...", sp, t),
    ];

    // ── 6~8. TV gathers music preferences ────────────────────
    case 7: return [
      toolStart("tv", "get_family_music_preferences", { occasion: "birthday_party", family_size: 4 }, sp, t),
      msg("tv", "음악 취향 조사 시작! 🎵", "Hub에서 음악 취향 조사 요청이 왔어. 가족 구성원별 음악 이력을 분석하기 시작할게.", sp, t),
    ];
    case 8: return [
      msg("tv", "데이터 분석 중... 📊", "4명의 가족 구성원 음악 청취 이력 12,000곡을 분석 중이야. 생일 분위기에 맞는 장르와 곡들을 추려내고 있어.", sp, t),
    ];
    case 9: return [
      toolEnd("tv", "get_family_music_preferences", "ok", {
        top_genre: "K-Pop 발라드",
        recommended_tracks: ["Happy Birthday 가족 ver.", "사랑해 엄마", "가족의 노래"],
        mood: "따뜻하고 감성적인",
        tempo: "보통",
      }, sp, t),
      msg("tv", "음악 취향 분석 완료! 🎶", "분석 결과: 가족 모두 K-Pop 발라드를 가장 선호해. 특히 '사랑해 엄마'는 모든 구성원이 좋아하는 곡이야. 3곡을 추천 리스트로 정리해서 Hub에 전달할게.", sp, t),
    ];
    case 10: return [
      delegate("tv", "hub", "return", undefined, {
        genre: "K-Pop 발라드",
        tracks: ["Happy Birthday 가족 ver.", "사랑해 엄마", "가족의 노래"],
      }, sp, t),
    ];

    // ── 9~10. Hub searches photos ─────────────────────────────
    case 11: return [
      msg("hub", "음악 선정 완료! 다음은 사진 수집 📸", "TV에서 K-Pop 발라드, 특히 '사랑해 엄마'를 추천받았어. 이제 가족 사진 라이브러리에서 생일파티에 어울리는 사진들을 찾아볼게.", sp, t),
      toolStart("hub", "find_family_photos", { album: "family", tags: ["birthday", "celebration"], year: 2024 }, sp, t),
    ];
    case 12: return [
      toolEnd("hub", "find_family_photos", "ok", {
        total_found: 28,
        album: "가족앨범_2024",
        highlights: ["IMG_1203.jpg (케이크 커팅)", "IMG_1247.jpg (가족 단체사진)", "IMG_1089.jpg (선물 오픈)"],
      }, sp, t),
      msg("hub", "생일 사진 28장 확보! 🖼️", "2024 가족앨범에서 생일파티 관련 사진 28장을 찾았어. 케이크 커팅, 가족 단체사진, 선물 오픈 등 다양한 순간이 담겨있어. PC에게 편집을 맡길게.", sp, t),
    ];

    // ── 10. Hub delegates to PC ───────────────────────────────
    case 13: return [
      delegate("hub", "pc", "dispatch", "사진 28장으로 엄마 생일 영상 편집해줘. BGM: K-Pop 발라드 (사랑해 엄마)", null, sp, t),
      msg("hub", "PC에게 영상 편집 위임 🎬", "사진 28장과 K-Pop 발라드 BGM 정보를 PC Agent에게 전달했어. 영상 편집은 PC가 제일 잘하니까 맡겨놓고 기다릴게.", sp, t),
    ];

    // ── 11~15. PC edits video (multi-step) ────────────────────
    case 14: return [
      toolStart("pc", "edit_birthday_video", {
        photos: 28,
        bgm: "사랑해 엄마 (K-Pop 발라드)",
        duration_target: "3-4분",
        style: "warm_emotional",
      }, sp, t),
      msg("pc", "영상 편집 시작! ✂️", "Hub에서 영상 편집 요청이 왔어! 사진 28장과 '사랑해 엄마' BGM으로 감동적인 생일 영상을 만들어볼게. 시간이 좀 걸릴 수 있어!", sp, t),
    ];
    case 15: return [
      msg("pc", "📸 사진 분석 중...", "28장의 사진을 하나하나 분석하고 있어. 밝기, 색감, 얼굴 인식으로 최고의 순간들을 선별 중이야. 27/28 완료!", sp, t),
    ];
    case 16: return [
      msg("pc", "🎞️ 씬 구성 & 전환 효과 작업 중...", "12개의 씬으로 영상을 구성했어. 각 씬 사이에 부드러운 페이드 전환 효과를 입히는 중이야. 케이크 씬이 하이라이트!", sp, t),
    ];
    case 17: return [
      msg("pc", "🎵 BGM 싱크 & 음량 조절 중...", "'사랑해 엄마' 멜로디에 맞춰 사진 전환 타이밍을 조정하고 있어. 후렴구에 가족 단체사진이 오도록 배치 완료!", sp, t),
    ];
    case 18: return [
      msg("pc", "📽️ 최종 인코딩 중... 73% 완료", "H.264 코덱으로 최종 렌더링 중이야. 화질 1080p, 파일 크기 최적화하면서 인코딩 중. 거의 다 됐어!", sp, t),
    ];
    case 19: return [
      toolEnd("pc", "edit_birthday_video", "ok", {
        file: "birthday_mom_2024.mp4",
        duration: "3분 24초",
        size: "142MB",
        resolution: "1920×1080",
        scenes: 12,
        bgm: "사랑해 엄마",
      }, sp, t),
      msg("pc", "🎬 영상 편집 완료!", "birthday_mom_2024.mp4 완성! 3분 24초, 1080p 고화질, 총 12씬으로 구성된 감동적인 생일 영상이야. '사랑해 엄마' BGM도 완벽하게 맞아. Hub에게 전달할게!", sp, t),
    ];
    case 20: return [
      delegate("pc", "hub", "return", undefined, {
        file: "birthday_mom_2024.mp4",
        duration: "3분 24초",
        scenes: 12,
      }, sp, t),
    ];

    // ── 15~16. Hub confirms with user ────────────────────────
    case 21: return [
      toolStart("hub", "ask_user", { message: "birthday_mom_2024.mp4 완성! TV에서 바로 재생할까요?" }, sp, t),
      msg("hub", "사용자 확인 중 💬", "PC가 영상을 완성했어! 곧바로 TV에서 재생해도 될지 사용자에게 먼저 물어봐야겠어.", sp, t),
    ];
    case 22: return [
      toolEnd("hub", "ask_user", "ok", { answer: "yes", confirmed: true }, sp, t),
      msg("hub", "사용자 승인 완료! ▶️", "사용자가 지금 바로 TV에서 재생해달라고 했어! TV Agent에게 영상 재생을 요청할게.", sp, t),
    ];

    // ── 17~19. TV plays video ─────────────────────────────────
    case 23: return [
      delegate("hub", "tv", "dispatch", "birthday_mom_2024.mp4 풀스크린으로 재생해줘", null, sp, t),
      msg("hub", "TV에 재생 요청 전송 📡", "TV Agent에게 birthday_mom_2024.mp4를 풀스크린으로 재생해달라고 요청했어.", sp, t),
    ];
    case 24: return [
      toolStart("tv", "play_video", { file: "birthday_mom_2024.mp4", fullscreen: true, volume: 80 }, sp, t),
      msg("tv", "영상 재생 준비 중! ⏳", "Hub에서 재생 요청이 왔어! birthday_mom_2024.mp4를 TV에서 풀스크린 재생 준비 중이야.", sp, t),
    ];
    case 25: return [
      msg("tv", "🎥 영상 로딩 완료, 화면 전환 중...", "영상 파일 로딩 완료! TV 화면을 앱 화면에서 영상 재생 화면으로 전환하고 볼륨 설정 중이야.", sp, t),
    ];
    case 26: return [
      toolEnd("tv", "play_video", "ok", { status: "playing", duration: "3분 24초", volume: 80 }, sp, t),
      msg("tv", "🎉 엄마 생일 영상 재생 시작!", "birthday_mom_2024.mp4 풀스크린 재생 시작! '사랑해 엄마' BGM과 함께 3분 24초 생일 영상이 흘러나오고 있어. 가족 모두 즐겁게 보시길! 🎂", sp, t),
    ];
    case 27: return [
      delegate("tv", "hub", "return", undefined, { status: "playing", file: "birthday_mom_2024.mp4" }, sp, t),
    ];

    // ── Default: task complete ─────────────────────────────────
    default: return [
      taskEv("output", undefined, {
        video: "birthday_mom_2024.mp4",
        message: "엄마 생일 파티 영상이 TV에서 재생 중입니다! 🎉",
        duration: "3분 24초",
        bgm: "사랑해 엄마",
      }, "scenario-1", sp, t),
      msg("hub", "🎊 모든 작업 완료!", "완벽한 생일 선물 완성!\n① Agent 탐색 → ② 계획 수립 → ③ TV 음악취향 조사 → ④ 사진 28장 검색 → ⑤ PC 영상 편집 (3분 24초) → ⑥ 사용자 확인 → ⑦ TV 재생\n7단계 오케스트레이션 성공! 🎂", sp, t),
    ];
  }
}

// ============================================================
// Scenario 2: Hub discovers capabilities via Blackboard + Noti (PARALLEL)
// ============================================================
function advanceS2(task: ScenarioTask): FlowEventInput[] {
  const { id: t, space: sp } = task;
  switch (task.step++) {

    // ── 0. Task arrives ──────────────────────────────────────
    case 0: return [
      taskEv("input", "가족 사진으로 엄마 생일파티 때 틀 영상 만들어줘", undefined, "scenario-2", sp, t),
      msg("hub", "새 요청 수신 📨 (Blackboard 탐색 모드)", "엄마 생일파티 영상 요청! 이번엔 각 Agent가 무엇을 할 수 있는지 미리 모르는 상황이야. Blackboard를 통해 능력을 탐색해야겠어.", sp, t),
    ];

    // ── 1~2. Hub analyzes requirements ───────────────────────
    case 1: return [
      toolStart("hub", "analyze_requirements", { request: "birthday_video_with_bgm" }, sp, t),
      msg("hub", "요구사항 분석 시작 🔬", "이 작업을 완성하려면 어떤 능력이 필요한지 먼저 파악해야 해. 영상 편집, 음악, 사진, 재생... 각각 어떤 Agent가 담당할 수 있을까?", sp, t),
    ];
    case 2: return [
      toolEnd("hub", "analyze_requirements", "ok", {
        required: ["video_editing", "music_preference", "photo_library", "video_playback"],
        unknown_agents: ["pc", "tv"],
      }, sp, t),
      msg("hub", "필요 능력 목록 완성! 📋", "필요 능력: 영상편집 / 음악취향분석 / 사진라이브러리 / 영상재생\n이걸 Blackboard에 올려놓고 PC·TV에게 각자 능력을 등록해달라고 부탁할게.", sp, t),
    ];

    // ── 2~3. Hub writes to BB and broadcasts ─────────────────
    case 3: return [
      bbWrite("hub", "task_requirements", {
        task: "birthday_video",
        required_capabilities: ["video_editing", "music_preference", "photo_library", "video_playback"],
        deadline: "ASAP",
      }, sp, t),
      msg("hub", "Blackboard에 요구사항 게시 ✍️", "task_requirements를 Blackboard 서버에 기록했어. 이제 PC·TV에게 동시에 알림을 보낼게.", sp, t),
    ];
    case 4: return [
      noti("hub", ["pc", "tv"], "broadcast", "task_requirements", "Blackboard의 task_requirements 확인 후 각자 능력 목록을 BB에 등록해줘", sp, t),
      msg("hub", "PC·TV에 동시 브로드캐스트 📢", "PC와 TV 양쪽에 동시에 알림 전송 완료! 각자 Blackboard를 확인하고 능력을 등록해달라고 했어. 두 Agent의 응답을 기다리는 중...", sp, t),
    ];

    // ── 4~7. PC and TV work in parallel ──────────────────────
    case 5: return [
      toolStart("pc", "check_capabilities", { source: "blackboard" }, sp, t),
      toolStart("tv", "check_capabilities", { source: "blackboard" }, sp, t),
      msg("pc", "브로드캐스트 수신! 🔔", "Hub의 알림을 받았어. Blackboard에서 task_requirements를 읽고 내 능력 목록을 정리할게.", sp, t),
      msg("tv", "브로드캐스트 수신! 🔔", "Hub의 알림을 받았어. Blackboard에서 task_requirements를 읽고 내 능력 목록을 정리할게.", sp, t),
    ];
    case 6: return [
      bbRead("pc", "task_requirements", sp, t),
      bbRead("tv", "task_requirements", sp, t),
      toolEnd("pc", "check_capabilities", "ok", { matched: ["video_editing", "photo_library"] }, sp, t),
      toolEnd("tv", "check_capabilities", "ok", { matched: ["music_preference", "video_playback"] }, sp, t),
    ];
    case 7: return [
      bbWrite("pc", "capabilities_pc", {
        agent: "pc", role: "creator",
        can_do: ["video_editing", "photo_library", "edit_birthday_video", "find_family_photos"],
      }, sp, t),
      bbWrite("tv", "capabilities_tv", {
        agent: "tv", role: "display",
        can_do: ["music_preference", "video_playback", "get_family_music_preferences", "play_video"],
      }, sp, t),
      msg("pc", "능력 목록 Blackboard에 등록! ✍️", "내 능력을 분석했어: 영상 편집 / 가족 사진 라이브러리 / edit_birthday_video / find_family_photos. BB의 capabilities_pc에 저장 완료. Hub에 알릴게!", sp, t),
      msg("tv", "능력 목록 Blackboard에 등록! ✍️", "내 능력을 분석했어: 음악 취향 분석 / 영상 재생 / get_family_music_preferences / play_video. BB의 capabilities_tv에 저장 완료. Hub에 알릴게!", sp, t),
    ];
    case 8: return [
      noti("pc", "hub", "ack", "capabilities_pc", "능력 목록 작성 완료, 확인해줘", sp, t),
      noti("tv", "hub", "ack", "capabilities_tv", "능력 목록 작성 완료, 확인해줘", sp, t),
    ];

    // ── 8~9. Hub reads capabilities and plans ────────────────
    case 9: return [
      bbRead("hub", "capabilities_pc", sp, t),
      bbRead("hub", "capabilities_tv", sp, t),
      msg("hub", "PC·TV 능력 파악 완료! 🎯", "PC·TV가 동시에 능력 등록을 마쳤어! PC: 영상편집·사진라이브러리, TV: 음악취향·재생. 완벽한 조합이야. 이제 계획을 세울게.", sp, t),
    ];
    case 10: return [
      toolStart("hub", "create_plan", { capabilities: { pc: "video+photos", tv: "music+playback" } }, sp, t),
      msg("hub", "실행 계획 수립 중 🧠", "Blackboard로 파악한 능력을 바탕으로 최적 실행 순서를 계획 중이야.", sp, t),
    ];
    case 11: return [
      toolEnd("hub", "create_plan", "ok", {
        method: "blackboard_discovery",
        steps: ["TV → 음악 취향 수집", "PC → 생일 영상 편집", "TV → 영상 재생"],
      }, sp, t),
      msg("hub", "계획 수립 완료! (Blackboard 기반) ✅", "Blackboard 능력 탐색으로 완성한 계획:\n① TV: 음악 취향 수집 → ② PC: 영상 편집 → ③ TV: 재생\nScenario 1과 같은 결과지만 능력을 직접 탐색해서 만들었어!", sp, t),
    ];

    // ── 10. Delegate to TV (same as S1 from here) ────────────
    case 12: return [
      delegate("hub", "tv", "dispatch", "가족이 생일파티에서 좋아할 음악 취향 분석해줘", null, sp, t),
      msg("hub", "실행 시작! TV에게 음악 취향 요청 🎵", "이제 실행 단계야. TV에게 가족 음악 취향 조사를 요청할게.", sp, t),
    ];
    case 13: return [
      toolStart("tv", "get_family_music_preferences", { occasion: "birthday_party" }, sp, t),
      msg("tv", "음악 취향 조사 시작! 🎵", "Hub에서 음악 취향 요청이 왔어. 가족 음악 데이터를 분석해볼게.", sp, t),
    ];
    case 14: return [
      msg("tv", "가족 음악 데이터 분석 중... 🎧", "4명의 가족 음악 청취 이력을 분석하고 있어. 생일 분위기에 맞는 곡들을 추리는 중이야.", sp, t),
    ];
    case 15: return [
      toolEnd("tv", "get_family_music_preferences", "ok", {
        top_genre: "K-Pop 발라드",
        tracks: ["Happy Birthday 가족 ver.", "사랑해 엄마", "가족의 노래"],
        mood: "따뜻하고 감성적인",
      }, sp, t),
      msg("tv", "음악 취향 분석 완료! 🎶", "K-Pop 발라드가 가족 최애 장르야. '사랑해 엄마'가 최고 추천곡! Hub에게 결과 전달할게.", sp, t),
    ];
    case 16: return [
      delegate("tv", "hub", "return", undefined, {
        genre: "K-Pop 발라드",
        top_track: "사랑해 엄마",
      }, sp, t),
    ];

    // ── Hub photo search ──────────────────────────────────────
    case 17: return [
      msg("hub", "음악 취향 확인! 이제 사진 검색 📸", "TV에서 K-Pop 발라드와 '사랑해 엄마'를 추천받았어. 이제 가족 사진 라이브러리에서 생일 사진을 찾을게.", sp, t),
      toolStart("hub", "find_family_photos", { album: "family", tags: ["birthday"], year: 2024 }, sp, t),
    ];
    case 18: return [
      toolEnd("hub", "find_family_photos", "ok", {
        found: 28,
        album: "가족앨범_2024",
        best: ["케이크 커팅 4장", "가족 단체사진 8장", "선물 오픈 6장"],
      }, sp, t),
      msg("hub", "생일 사진 28장 확보! 🖼️", "2024 가족앨범에서 생일 사진 28장 선별 완료. PC에게 영상 편집을 맡길게!", sp, t),
    ];

    // ── Hub delegates to PC ───────────────────────────────────
    case 19: return [
      delegate("hub", "pc", "dispatch", "사진 28장으로 엄마 생일 영상 편집해줘. BGM: K-Pop 발라드 (사랑해 엄마)", null, sp, t),
      msg("hub", "PC에게 영상 편집 위임 🎬", "사진 28장과 K-Pop 발라드 BGM을 PC에 전달했어. 영상 편집 시작!", sp, t),
    ];

    // ── PC video editing (multi-step) ─────────────────────────
    case 20: return [
      toolStart("pc", "edit_birthday_video", {
        photos: 28,
        bgm: "사랑해 엄마",
        duration_target: "3-4분",
      }, sp, t),
      msg("pc", "영상 편집 시작! ✂️", "사진 28장과 '사랑해 엄마' BGM으로 생일 영상 제작 시작! 최고의 영상을 만들어볼게.", sp, t),
    ];
    case 21: return [
      msg("pc", "📸 사진 분석 & 선별 중...", "28장의 사진을 AI로 분석해서 가장 감동적인 순간들을 고르고 있어. 밝기·색감·표정 기반으로 최적화 중!", sp, t),
    ];
    case 22: return [
      msg("pc", "🎞️ 12개 씬으로 영상 구성 중...", "선별된 사진들을 12개 씬으로 구성하고 각 씬 전환에 부드러운 페이드 효과를 적용하는 중이야.", sp, t),
    ];
    case 23: return [
      msg("pc", "🎵 BGM 싱크 중...", "'사랑해 엄마' 멜로디 후렴구에 가족 단체사진 씬을 맞추는 중이야. 타이밍 완벽하게 조정 중!", sp, t),
    ];
    case 24: return [
      msg("pc", "📽️ 최종 인코딩 중... 81% 완료", "1080p H.264 코덱으로 렌더링 중이야. 142MB 예상, 거의 다 됐어!", sp, t),
    ];
    case 25: return [
      toolEnd("pc", "edit_birthday_video", "ok", {
        file: "birthday_mom_2024.mp4",
        duration: "3분 24초",
        size: "142MB",
        scenes: 12,
        bgm: "사랑해 엄마",
      }, sp, t),
      msg("pc", "🎬 영상 편집 완료!", "birthday_mom_2024.mp4 완성! 3분 24초, 12씬, 142MB, '사랑해 엄마' BGM 완벽 싱크. Hub에게 전달할게!", sp, t),
    ];
    case 26: return [
      delegate("pc", "hub", "return", undefined, {
        file: "birthday_mom_2024.mp4",
        duration: "3분 24초",
      }, sp, t),
    ];

    // ── Hub confirms + TV plays ───────────────────────────────
    case 27: return [
      toolStart("hub", "ask_user", { message: "birthday_mom_2024.mp4 완성! 지금 TV에서 재생할까요?" }, sp, t),
      msg("hub", "사용자 최종 확인 중 💬", "PC가 영상을 완성했어! TV에서 바로 재생해도 될지 사용자에게 확인할게.", sp, t),
    ];
    case 28: return [
      toolEnd("hub", "ask_user", "ok", { confirmed: true }, sp, t),
      msg("hub", "사용자 승인! TV에 재생 요청 ▶️", "사용자가 승인했어! TV에게 바로 재생해달라고 요청할게.", sp, t),
    ];
    case 29: return [
      delegate("hub", "tv", "dispatch", "birthday_mom_2024.mp4 풀스크린으로 재생해줘", null, sp, t),
    ];
    case 30: return [
      toolStart("tv", "play_video", { file: "birthday_mom_2024.mp4", fullscreen: true }, sp, t),
      msg("tv", "영상 재생 준비 중! ⏳", "재생 요청 수신! 파일 로딩하고 화면 전환 준비 중이야.", sp, t),
    ];
    case 31: return [
      msg("tv", "🎥 로딩 완료, 재생 화면 전환 중...", "birthday_mom_2024.mp4 로딩 완료! TV 화면을 영상 재생 화면으로 전환하고 있어.", sp, t),
    ];
    case 32: return [
      toolEnd("tv", "play_video", "ok", { status: "playing", duration: "3분 24초" }, sp, t),
      msg("tv", "🎉 엄마 생일 영상 재생 시작!", "'사랑해 엄마' BGM과 함께 3분 24초 생일 영상이 풀스크린으로 흘러나오고 있어! 가족 모두 즐겁게 보시길! 🎂", sp, t),
    ];
    case 33: return [
      delegate("tv", "hub", "return", undefined, { status: "playing", file: "birthday_mom_2024.mp4" }, sp, t),
    ];

    // ── Default: task complete ─────────────────────────────────
    default: return [
      taskEv("output", undefined, {
        video: "birthday_mom_2024.mp4",
        message: "엄마 생일 파티 영상이 TV에서 재생 중입니다! 🎉",
        duration: "3분 24초",
        bgm: "사랑해 엄마",
      }, "scenario-2", sp, t),
      msg("hub", "🎊 Blackboard 탐색 → 실행 완료!", "BB 기반 능력 탐색 성공!\n① 요구사항 분석 → ② BB 게시 → ③ PC·TV 병렬 능력 등록 → ④ 계획 수립 → ⑤ 영상 제작 → ⑥ TV 재생\nScenario 1보다 복잡했지만 더 유연한 방식으로 해냈어! 🎂", sp, t),
    ];
  }
}

// ============================================================
// Scenario 3: Movie night — TV·Speaker·Mobile fan-out
// (Hub 아래에 디바이스가 동적으로 늘어나는 멀티 디바이스 데모)
// ============================================================
function advanceS3(task: ScenarioTask): FlowEventInput[] {
  const { id: t, space: sp } = task;
  switch (task.step++) {

    // ── 0. Task arrives ──────────────────────────────────────
    case 0: return [
      taskEv("input", "오늘 저녁 거실 영화의 밤 준비하고 가족들에게 알려줘", undefined, "scenario-3", sp, t),
      msg("hub", "새 요청 수신 📨", "가족 영화의 밤 준비 요청이야! 화면·사운드·알림까지 여러 디바이스의 협력이 필요하겠어. 어떤 디바이스들이 깨어있는지 확인해볼게.", sp, t),
    ];

    // ── 1~2. Hub discovers devices ────────────────────────────
    case 1: return [
      toolStart("hub", "discover_agents", { query: "media_devices" }, sp, t),
      msg("hub", "디바이스 스캔 중 🔍", "거실 주변의 미디어 디바이스를 검색하고 있어.", sp, t),
    ];
    case 2: return [
      toolEnd("hub", "discover_agents", "ok", {
        tv:      { tools: ["set_movie_mode", "play_video"] },
        speaker: { tools: ["set_sound_profile"] },
        mobile:  { tools: ["push_notification"] },
      }, sp, t),
      msg("hub", "디바이스 3대 발견! 📋", "TV(화면), Speaker(사운드), Mobile(알림) 3대가 응답했어. 영화 모드 셋업을 분담시킬게.", sp, t),
    ];

    // ── 3. Hub delegates to TV ────────────────────────────────
    case 3: return [
      delegate("hub", "tv", "dispatch", "거실 TV 영화 모드로 전환해줘", null, sp, t),
      msg("hub", "TV에 영화 모드 요청 📺", "TV에게 시네마 화면 모드 전환을 요청했어.", sp, t),
    ];
    case 4: return [
      toolStart("tv", "set_movie_mode", { picture: "cinema", brightness: "40%" }, sp, t),
      msg("tv", "영화 모드 전환 중! 🎬", "화면 모드를 시네마로, 밝기를 40%로 조정하고 있어.", sp, t),
    ];
    case 5: return [
      toolEnd("tv", "set_movie_mode", "ok", { picture: "cinema", brightness: "40%", hdr: true }, sp, t),
      bbWrite("tv", "screen_ready", { mode: "cinema", hdr: true }, sp, t),
      msg("tv", "화면 준비 완료! ✅", "시네마 모드 + HDR 활성화 완료. 상태를 Blackboard에 기록했어.", sp, t),
    ];
    case 6: return [
      delegate("tv", "hub", "return", undefined, { status: "screen_ready" }, sp, t),
    ];

    // ── 7. Hub delegates to Speaker ───────────────────────────
    case 7: return [
      delegate("hub", "speaker", "dispatch", "사운드를 영화관 프로파일로 설정해줘", null, sp, t),
      msg("hub", "Speaker에 사운드 요청 🔈", "거실 스피커에게 영화관급 사운드 프로파일 설정을 요청했어.", sp, t),
    ];
    case 8: return [
      toolStart("speaker", "set_sound_profile", { profile: "cinema_dts", volume: 45 }, sp, t),
      msg("speaker", "사운드 프로파일 설정 중 🎚️", "Cinema DTS 프로파일 적용 + 볼륨 45로 맞추는 중이야.", sp, t),
    ];
    case 9: return [
      toolEnd("speaker", "set_sound_profile", "ok", { profile: "cinema_dts", volume: 45, subwoofer: "on" }, sp, t),
      bbWrite("speaker", "sound_profile", { profile: "cinema_dts", volume: 45 }, sp, t),
      msg("speaker", "사운드 준비 완료! ✅", "Cinema DTS + 서브우퍼 활성화 완료. Blackboard에 기록했어.", sp, t),
    ];
    case 10: return [
      delegate("speaker", "hub", "return", undefined, { status: "sound_ready" }, sp, t),
    ];

    // ── 11. Hub delegates to Mobile ───────────────────────────
    case 11: return [
      delegate("hub", "mobile", "dispatch", "가족들에게 영화의 밤 시작 알림 보내줘", null, sp, t),
      msg("hub", "Mobile에 알림 요청 📱", "가족 모두의 휴대폰으로 영화의 밤 알림을 보내달라고 했어.", sp, t),
    ];
    case 12: return [
      toolStart("mobile", "push_notification", { to: "가족 4명", message: "🍿 오늘 저녁 거실 영화의 밤!" }, sp, t),
      msg("mobile", "알림 발송 중 📨", "가족 4명의 기기로 푸시 알림을 보내고 있어.", sp, t),
    ];
    case 13: return [
      toolEnd("mobile", "push_notification", "ok", { delivered: 4, read: 2 }, sp, t),
      msg("mobile", "알림 전송 완료! ✅", "4명 모두에게 전달 완료, 벌써 2명이 읽었어! 다들 기대하는 중 🍿", sp, t),
    ];
    case 14: return [
      delegate("mobile", "hub", "return", undefined, { delivered: 4 }, sp, t),
    ];

    // ── 15~17. Hub final check via Blackboard ─────────────────
    case 15: return [
      bbRead("hub", "screen_ready", sp, t),
      bbRead("hub", "sound_profile", sp, t),
      msg("hub", "최종 점검 중 🔎", "Blackboard에서 화면·사운드 상태를 확인하고 있어. 모든 디바이스가 준비됐는지 점검!", sp, t),
    ];
    case 16: return [
      toolStart("hub", "verify_setup", { checks: ["screen", "sound", "notification"] }, sp, t),
    ];
    case 17: return [
      toolEnd("hub", "verify_setup", "ok", { screen: "cinema", sound: "cinema_dts", notified: 4 }, sp, t),
      msg("hub", "전체 셋업 검증 완료! ✅", "화면 ✓ 사운드 ✓ 알림 ✓ — 모든 준비가 끝났어!", sp, t),
    ];

    // ── Default: task complete ─────────────────────────────────
    default: return [
      taskEv("output", undefined, {
        message: "거실 영화의 밤 준비 완료! 가족들이 모이는 중입니다 🍿",
        screen: "cinema",
        sound: "cinema_dts",
        notified: 4,
      }, "scenario-3", sp, t),
      msg("hub", "🎊 영화의 밤 준비 완료!", "멀티 디바이스 협업 성공!\n① 디바이스 3대 탐색 → ② TV 영화 모드 → ③ Speaker 사운드 → ④ Mobile 알림 → ⑤ 최종 점검\nTV·Speaker·Mobile이 각자 역할을 완벽하게 해냈어! 🍿", sp, t),
    ];
  }
}

function advance(task: ScenarioTask): FlowEventInput[] {
  switch (task.scenario) {
    case 1: return advanceS1(task);
    case 2: return advanceS2(task);
    case 3: return advanceS3(task);
  }
}

function lastStep(task: ScenarioTask): number {
  return task.scenario === 1 ? S1_LAST : task.scenario === 2 ? S2_LAST : S3_LAST;
}

// ---- main tick ----
function tick() {
  const leading = active[0];
  if (active.length === 0 || (active.length < 2 && leading && leading.step >= lastStep(leading) - 3)) {
    active.push(spawnTask());
  }

  if (!active.length) return;

  const task = active[0];
  const batch = advance(task);

  const ids = new Set<string>(["hub"]);
  for (const e of batch) {
    ids.add(e.agentId);
    if (e.kind === "delegate") { ids.add(e.from); ids.add(e.to); }
    if (e.kind === "noti") {
      ids.add(e.from);
      const to = e.to;
      if (Array.isArray(to)) to.forEach((id) => ids.add(id));
      else ids.add(to as string);
    }
  }
  const presence = ensurePresence([...ids], task.space);

  if (task.step > lastStep(task)) {
    active.splice(active.indexOf(task), 1);
    for (const a of AGENTS) seen.delete(`${task.space}/${a.agentId}`);
  }

  if (batch.length) void post([...presence, ...batch]);
}

console.log(
  `[sim] HomeHub demo → ${INGEST_URL} every ${INTERVAL_MS}ms\n` +
  `  Scenario 1: Hub via discover_agents — ${S1_LAST + 1} steps\n` +
  `  Scenario 2: Hub via Blackboard+Noti (parallel PC·TV) — ${S2_LAST + 1} steps\n` +
  `  Scenario 3: Movie night TV·Speaker·Mobile fan-out — ${S3_LAST + 1} steps\n` +
  `  Spaces: ${SPACES.join(", ")}`
);
setInterval(tick, INTERVAL_MS);
