import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { Sandbox, SandboxNotFoundError } from "railway";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinuxDesktop } from "./linux-desktop.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";

vi.mock("railway", () => ({
  Sandbox: { create: vi.fn(), connect: vi.fn() },
  SandboxNotFoundError: class extends Error {},
}));

const ctx = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "sandbox",
  providerRef: "sandbox",
  kind: "railway",
  botId: "bot",
};
const provider = new RailwaySandboxProvider({ token: "test", environmentId: "environment" });
const sandbox = {
  id: "sandbox",
  domains: [{ port: 6080, domain: "screen.example.test" }],
  status: "RUNNING",
  destroy: vi.fn(),
  heartbeat: vi.fn(),
  exec: vi.fn(),
  files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(Sandbox.connect).mockResolvedValue(sandbox as unknown as Sandbox);
  vi.mocked(Sandbox.create).mockResolvedValue(sandbox as unknown as Sandbox);
});

describe("Railway computers", () => {
  it("reuses an existing computer without marking its workspace fresh", async () => {
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "sandbox", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ providerRef: "sandbox", fresh: false });
    expect(Sandbox.create).not.toHaveBeenCalled();
  });

  it("replaces a missing computer and requests portable home restoration", async () => {
    vi.mocked(Sandbox.connect).mockRejectedValue(
      new SandboxNotFoundError({ id: "missing", environmentId: "environment" }),
    );
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "missing", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ fresh: true, kind: "railway" });
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "environment", domains: [{ port: 6080 }] }),
    );
  });

  it.each(["DESTROYED", "DESTROYING", "FAILED"])("replaces a %s computer", async (status) => {
    vi.mocked(Sandbox.connect).mockResolvedValue({ ...sandbox, status } as unknown as Sandbox);
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "old", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ fresh: true });
    expect(Sandbox.create).toHaveBeenCalledOnce();
  });

  it("does not replace a computer on authentication or network errors", async () => {
    vi.mocked(Sandbox.connect).mockRejectedValue(new Error("unauthorized"));
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "sandbox", providerKind: "railway" },
        ctx,
      ),
    ).rejects.toThrow("unauthorized");
    expect(Sandbox.create).not.toHaveBeenCalled();
  });

  it("destroys a new computer if its caller cancels during creation", async () => {
    const controller = new AbortController();
    vi.mocked(Sandbox.create).mockImplementation(async () => {
      controller.abort();
      return sandbox as unknown as Sandbox;
    });
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused" },
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("preserves output and reports timeout as a nonzero exit", async () => {
    sandbox.exec.mockResolvedValue({
      stdout: "partial",
      stderr: "timeout",
      exitCode: null,
      timedOut: true,
    });
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "a; touch /tmp/unwanted"], cwd: "notes", timeoutMs: 5000 },
      ctx,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "partial" },
      { type: "stderr", data: "timeout" },
      { type: "exit", code: 124 },
    ]);
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining("'a; touch /tmp/unwanted'"),
      expect.objectContaining({ cwd: "/home/rakazo/notes", timeoutSec: 5 }),
    );
  });

  it("protects screen sockets with a per-screen token", async () => {
    sandbox.exec.mockResolvedValue({
      stdout: "RAKAZO_DESKTOP=0:screen-token",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      ctx,
    );
    if (!screen.url) throw new Error("missing screen URL");
    const url = new URL(screen.url);
    expect(url.origin).toBe("https://screen.example.test");
    expect(url.searchParams.get("path")).toBe("websockify?token=screen-token");
    expect(url.searchParams.has("token")).toBe(false);
  });

  it("rejects oversized files instead of returning truncated content", async () => {
    sandbox.files.read.mockResolvedValue(new Uint8Array(4));
    await expect(provider.readFile(computer, "file", ctx, { maxBytes: 3 })).rejects.toThrow(
      "exceeds 3 bytes",
    );
  });

  it("keeps binary data and executable permissions on writes", async () => {
    const content = Uint8Array.from([0, 255, 128]);
    await provider.writeFile(computer, { path: "bin/tool", content, executable: true }, ctx);
    expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/bin/tool", content, {
      mode: 0o700,
    });
  });

  it("rejects paths outside the workspace", async () => {
    await expect(provider.readFile(computer, "../../secret", ctx)).rejects.toThrow();
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it("exports regular binary files without following links or reading FIFOs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-railway-"));
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    try {
      await mkdir(path.join(directory, "bin"));
      const content = Uint8Array.from([0, 255, 128]);
      await writeFile(path.join(directory, "bin/tool"), content, { mode: 0o700 });
      await symlink("bin", path.join(directory, "linked-bin"));
      await promisify(execFile)("mkfifo", [path.join(directory, "pipe")]);
      sandbox.exec.mockImplementation(async (command: string) => {
        const result = await promisify(execFile)("bash", [
          "-c",
          command.replaceAll("/home/rakazo", directory),
        ]);
        return { ...result, exitCode: 0, timedOut: false };
      });
      sandbox.files.read.mockImplementation(
        async (filePath: string) =>
          new Uint8Array(await readFile(filePath.replace("/home/rakazo", directory))),
      );
      const exported = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
      expect(exported).toEqual([{ path: "bin/tool", content, executable: true }]);
    } finally {
      stopBrowsers.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows repeated destroy calls for an absent computer", async () => {
    vi.mocked(Sandbox.connect).mockRejectedValue(
      new SandboxNotFoundError({ id: "missing", environmentId: "environment" }),
    );
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    expect(await provider.isRunning(computer, ctx)).toBe(false);
  });
});
