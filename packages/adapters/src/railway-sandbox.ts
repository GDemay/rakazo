import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { Sandbox, SandboxNotFoundError } from "railway";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";

const WORKSPACE = "/home/rakazo";
const SCREEN_PORT = 6080;

export interface RailwaySandboxOptions {
  token: string;
  environmentId: string;
}

export class RailwaySandboxProvider implements SandboxProvider {
  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: WORKSPACE,
      workspaceDir: WORKSPACE,
      browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
      displayStart: 1,
      portStart: SCREEN_PORT,
    }),
    run: async (computer, command, context) => {
      const result = await this.run(computer, command, context);
      return { code: result.timedOut ? 124 : (result.exitCode ?? 1), ...result };
    },
    screenUrl: async (computer, port, context) => {
      const sandbox = await this.connect(computer, context);
      const domain = sandbox.domains.find((entry) => entry.port === port);
      if (!domain) throw new Error("Railway computer has no screen domain");
      return `https://${domain.domain}/vnc.html`;
    },
  });

  constructor(private readonly options: RailwaySandboxOptions) {}

  describe() {
    return {
      id: "railway",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: false,
        multiScreen: true,
      },
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    context.signal.throwIfAborted();
    if (request.providerRef && request.providerKind === "railway") {
      try {
        const sandbox = await Sandbox.connect(request.providerRef, this.options);
        if (sandbox.status === "RUNNING") {
          return this.ref(sandbox.id, request.botId, false);
        }
        if (sandbox.status === "CREATING") throw new Error("Railway computer is still starting");
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    }
    const sandbox = await Sandbox.create({
      ...this.options,
      networkIsolation: "PRIVATE",
      domains: [{ port: SCREEN_PORT }],
    });
    if (context.signal.aborted) {
      await sandbox.destroy();
      context.signal.throwIfAborted();
    }
    return this.ref(sandbox.id, request.botId, true);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    try {
      return (await this.connect(computer, context)).status === "RUNNING";
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.checked(computer, PREPARE_RAILWAY_DESKTOP, context, 300_000);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    try {
      const sandbox = await this.connect(computer, context);
      const result = await sandbox.exec(sandboxCommandArgv(request).map(shellQuote).join(" "), {
        cwd: railwayCwd(request.cwd),
        env: request.env,
        timeoutSec: boundedSandboxCommandTimeoutMs(request.timeoutMs) / 1_000,
        signal: context.signal,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.timedOut ? 124 : (result.exitCode ?? 1) };
    } catch (error) {
      if (!context.signal.aborted) throw error;
      yield { type: "stderr", data: "command aborted\n" };
      yield { type: "exit", code: 130 };
    }
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.desktops.connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, context);
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.desktops.sendInput(computer, input, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return this.desktops.observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.desktops.releaseScreen(computer, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const sandbox = await this.connect(computer, context);
    const relative = normalizeWorkspacePath(directory);
    const entries = await sandbox.files.list(workspacePath(WORKSPACE, relative));
    return entries.map((entry) => ({
      path: normalizeWorkspacePath(path.posix.join(relative, entry.name)),
      kind: entry.isDir ? "dir" : "file",
      size: entry.size,
      ...(!entry.isDir && (entry.mode & 0o111) !== 0 ? { executable: true } : {}),
    }));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const sandbox = await this.connect(computer, context);
    const content = await sandbox.files.read(workspacePath(WORKSPACE, filePath), {
      format: "bytes",
      ...(options?.maxBytes === undefined ? {} : { length: options.maxBytes + 1 }),
    });
    if (options?.maxBytes !== undefined && content.byteLength > options.maxBytes) {
      throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
    }
    return content;
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const sandbox = await this.connect(computer, context);
    await sandbox.files.write(workspacePath(WORKSPACE, file.path), file.content, {
      mode: file.executable ? 0o700 : 0o600,
    });
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    await this.desktops.stopBrowsers(computer, context);
    const result = await this.run(
      computer,
      [
        "set -euo pipefail",
        `cd ${shellQuote(WORKSPACE)}`,
        'find . -type f -print0 | while IFS= read -r -d "" entry; do',
        '  if [ -x "$entry" ]; then mode=700; else mode=600; fi',
        `  printf '%s\\0%s\\0' "\${entry#./}" "$mode"`,
        "done",
      ].join("\n"),
      context,
    );
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error("could not list Railway workspace");
    const entries = result.stdout.split("\0");
    const sandbox = await this.connect(computer, context);
    const files: Array<{ path: string; executable: boolean }> = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const filePath = entries[index];
      const mode = entries[index + 1];
      if (!filePath || !mode || shouldSkipPortableWorkspaceFile(filePath)) continue;
      files.push({
        path: filePath,
        executable: (Number.parseInt(mode, 8) & 0o111) !== 0,
      });
    }
    for (let index = 0; index < files.length; index += 8) {
      context.signal.throwIfAborted();
      const batch = await Promise.all(
        files.slice(index, index + 8).map(async (file) => ({
          ...file,
          content: await sandbox.files.read(workspacePath(WORKSPACE, file.path), {
            format: "bytes",
          }),
        })),
      );
      for (const file of batch) yield file;
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    await this.desktops.stopBrowsers(computer, context);
    const sandbox = await this.connect(computer, context);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      context.signal.throwIfAborted();
      await Promise.all(
        batch.map((file) =>
          sandbox.files.write(workspacePath(WORKSPACE, file.path), file.content, {
            mode: file.executable ? 0o700 : 0o600,
          }),
        ),
      );
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      context.signal.throwIfAborted();
      if (batch.length >= 8 || batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES)
        await flush();
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef) {
    const sandbox = await Sandbox.connect(computer.providerRef, this.options);
    await sandbox.heartbeat();
  }

  async stop(computer: ComputerRef, context: AdapterContext) {
    // Railway has no suspend operation. Core checkpoints the portable home before stopping.
    await this.destroy(computer, context);
  }

  async destroy(computer: ComputerRef, context: AdapterContext) {
    try {
      const sandbox = await this.connect(computer, context);
      await sandbox.destroy();
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
  }

  private async connect(computer: ComputerRef, context: AdapterContext) {
    context.signal.throwIfAborted();
    return Sandbox.connect(computer.providerRef, this.options);
  }

  private async run(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
    timeoutMs = 120_000,
  ) {
    const sandbox = await this.connect(computer, context);
    return sandbox.exec(`bash -c ${shellQuote(command)}`, {
      timeoutSec: timeoutMs / 1_000,
      signal: context.signal,
    });
  }

  private async checked(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
    timeoutMs: number,
  ) {
    const result = await this.run(computer, command, context, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(result.stderr || "could not prepare Railway computer");
    }
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "railway", providerRef: id, fresh };
  }
}

function railwayCwd(cwd: string | undefined) {
  if (!cwd || cwd === "." || cwd === "/" || cwd === WORKSPACE) return WORKSPACE;
  return workspacePath(
    WORKSPACE,
    cwd.startsWith(`${WORKSPACE}/`) ? cwd.slice(WORKSPACE.length + 1) : cwd,
  );
}

const PREPARE_RAILWAY_DESKTOP = [
  "set -eu",
  "exec 9>/tmp/rakazo-prepare.lock; flock -w 300 9",
  PREPARE_LINUX_DESKTOP,
  "if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then",
  '  if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  "  package=$(mktemp /tmp/rakazo-chrome-XXXXXX.deb)",
  "  trap 'rm -f \"$package\"' EXIT",
  '  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$package"',
  '  $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$package"',
  "fi",
  `mkdir -p ${WORKSPACE}/.browser-profiles`,
].join("\n");
