import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { runCli } from "./cli.js";
import {
  renderService,
  serviceIdentity,
  servicePlatform,
  windowsArgument,
  type ServicePlatform,
} from "./service-definition.js";
import {
  makeService,
  parseServiceState,
  probeHealth,
  runCommand,
  type ServiceRuntime,
} from "./service.js";

const keys = JSON.stringify({
  version: 1,
  keychain: { nonce: "00".repeat(12), ciphertext: "00".repeat(32), tag: "00".repeat(16) },
});

const localPlatform = servicePlatform(process.platform);

async function fixture(platform: ServicePlatform) {
  const root = await mkdtemp(join(tmpdir(), "inbot-service-"));
  const home = join(root, "mail & home");
  await mkdir(home);
  await writeFile(join(home, "keys.json"), keys);
  await writeFile(join(home, "mail.db"), "Synthetic encrypted database");
  const calls: { program: string; args: readonly string[] }[] = [];
  const name = serviceIdentity({ platform, home, userHome: root }).name;
  let registered = false;
  let running = false;
  let fail = false;
  let startRunning = true;
  let unloadObservations = 0;
  let unloading: number | null = null;
  const runtime: ServiceRuntime = {
    platform,
    userHome: root,
    uid: 501,
    username: "synthetic-owner",
    executable: process.execPath,
    cli: fileURLToPath(new URL("./main.js", import.meta.url)),
    packaged: true,
    health: async (port) => port === 9123 && running,
    run: async (program, args) => {
      calls.push({ program, args });
      if (fail) return { code: 1, stdout: "", stderr: "Synthetic manager failure" };
      let stdout = "";
      let code = 0;
      if (args[0] === "print" && unloading !== null) {
        if (unloading === 0) {
          registered = false;
          unloading = null;
        } else unloading--;
      }
      const found =
        registered && args.some((value) => value === name || value.endsWith(`/${name}`));
      if (args[0] === "print") {
        stdout = found
          ? `state = ${running ? "running" : "waiting"}\n${running ? "pid = 123\n" : ""}`
          : "";
        code = found ? 0 : 113;
      } else if (args.includes("show")) {
        stdout = found
          ? `LoadState=loaded\nActiveState=${running ? "active" : "inactive"}\nSubState=${running ? "running" : "dead"}\n`
          : "LoadState=not-found\n";
        code = found ? 0 : 4;
      } else if (program === "powershell.exe")
        stdout = found ? (running ? "4\r\n" : "3\r\n") : "missing\r\n";
      else if (args.includes("bootout") || args.includes("disable") || args.includes("/Delete")) {
        unloading = args.includes("bootout") ? unloadObservations : null;
        registered = unloading !== null && unloading > 0;
        running = false;
      } else if (args.includes("/End")) running = false;
      else if (args.includes("bootstrap") || args.includes("--now") || args.includes("/Run")) {
        if (args.includes("bootstrap") && unloading !== null && unloading > 0)
          return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        registered = true;
        running = startRunning;
      } else if (args.includes("/Create")) registered = true;
      return { code, stdout, stderr: "" };
    },
  };
  return {
    root,
    home,
    calls,
    runtime,
    service: makeService(runtime, home),
    setUnloadObservations: (value: number) => {
      unloadObservations = value;
    },
    setFailure: (value: boolean) => {
      fail = value;
    },
    setStartRunning: (value: boolean) => {
      startRunning = value;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

for (const platform of ["darwin", "linux", "win32"] as const) {
  test.runIf(platform === localPlatform)(
    `${platform} installation rewrites and restarts, observes status, and uninstall retains home data`,
    async () => {
      const f = await fixture(platform);
      try {
        expect(await f.service.status()).toMatchObject({
          installed: false,
          running: false,
          port: null,
          http_healthy: false,
        });
        const installed = await f.service.install(9123);
        expect(installed).toMatchObject({
          installed: true,
          registered: true,
          running: true,
          state: "running",
          port: 9123,
          http_healthy: true,
        });
        expect(await readFile(installed.unit_path, "utf8")).toContain("InbotPort: 9123");
        if (process.platform !== "win32")
          expect((await stat(installed.stdout_log)).mode & 0o777).toBe(0o600);
        const restarted = await f.service.install(8025);
        expect(restarted).toMatchObject({ port: 8025, running: true, http_healthy: false });
        const starts = f.calls.filter(
          (call) =>
            call.args.includes("bootstrap") ||
            (call.args.includes("--now") && call.args.includes("enable")) ||
            call.args.includes("/Run"),
        );
        expect(starts).toHaveLength(2);
        expect(await f.service.uninstall()).toMatchObject({
          installed: false,
          running: false,
          port: null,
        });
        expect(await readFile(join(f.home, "keys.json"), "utf8")).toBe(keys);
        expect(await readFile(join(f.home, "mail.db"), "utf8")).toBe(
          "Synthetic encrypted database",
        );
        expect(await readFile(installed.stdout_log, "utf8")).toBe("");
        expect(await f.service.uninstall()).toMatchObject({ installed: false, running: false });
        expect(f.calls.every((call) => !call.program.includes(" "))).toBe(true);
        if (platform === "darwin")
          expect(f.calls).toContainEqual({
            program: "launchctl",
            args: ["bootstrap", "gui/501", installed.unit_path],
          });
        if (platform === "win32") {
          expect(f.calls).toContainEqual({
            program: "schtasks.exe",
            args: ["/Create", "/TN", installed.name, "/XML", installed.unit_path, "/F"],
          });
          await expect(readFile(`${installed.unit_path}.ps1`)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        await f.close();
      }
    },
  );
}

async function completeWithTimers<T>(operation: Promise<T>): Promise<T> {
  let settled = false;
  const [result] = await Promise.all([
    operation.finally(() => {
      settled = true;
    }),
    (async () => {
      await vi.waitUntil(() => settled || vi.getTimerCount() > 0);
      await vi.runAllTimersAsync();
    })(),
  ]);
  return result;
}

test.runIf(localPlatform === "darwin")(
  "reinstall waits for launchd removal before bootstrapping again",
  async () => {
    const f = await fixture("darwin");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      await f.service.install(9123);
      f.setUnloadObservations(2);
      await expect(completeWithTimers(f.service.install(9123))).resolves.toMatchObject({
        installed: true,
        registered: true,
        running: true,
        http_healthy: true,
      });
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

test.runIf(localPlatform === "darwin")(
  "uninstall JSON observes completed launchd removal and agrees with later status",
  async () => {
    const f = await fixture("darwin");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const installed = await f.service.install(9123);
      f.setUnloadObservations(2);
      let stdout = "";
      await expect(
        completeWithTimers(
          runCli(["service", "uninstall", "--home", f.home, "--json"], {
            env: {},
            serviceRuntime: f.runtime,
            stdout: (text) => {
              stdout += text;
            },
            stderr: () => {},
          }),
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        installed: false,
        registered: false,
        running: false,
        state: "stopped",
        port: null,
        http_healthy: false,
      });
      expect(JSON.parse(stdout)).toEqual(await f.service.status());
      await expect(readFile(installed.unit_path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.home, "keys.json"), "utf8")).toBe(keys);
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

test.runIf(localPlatform === "darwin").each(["install", "uninstall"] as const)(
  "%s times out when launchd keeps the old job and retains its definition",
  async (action) => {
    const f = await fixture("darwin");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const installed = await f.service.install(9123);
      f.setUnloadObservations(Infinity);
      await expect(
        completeWithTimers(action === "install" ? f.service.install(8031) : f.service.uninstall()),
      ).rejects.toMatchObject({
        exitCode: 10,
        detail: {
          code: "service_unavailable",
          message: "Timed out waiting for launchd removal. The service definition was retained.",
          fix: expect.stringContaining("may leave the service stopped"),
        },
      });
      expect(await readFile(installed.unit_path, "utf8")).toContain("InbotPort: 9123");
      expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
      expect(await f.service.status()).toMatchObject({
        installed: true,
        registered: true,
        running: false,
        http_healthy: false,
      });
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

test.runIf(localPlatform === "darwin")(
  "an unknown launchd observation after bootout prevents reinstall and retains the definition",
  async () => {
    const f = await fixture("darwin");
    try {
      const installed = await f.service.install(9123);
      const service = makeService(
        {
          ...f.runtime,
          run: async (program, args) => {
            const result = await f.runtime.run(program, args);
            if (args.includes("bootout")) f.setFailure(true);
            return result;
          },
        },
        f.home,
      );
      await expect(service.install(8031)).rejects.toMatchObject({
        exitCode: 10,
        detail: {
          code: "service_unavailable",
          message: "Cannot observe launchd removal. The service definition was retained.",
        },
      });
      expect(await readFile(installed.unit_path, "utf8")).toContain("InbotPort: 9123");
      expect(f.calls.filter((call) => call.args.includes("bootstrap"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test("failed manager observations stay unknown and prevent destructive uninstall", async () => {
  const f = await fixture(localPlatform);
  try {
    f.setStartRunning(false);
    const installed = await f.service.install(8025);
    expect(installed).toMatchObject({ running: false, state: "stopped", http_healthy: false });
    f.setFailure(true);
    expect(await f.service.status()).toMatchObject({
      installed: true,
      running: null,
      registered: null,
      state: "unknown",
    });
    await expect(f.service.uninstall()).rejects.toMatchObject({
      detail: { code: "service_unavailable" },
    });
    expect(await readFile(installed.unit_path, "utf8")).toContain("InbotPort: 8025");
  } finally {
    await f.close();
  }
});

test("install refuses uninitialized and passphrase-only homes or source checkouts without manager calls", async () => {
  const f = await fixture(localPlatform);
  try {
    await rm(join(f.home, "keys.json"));
    await expect(f.service.install(8025)).rejects.toMatchObject({
      detail: { code: "action_required" },
    });
    await writeFile(join(f.home, "keys.json"), "{}");
    await expect(f.service.install(8025)).rejects.toMatchObject({
      detail: { code: "action_required" },
    });
    await writeFile(
      join(f.home, "keys.json"),
      JSON.stringify({
        version: 1,
        passphrase: {
          wrapped: { nonce: "00".repeat(12), ciphertext: "00".repeat(32), tag: "00".repeat(16) },
          kdf: {
            algorithm: "argon2id",
            memory: 19456,
            passes: 2,
            parallelism: 1,
            salt: "00".repeat(16),
          },
        },
      }),
    );
    await expect(f.service.install(8025)).rejects.toMatchObject({
      detail: { code: "action_required" },
    });
    await expect(
      makeService({ ...f.runtime, packaged: false }, f.home).install(8025),
    ).rejects.toMatchObject({ detail: { code: "not_supported" } });
    expect(f.calls).toHaveLength(0);
    expect(() => makeService({ ...f.runtime, platform: "freebsd" }, f.home)).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ code: "not_supported" }) }),
    );
  } finally {
    await f.close();
  }
});

test("names distinguish development and custom homes while production gets the plain name", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const userHome = platform === "win32" ? "C:\\Users\\Owner" : "/users/owner";
    const separator = platform === "win32" ? "\\" : "/";
    const base = { platform, userHome };
    const plain = serviceIdentity({ ...base, home: `${userHome}${separator}.inbot` }).name;
    expect(plain).toBe(
      platform === "darwin" ? "dev.kerd.inbot" : platform === "linux" ? "inbot.service" : "Inbot",
    );
    const dev = serviceIdentity({ ...base, home: `${userHome}${separator}.inbot-dev` }).name;
    expect(dev).not.toBe(plain);
    expect(dev).toMatch(/-[a-f0-9]{16}/);
    expect(
      serviceIdentity({
        ...base,
        home: `${userHome}${separator}custom${separator}..${separator}.inbot-dev`,
      }).name,
    ).toBe(dev);
    if (platform === "win32")
      expect(serviceIdentity({ ...base, home: `${userHome.toUpperCase()}\\.INBOT` }).name).toBe(
        plain,
      );
  }
});

test.each([
  {
    platform: "darwin",
    home: "/users/owner/.inbot",
    userHome: "/users/owner",
    unitPath: "/users/owner/Library/LaunchAgents/dev.kerd.inbot.plist",
  },
  {
    platform: "linux",
    home: "/users/owner/.inbot",
    userHome: "/users/owner",
    unitPath: "/users/owner/.config/systemd/user/inbot.service",
  },
  {
    platform: "win32",
    home: "C:\\Users\\Owner\\.inbot",
    userHome: "C:\\Users\\Owner",
    unitPath: "C:\\Users\\Owner\\AppData\\Local\\Inbot\\services\\Inbot.xml",
  },
] as const)("$platform definition paths follow the target platform", ({ unitPath, ...input }) => {
  expect(serviceIdentity(input).unitPath).toBe(unitPath);
});

test("definitions preserve spaces and special characters without shell expansion or credentials", () => {
  const input = {
    home: '/users/Owner/mail & <box> "quoted" %n $HOME',
    userHome: "/users/Owner",
    executable: "/app & folder/node",
    cli: "/app & folder/cli.js",
    port: 8025,
    username: "Owner & Co",
  };
  const plist = renderService({ ...input, platform: "darwin" });
  expect(plist).toContain("mail &amp; &lt;box&gt; &quot;quoted&quot;");
  expect(plist).toContain("<string>--flavor</string><string>production</string>");
  expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  const unit = renderService({ ...input, platform: "linux" });
  expect(unit).toContain('ExecStart="/app & folder/node" "/app & folder/cli.js" "serve"');
  expect(unit).toContain('\\"quoted\\" %%n $$HOME');
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain(
    'StandardOutput=append:/users/Owner/mail & <box> "quoted" %%n $HOME/logs/service.log',
  );
  const task = renderService({
    ...input,
    platform: "win32",
    home: "C:\\Users\\Owner\\mail & box",
    userHome: "C:\\Users\\Owner",
    executable: "C:\\App Folder\\node.exe",
    cli: "C:\\App Folder\\main.js",
  });
  expect(task).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(task).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(task).toContain("<UserId>Owner &amp; Co</UserId>");
  expect(task).toContain("<RestartOnFailure>");
  for (const definition of [plist, unit, task])
    expect(definition).not.toMatch(/INBOT_API_KEY|EnvironmentVariables|Environment=|--init/);
  expect(windowsArgument("C:\\trailing\\")).toBe('"C:\\trailing\\\\"');
  expect(windowsArgument('a"b')).toBe('"a\\"b"');
  expect(() => renderService({ ...input, platform: "linux", home: "/bad\npath" })).toThrow();
  expect(() => renderService({ ...input, platform: "darwin", port: 0 })).toThrow();
});

test.each(["darwin", "linux", "win32"] as const)(
  "%s definitions reject relative paths and control characters in every path field",
  (platform) => {
    const input = {
      platform,
      home: platform === "win32" ? "C:\\Users\\Owner\\.inbot" : "/users/owner/.inbot",
      userHome: platform === "win32" ? "C:\\Users\\Owner" : "/users/owner",
      executable: platform === "win32" ? "C:\\app\\node.exe" : "/app/node",
      cli: platform === "win32" ? "C:\\app\\main.js" : "/app/main.js",
      port: 8025,
      username: "Owner",
    };
    for (const field of ["home", "userHome", "executable", "cli"] as const)
      for (const value of ["relative/path", `${input[field]}\n`, `${input[field]}\0`])
        expect(() => renderService({ ...input, [field]: value })).toThrowError(
          expect.objectContaining({
            detail: expect.objectContaining({ code: "validation_error" }),
          }),
        );
  },
);

test.each([
  {
    home: "C:\\Users\\Owner\\mail & box",
    argument: "C:\\Users\\Owner\\mail &amp; box",
    directory: "C:\\Users\\Owner\\mail &amp; box",
  },
  { home: "C:\\", argument: "C:\\\\", directory: "C:\\" },
  {
    home: "\\\\server\\mail & files\\",
    argument: "\\\\server\\mail &amp; files\\\\",
    directory: "\\\\server\\mail &amp; files\\",
  },
])(
  "Windows task launches the log host through headless conhost for $home",
  ({ home, argument, directory }) => {
    const task = renderService({
      platform: "win32",
      home,
      userHome: "C:\\Users\\Owner",
      executable: "C:\\App & Folder\\runtime\\node.exe",
      cli: "C:\\App & Folder\\application\\main.js",
      port: 8025,
      username: "Owner",
    });
    expect(task).toContain(
      '<Actions Context="Owner"><Exec>' +
        "<Command>%SystemRoot%\\System32\\conhost.exe</Command>" +
        "<Arguments>--headless &quot;C:\\App &amp; Folder\\runtime\\node.exe&quot; " +
        "&quot;C:\\App &amp; Folder\\application\\service-host.js&quot; " +
        "&quot;C:\\App &amp; Folder\\application\\main.js&quot; " +
        "&quot;serve&quot; &quot;--flavor&quot; &quot;production&quot; &quot;--home&quot; " +
        `&quot;${argument}&quot; &quot;--port&quot; &quot;8025&quot;</Arguments>` +
        `<WorkingDirectory>${directory}</WorkingDirectory></Exec></Actions>`,
    );
  },
);

test("status parsers distinguish registered stopped tasks from actual running processes", () => {
  const result = (stdout: string, code = 0) => ({ stdout, code, stderr: "" });
  expect(parseServiceState("darwin", result("state = running\npid = 111\n"))).toEqual({
    registered: true,
    running: true,
  });
  expect(parseServiceState("darwin", result("state = running\n"))).toEqual({
    registered: true,
    running: false,
  });
  expect(
    parseServiceState("linux", result("LoadState=loaded\nActiveState=active\nSubState=exited\n")),
  ).toEqual({ registered: true, running: false });
  expect(parseServiceState("win32", result("3\r\n"))).toEqual({ registered: true, running: false });
  expect(parseServiceState("win32", result("4\r\n"))).toEqual({ registered: true, running: true });
  expect(parseServiceState("win32", result("0\r\n"))).toEqual({ registered: true, running: null });
  expect(parseServiceState("win32", result("missing\r\n"))).toEqual({
    registered: false,
    running: false,
  });
  expect(parseServiceState("darwin", result(""))).toEqual({ registered: null, running: null });
  expect(parseServiceState("linux", result("LoadState=loaded\n"))).toEqual({
    registered: null,
    running: null,
  });
  expect(parseServiceState("win32", result("Running"))).toEqual({
    registered: null,
    running: null,
  });
});

test("CLI service commands validate flags, reject agent context, and use home precedence with JSON", async () => {
  const f = await fixture(localPlatform);
  try {
    const invoke = async (
      args: string[],
      env: Readonly<Record<string, string | undefined>> = {},
    ) => {
      let stdout = "";
      let stderr = "";
      const code = await runCli(args, {
        env,
        serviceRuntime: f.runtime,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      });
      return { code, stdout, stderr };
    };
    const installed = await invoke(
      ["--home", f.home, "service", "install", "--port", "9123", "--json"],
      { INBOT_HOME: join(f.root, "wrong") },
    );
    expect(installed.code).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      home: f.home,
      port: 9123,
      http_healthy: true,
    });
    expect(installed.stderr).toContain("Setup codes");
    expect(
      JSON.parse((await invoke(["service", "status", "--json"], { INBOT_HOME: f.home })).stdout),
    ).toMatchObject({ home: f.home, port: 9123 });
    expect(
      JSON.parse((await invoke(["service", "status", "--json", "--flavor", "production"])).stdout),
    ).toMatchObject({
      home: join(f.root, ".inbot"),
      name:
        localPlatform === "darwin"
          ? "dev.kerd.inbot"
          : localPlatform === "linux"
            ? "inbot.service"
            : "Inbot",
      installed: false,
    });
    expect(JSON.parse((await invoke(["service", "status", "--json"])).stdout)).toMatchObject({
      home: join(f.root, ".inbot-dev"),
    });
    for (const args of [
      ["service", "install", "--port", "0"],
      ["service", "install", "--port", "65536"],
      ["service", "install", "--port", "abc"],
      ["service", "status", "--port", "8025"],
      ["service", "status", "extra"],
      ["service", "status", "--flavor", "wrong"],
    ])
      expect((await invoke(args)).code).toBe(2);
    expect((await invoke(["service", "install"], { INBOT_API_KEY: "synthetic-key" })).code).toBe(4);
    expect(
      (await invoke(["service", "uninstall"], { INBOT_URL: "https://example.test" })).code,
    ).toBe(4);
    expect((await invoke(["service", "--help"])).stdout).toContain("service uninstall");
    expect((await invoke(["service", "install", "--help"])).stdout).toContain("--port");
    expect((await invoke(["service", "status", "--help"])).stdout).not.toContain("--port");
  } finally {
    await f.close();
  }
});

test("health probes require a valid Inbot owner status rather than any HTTP response", async () => {
  let payload: unknown = { setup_required: false, authenticated: false, locked: false };
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    expect(await probeHealth(address.port)).toBe(true);
    payload = { healthy: true };
    expect(await probeHealth(address.port)).toBe(false);
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

test("the Windows log host preserves arguments, appends logs, and propagates failure exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "inbot-service-host-"));
  try {
    await mkdir(join(root, "logs"));
    const cli = join(root, "synthetic cli.mjs");
    await writeFile(
      cli,
      'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("Synthetic failure"); process.exitCode = 17;',
    );
    const host = fileURLToPath(new URL("./service-host.ts", import.meta.url));
    for (let run = 0; run < 2; run++)
      expect(
        (
          await runCommand(process.execPath, [
            host,
            cli,
            "serve",
            "--flavor",
            "production",
            "--home",
            root,
            "--port",
            "8025",
          ])
        ).code,
      ).toBe(17);
    expect(await readFile(join(root, "logs", "service.log"), "utf8")).toBe(
      JSON.stringify(["serve", "--flavor", "production", "--home", root, "--port", "8025"]).repeat(
        2,
      ),
    );
    expect(await readFile(join(root, "logs", "service.err.log"), "utf8")).toBe(
      "Synthetic failureSynthetic failure",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
