/**
 * Live notebook execution: a persistent IPython kernel per (user, notebook),
 * so cells share state the way a real notebook does — imports and variables
 * from one cell are visible in the next. The heavy lifting is a small Python
 * host (below) that drives a kernel via `jupyter_client` and speaks one JSON
 * line per message over stdio; this module spawns one host per kernel, serialises
 * cell executions onto it, and reaps kernels that go idle.
 *
 * It is deliberately outside the Effect RPC/service graph: it is process and
 * timer state that must outlive any one request, reached only through the
 * authenticated `/api/notebook/*` routes.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";

/** nbformat-shaped output as the kernel host emits it. */
export interface KernelOutput {
  readonly output_type: string;
  readonly [key: string]: unknown;
}
export interface KernelExecuteResult {
  readonly executionCount: number | null;
  readonly outputs: readonly KernelOutput[];
}

const IDLE_KERNEL_MS = 15 * 60 * 1000;
const CELL_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;

const KERNEL_HOST_PY = String.raw`
import sys, json, queue
try:
    from jupyter_client.manager import start_new_kernel
except Exception as exc:  # jupyter not installed
    sys.stdout.write(json.dumps({"op": "fatal", "error": "jupyter_client/ipykernel not installed: %s" % exc}) + "\n")
    sys.stdout.flush()
    sys.exit(1)

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

cwd = sys.argv[1] if len(sys.argv) > 1 else None
try:
    km, kc = start_new_kernel(kernel_name="python3", cwd=cwd)
except Exception as exc:
    emit({"op": "fatal", "error": "could not start kernel: %s" % exc})
    sys.exit(1)
emit({"op": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    op = req.get("op")
    if op == "shutdown":
        break
    if op == "interrupt":
        try:
            km.interrupt_kernel()
        except Exception:
            pass
        continue
    if op != "execute":
        continue
    code = req.get("code", "")
    outputs = []
    execution_count = None
    try:
        msg_id = kc.execute(code, store_history=True)
    except Exception as exc:
        emit({"op": "result", "execution_count": None,
              "outputs": [{"output_type": "error", "ename": "ExecuteError", "evalue": str(exc), "traceback": [str(exc)]}]})
        continue
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=req.get("timeout", 120))
        except queue.Empty:
            outputs.append({"output_type": "error", "ename": "Timeout", "evalue": "Cell timed out", "traceback": ["Cell timed out"]})
            break
        if msg.get("parent_header", {}).get("msg_id") != msg_id:
            continue
        mt = msg.get("msg_type")
        c = msg.get("content", {})
        if mt == "stream":
            outputs.append({"output_type": "stream", "name": c.get("name", "stdout"), "text": c.get("text", "")})
        elif mt in ("execute_result", "display_data"):
            outputs.append({"output_type": mt, "data": c.get("data", {}), "metadata": c.get("metadata", {}), "execution_count": c.get("execution_count")})
            if c.get("execution_count") is not None:
                execution_count = c.get("execution_count")
        elif mt == "error":
            outputs.append({"output_type": "error", "ename": c.get("ename", ""), "evalue": c.get("evalue", ""), "traceback": c.get("traceback", [])})
        elif mt == "execute_input":
            if c.get("execution_count") is not None:
                execution_count = c.get("execution_count")
        elif mt == "status" and c.get("execution_state") == "idle":
            break
    emit({"op": "result", "execution_count": execution_count, "outputs": outputs})

try:
    km.shutdown_kernel(now=True)
except Exception:
    pass
`;

let hostScriptPath: string | null = null;
function ensureHostScript(): string {
  if (hostScriptPath) return hostScriptPath;
  const dir = mkdtempSync(path.join(tmpdir(), "t3-nbkernel-"));
  const file = path.join(dir, "kernel_host.py");
  writeFileSync(file, KERNEL_HOST_PY, { mode: 0o600 });
  hostScriptPath = file;
  return file;
}

interface Kernel {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  ready: Promise<void>;
  /** Serialises executes so one cell finishes before the next starts. */
  chain: Promise<unknown>;
  lastUsed: number;
  pendingResult: ((result: KernelExecuteResult) => void) | null;
  fatal: string | null;
}

const kernels = new Map<string, Kernel>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, kernel] of kernels) {
      if (now - kernel.lastUsed > IDLE_KERNEL_MS) {
        disposeKernel(id);
      }
    }
  }, 60_000);
  // Do not keep the process alive just for the sweeper.
  sweeper.unref?.();
}

function disposeKernel(id: string): void {
  const kernel = kernels.get(id);
  if (!kernel) return;
  kernels.delete(id);
  try {
    kernel.proc.stdin.write(`${JSON.stringify({ op: "shutdown" })}\n`);
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (!kernel.proc.killed) kernel.proc.kill("SIGKILL");
  }, 2_000).unref?.();
}

function spawnKernel(id: string, cwd: string): Kernel {
  const proc = spawn("python3", [ensureHostScript(), cwd], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const kernel: Kernel = {
    proc,
    cwd,
    ready: Promise.resolve(),
    chain: Promise.resolve(),
    lastUsed: Date.now(),
    pendingResult: null,
    fatal: null,
  };
  kernel.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Kernel did not start in time")), READY_TIMEOUT_MS);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg["op"] === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (msg["op"] === "fatal") {
        kernel.fatal = typeof msg["error"] === "string" ? (msg["error"] as string) : "kernel error";
        clearTimeout(timer);
        reject(new Error(kernel.fatal));
      } else if (msg["op"] === "result") {
        const cb = kernel.pendingResult;
        kernel.pendingResult = null;
        cb?.({
          executionCount: typeof msg["execution_count"] === "number" ? (msg["execution_count"] as number) : null,
          outputs: Array.isArray(msg["outputs"]) ? (msg["outputs"] as KernelOutput[]) : [],
        });
      }
    });
  });
  proc.on("exit", () => {
    kernels.delete(id);
    kernel.pendingResult?.({
      executionCount: null,
      outputs: [{ output_type: "error", ename: "KernelExited", evalue: "The kernel stopped.", traceback: ["The kernel stopped."] }],
    });
    kernel.pendingResult = null;
  });
  proc.stderr.on("data", () => {
    // kernel chatter; ignored (errors surface as cell outputs)
  });
  kernels.set(id, kernel);
  startSweeper();
  return kernel;
}

/** Runs one cell on the kernel for `id`, spawning it (in `cwd`) on first use. */
export async function executeCell(id: string, cwd: string, code: string): Promise<KernelExecuteResult> {
  let kernel = kernels.get(id);
  if (kernel && kernel.cwd !== cwd) {
    // The notebook moved projects; start a clean kernel in the new directory.
    disposeKernel(id);
    kernel = undefined;
  }
  if (!kernel) {
    kernel = spawnKernel(id, cwd);
  }
  const current = kernel;
  const run = current.chain.then(async () => {
    await current.ready;
    current.lastUsed = Date.now();
    return await new Promise<KernelExecuteResult>((resolve) => {
      current.pendingResult = resolve;
      const timeout = setTimeout(() => {
        if (current.pendingResult) {
          const cb = current.pendingResult;
          current.pendingResult = null;
          cb({
            executionCount: null,
            outputs: [{ output_type: "error", ename: "Timeout", evalue: "Cell timed out", traceback: ["Cell timed out"] }],
          });
        }
      }, CELL_TIMEOUT_MS + 5_000);
      const settle = (result: KernelExecuteResult) => {
        clearTimeout(timeout);
        current.lastUsed = Date.now();
        resolve(result);
      };
      current.pendingResult = settle;
      try {
        current.proc.stdin.write(`${JSON.stringify({ op: "execute", code, timeout: CELL_TIMEOUT_MS / 1000 })}\n`);
      } catch {
        settle({
          executionCount: null,
          outputs: [{ output_type: "error", ename: "KernelWriteError", evalue: "Could not reach the kernel.", traceback: [] }],
        });
      }
    });
  });
  current.chain = run.catch(() => undefined);
  return run;
}

export function restartKernel(id: string): void {
  disposeKernel(id);
}
