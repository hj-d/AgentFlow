import { createCollector } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);
const SNAPSHOT_SIZE = Number(process.env.SNAPSHOT_SIZE ?? 2000);

const collector = createCollector({ snapshotSize: SNAPSHOT_SIZE });
collector.listen(PORT).then((port) => {
  console.log(`[agentflow] collector listening on :${port}  (ws: /ws, ingest: POST /ingest)`);
});
