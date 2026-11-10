/** A test client for the /ws socket (like Starlette's TestClient websocket). */
import WebSocket from "ws";

import { startServer, type AppOptions, type LunaServer } from "../src/web/server.ts";

export class SocketClient {
  readonly ws: WebSocket;
  #queue: any[] = [];
  #waiters: ((m: any) => void)[] = [];
  closed: Promise<number>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = this.#waiters.shift();
      if (waiter) waiter(msg);
      else this.#queue.push(msg);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<SocketClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { headers });
      ws.once("open", () => resolve(new SocketClient(ws)));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  next(timeoutMs = 10_000): Promise<any> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message in time")), timeoutMs);
      this.#waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  /** Collect events until one of `types` arrives; return them all. */
  async until(...types: string[]): Promise<any[]> {
    const events: any[] = [];
    for (;;) {
      const event = await this.next();
      events.push(event);
      if (types.includes(event.type)) return events;
    }
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}

/** Start a server for one test; it is closed by the returned close(). */
export async function serve(options: AppOptions): Promise<LunaServer> {
  return startServer({ envPath: "/nonexistent/.env", dashboardPath: "/nonexistent/dashboard.json", telegramStatePath: "/nonexistent/telegram.json", ...options }, 0);
}

/** Open a tab: returns the client, hello and thread events (context checked). */
export async function connect(url: string): Promise<{ tab: SocketClient; hello: any; thread: any }> {
  const tab = await SocketClient.open(url);
  const hello = await tab.next();
  const thread = await tab.next();
  const context = await tab.next();
  if (context.type !== "context") throw new Error(`expected context, got ${context.type}`);
  return { tab, hello, thread };
}
