import express, { type Express } from "express";
import cors from "cors";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.js";
import { ingestBatch } from "./ingest.js";

export interface Collector {
  app: Express;
  httpServer: Server;
  wss: WebSocketServer;
  hub: Hub;
  /** Start listening; resolves with the actual port (useful when port=0). */
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
}

export interface CollectorOptions {
  snapshotSize?: number;
  now?: () => number; // injectable clock for tests
}

export function createCollector(opts: CollectorOptions = {}): Collector {
  const snapshotSize = opts.snapshotSize ?? 2000;
  const now = opts.now ?? (() => Date.now());

  const hub = new Hub(snapshotSize);
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.post("/ingest", (req, res) => {
    const events = ingestBatch(req.body, now());
    for (const e of events) hub.ingest(e);
    res.json({ accepted: events.length });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, clients: hub.clientCount });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws) => hub.addClient(ws));

  return {
    app,
    httpServer,
    wss,
    hub,
    listen: (port: number) =>
      new Promise<number>((resolve) => {
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        hub.stop();
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
}
