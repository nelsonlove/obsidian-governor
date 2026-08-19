import * as net from "node:net";
import * as fs from "node:fs";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { splitLines } from "./ndjson.js";
import { parsePreamble, DEFAULT_CONN_OPTIONS, type ConnOptions } from "./preamble.js";

/**
 * SDK Transport for a SINGLE Unix-socket connection. Frames newline-delimited
 * JSON-RPC. One of these is created per accepted connection, so concurrent
 * MCP clients each get their own independent session.
 *
 * `initial` carries bytes the listener consumed while peeking for the
 * connection preamble (everything after the preamble line, or the whole peeked
 * buffer when the first line wasn't a preamble). Delivered on start(), after
 * the SDK has attached its handlers.
 */
export class UnixSocketConnTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;

  private buf = "";
  private started = false;

  constructor(
    private readonly conn: net.Socket,
    private readonly initial: string = ""
  ) {}

  private onChunk(chunk: string): void {
    const { lines, rest } = splitLines(this.buf, chunk);
    this.buf = rest;
    for (const line of lines) {
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (e) {
        this.onerror?.(e as Error);
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.conn.setEncoding("utf8");
    this.conn.on("data", (chunk: string) => this.onChunk(chunk));
    this.conn.on("close", () => this.onclose?.());
    this.conn.on("error", (e) => this.onerror?.(e));
    // The listener paused the socket when its peek handler detached, so bytes
    // that arrived between handoff and start() are buffered, not dropped —
    // correctness must not depend on Protocol.connect reaching start() in the
    // same tick. Resume now that our 'data' listener is attached.
    this.conn.resume();
    // Deliver peeked-past bytes AFTER connect() finishes wiring the server:
    // Protocol.connect assigns onmessage before awaiting start(), but a
    // microtask keeps message dispatch out of the start() call stack entirely.
    if (this.initial.length > 0) queueMicrotask(() => this.onChunk(this.initial));
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.conn.destroyed) return; // peer gone; drop
    const data = JSON.stringify(message) + "\n";
    await new Promise<void>((res, rej) => this.conn.write(data, (err) => (err ? rej(err) : res())));
  }

  async close(): Promise<void> {
    this.conn.destroy();
  }
}

/**
 * Listens on a Unix socket and hands each accepted connection to `onConnection`
 * as its own transport. The caller wires a fresh MCP server per connection, so
 * multiple Claude Code sessions (and background agents) can connect at once
 * without evicting one another.
 *
 * Before creating the transport, the listener peeks the connection's FIRST
 * line: a preamble line (see preamble.js) selects per-connection options (e.g.
 * code mode) and is consumed; any other first line — an old bridge, or a
 * direct client — is passed through to the transport untouched, so the
 * pre-preamble protocol keeps working byte-for-byte.
 */
export class UnixSocketListener {
  private server: net.Server | null = null;
  private conns = new Set<net.Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly onConnection: (transport: UnixSocketConnTransport, opts: ConnOptions) => void,
  ) {}

  // Accumulate data until the first newline, classify the first line, then
  // hand off. The peek handler detaches itself before the transport attaches
  // its own 'data' listener; bytes beyond the first line ride along as the
  // transport's `initial` buffer, so nothing is lost in the handoff.
  private peekThenHandoff(conn: net.Socket): void {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      conn.off("data", onData);
      // Detaching the peek handler leaves the socket flowing with no 'data'
      // listener — pause so bytes arriving before transport.start() re-attaches
      // one are buffered by the socket instead of discarded (start() resumes).
      conn.pause();
      const firstLine = buf.slice(0, nl).replace(/\r$/, "");
      const rest = buf.slice(nl + 1);
      const pre = parsePreamble(firstLine);
      const initial = pre !== null ? rest : buf;
      try {
        this.onConnection(new UnixSocketConnTransport(conn, initial), pre ?? { ...DEFAULT_CONN_OPTIONS });
      } catch (e) {
        // A failed server build must kill only this connection, not strand it
        // half-open (the bridge's reconnect loop handles the drop).
        console.error("[governor] connection handoff failed", e);
        conn.destroy();
      }
    };
    conn.setEncoding("utf8");
    conn.on("data", onData);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        reject(new Error("already listening"));
        return;
      }
      try { fs.unlinkSync(this.socketPath); } catch { /* none */ }
      const server = net.createServer((conn) => {
        // Track live connections so close() can drain them; net.Server.close()
        // alone waits for open sockets to end on their own (hangs on unload).
        this.conns.add(conn);
        conn.on("close", () => this.conns.delete(conn));
        // Guard the window before the transport attaches its own error handler,
        // so a connection error can't crash the whole socket server.
        conn.on("error", () => { /* surfaced again via the transport once started */ });
        this.peekThenHandoff(conn);
      });
      this.server = server;
      const onListenErr = (e: Error) => reject(e);
      server.once("error", onListenErr);
      server.listen(this.socketPath, () => {
        server.off("error", onListenErr);
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch (e) {
          // The socket file's permissions are the only auth boundary — never
          // stay listening world-readable. Stop the server, remove the
          // wrong-perms socket file, then reject.
          server.close();
          this.server = null;
          try { fs.unlinkSync(this.socketPath); } catch { /* none */ }
          reject(e as Error);
          return;
        }
        server.on("error", (e) => console.error("[governor] socket server error", e));
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    // Destroy live connections first so server.close() resolves promptly
    // instead of waiting for each peer to disconnect on its own.
    for (const conn of this.conns) conn.destroy();
    this.conns.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    // Defensive cleanup: some platforms don't auto-remove the socket file.
    try { fs.unlinkSync(this.socketPath); } catch { /* already gone */ }
  }
}
