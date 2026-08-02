// Shared Unix-socket test helpers. (Not a *.test.mjs file — the glob skips it.)
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

// Short socket paths under /tmp: macOS caps unix socket paths at 104 bytes,
// and os.tmpdir() can resolve to a long /var/folders/… prefix.
let sockCounter = 0;
export function tmpSock() {
  const dir = fs.mkdtempSync("/tmp/vmcp-");
  return path.join(dir, `${sockCounter++}.sock`);
}

export function connectTo(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

export function until(cond, what, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
