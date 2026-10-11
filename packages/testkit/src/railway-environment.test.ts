import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("RAILWAY_API_TOKEN", "test-token");
  vi.stubEnv("RAILWAY_PROJECT_ID", "project");
  vi.stubEnv("RAILWAY_SERVICE_ID", "app");
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "production");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reuses the sandbox environment without cloning application services", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      data: {
        project: {
          environments: { edges: [{ node: { id: "isolated", name: "sbx-app" } }] },
        },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await import("../../../infra/railway/sandbox-environment.mjs");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(process.stdout.write).toHaveBeenCalledWith("isolated");
});

it("creates an empty environment when absent", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { project: { environments: { edges: [] } } } }))
    .mockResolvedValueOnce(Response.json({ data: { environmentCreate: { id: "isolated" } } }));
  vi.stubGlobal("fetch", fetch);
  await import("../../../infra/railway/sandbox-environment.mjs");
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body).variables).toEqual({
    input: { name: "sbx-app", projectId: "project" },
  });
  expect(process.stdout.write).toHaveBeenCalledWith("isolated");
});

it("fails closed on API errors without disclosing the response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ errors: [{ message: "private details" }] })),
  );
  await expect(import("../../../infra/railway/sandbox-environment.mjs")).rejects.toThrow(
    "Railway environment setup failed",
  );
  expect(process.stdout.write).not.toHaveBeenCalled();
});

it("refuses the application's environment", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          project: {
            environments: {
              edges: [{ node: { id: "production", name: "sbx-app" } }],
            },
          },
        },
      }),
    ),
  );
  await expect(import("../../../infra/railway/sandbox-environment.mjs")).rejects.toThrow(
    "must be separate",
  );
  expect(process.stdout.write).not.toHaveBeenCalled();
});
