import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { CliError, usage } from "./errors.js";

export type ServicePlatform = "darwin" | "linux" | "win32";

export function servicePlatform(platform: string): ServicePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new CliError(
    {
      code: "not_supported",
      message: "Background services are unsupported on this platform.",
      fix: "Run inbot serve in the foreground on this platform.",
    },
    9,
  );
}

export interface ServiceDefinition {
  readonly platform: ServicePlatform;
  readonly home: string;
  readonly userHome: string;
  readonly executable: string;
  readonly cli: string;
  readonly port: number;
  readonly username: string;
}

export function serviceIdentity(input: Pick<ServiceDefinition, "platform" | "home" | "userHome">) {
  const path = input.platform === "win32" ? win32 : posix;
  const canonical = (value: string) =>
    input.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const suffix =
    canonical(input.home) === canonical(path.join(input.userHome, ".inbot"))
      ? ""
      : `-${createHash("sha256").update(canonical(input.home)).digest("hex").slice(0, 16)}`;
  const name =
    input.platform === "darwin"
      ? `dev.kerd.inbot${suffix}`
      : input.platform === "linux"
        ? `inbot${suffix}.service`
        : `Inbot${suffix}`;
  const unitPath =
    input.platform === "darwin"
      ? path.join(input.userHome, "Library", "LaunchAgents", `${name}.plist`)
      : input.platform === "linux"
        ? path.join(input.userHome, ".config", "systemd", "user", name)
        : path.join(input.userHome, "AppData", "Local", "Inbot", "services", `${name}.xml`);
  return { name, unitPath };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function systemdArgument(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${escaped.replaceAll("$", () => "$$")}"`;
}

export function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function renderService(input: ServiceDefinition): string {
  const path = input.platform === "win32" ? win32 : posix;
  for (const value of [input.home, input.userHome, input.executable, input.cli]) {
    if (!path.isAbsolute(value) || hasControlCharacters(value))
      usage("Service paths must be absolute and contain no control characters.");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    usage("--port must be an integer from 1 to 65535.");
  if (!input.username || hasControlCharacters(input.username))
    usage("A local user identity is required.");
  const { name } = serviceIdentity(input);
  const host = path.join(path.dirname(input.cli), "service-host.js");
  const args = [
    input.cli,
    "serve",
    "--flavor",
    "production",
    "--home",
    input.home,
    "--port",
    String(input.port),
  ];
  const logs = path.join(input.home, "logs");
  const out = path.join(logs, "service.log");
  const err = path.join(logs, "service.err.log");
  if (input.platform === "darwin")
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- InbotPort: ${input.port} -->
<plist version="1.0"><dict>
<key>Label</key><string>${xml(name)}</string>
<key>ProgramArguments</key><array>${[input.executable, host, ...args].map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(input.home)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
</dict></plist>
`;
  if (input.platform === "linux")
    return `# InbotPort: ${input.port}
[Unit]
Description=Inbot owner mail service
[Service]
Type=simple
ExecStart=${[input.executable, host, ...args].map(systemdArgument).join(" ")}
WorkingDirectory=/
Restart=on-failure
RestartSec=10
UMask=0077
StandardOutput=append:${out.replaceAll("%", "%%")}
StandardError=append:${err.replaceAll("%", "%%")}
[Install]
WantedBy=default.target
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- InbotPort: ${input.port} -->
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(input.username)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Owner"><UserId>${xml(input.username)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure></Settings>
<Actions Context="Owner"><Exec><Command>%SystemRoot%\\System32\\conhost.exe</Command><Arguments>--headless ${xml([input.executable, host, ...args].map(windowsArgument).join(" "))}</Arguments><WorkingDirectory>${xml(input.home)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}
