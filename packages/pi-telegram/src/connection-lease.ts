import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { SafeError } from "./config.ts";

const CONFLICT = 73;
// --no-fork leaves one tiny helper holding the kernel lock. EOF on its private stdin
// releases ownership when Pi exits, including SIGKILL. No PID files or stale leases.
const HOLD = 'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';

export class ConnectionLease {
  private constructor(private child: ReturnType<typeof spawn>, private closed: Promise<void>, private markReleased: () => void) {}

  static async acquire(directory: string, token: string, signal: AbortSignal, onLost: () => void): Promise<ConnectionLease> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Credential rotation must not create a second poller for the same Telegram bot.
    const identity = token.match(/^(\d+):/)?.[1] || token;
    const name = createHash("sha256").update(identity).digest("hex");
    const path = resolve(directory, `${name}.lock`);
    const file = await open(path, "a", 0o600);
    await file.close();
    signal.throwIfAborted();
    const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", String(CONFLICT), "--no-fork", path, process.execPath, "-e", HOLD], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    const closed = new Promise<void>(done => child.once("close", () => done()));
    // EPIPE is expected if the lock helper loses a race or is interrupted.
    child.stdin!.on("error", () => {});
    let ready = false;
    let released = false;
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new SafeError("Telegram connection lock timed out.")); }, 5000);
        let output = "";
        const finish = (error?: Error) => { clearTimeout(timeout); error ? reject(error) : done(); };
        child.once("error", () => finish(new SafeError("Telegram requires the host flock command; connection refused without an ownership lock.")));
        child.once("close", code => {
          if (!ready) finish(new SafeError(code === CONFLICT
            ? "Telegram is already owned by another Pi instance. Disconnect that instance first."
            : "Telegram connection lock was interrupted."));
          else if (!released) onLost();
        });
        child.stdout!.on("data", data => {
          output += data.toString();
          if (!ready && output.includes("locked\n")) { ready = true; finish(); }
        });
      });
      signal.throwIfAborted();
      return new ConnectionLease(child, closed, () => { released = true; });
    } catch (error) {
      released = true;
      child.kill();
      await closed;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async release(): Promise<void> {
    this.markReleased();
    if (!this.child.stdin!.writableEnded) this.child.stdin!.end();
    await this.closed;
  }
}
