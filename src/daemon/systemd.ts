import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  formatGatewayServiceDescription,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { resolveHomeDir } from "./paths.js";
import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
  type SystemdUserLingerStatus,
} from "./systemd-linger.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignment,
  parseSystemdExecStart,
} from "./systemd-unit.js";

const execFileAsync = promisify(execFile);
const toPosixPath = (value: string) => value.replace(/\\/g, "/");

export type SystemdScope = "user" | "system";

export function resolveSystemdScope(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SystemdScope {
  const raw = env.CLAWDBOT_SYSTEMD_SCOPE?.trim().toLowerCase();
  return raw === "system" ? "system" : "user";
}

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveSystemdUnitDir(
  env: Record<string, string | undefined>,
  scope: SystemdScope,
): string {
  if (scope === "system") {
    return path.posix.join(path.posix.sep, "etc", "systemd", "system");
  }
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user");
}

function resolveSystemdUnitPathForName(
  env: Record<string, string | undefined>,
  name: string,
  scope: SystemdScope,
): string {
  return path.posix.join(resolveSystemdUnitDir(env, scope), `${name}.service`);
}

function resolveSystemdServiceName(env: Record<string, string | undefined>): string {
  const override = env.CLAWDBOT_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
}

function resolveSystemdUnitPathForScope(
  env: Record<string, string | undefined>,
  scope: SystemdScope,
): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env), scope);
}

export function resolveSystemdUnitPath(
  env: Record<string, string | undefined>,
  scope: SystemdScope = "user",
): string {
  return resolveSystemdUnitPathForScope(env, scope);
}

export function resolveSystemdUserUnitPath(env: Record<string, string | undefined>): string {
  return resolveSystemdUnitPathForScope(env, "user");
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export type { SystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

export async function readSystemdServiceExecStart(
  env: Record<string, string | undefined>,
  options: { scope?: SystemdScope } = {},
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
} | null> {
  const scope = options.scope ?? resolveSystemdScope(env);
  const unitPath = resolveSystemdUnitPathForScope(env, scope);
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let execStart = "";
    let workingDirectory = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (line.startsWith("Environment=")) {
        const raw = line.slice("Environment=".length).trim();
        const parsed = parseSystemdEnvAssignment(raw);
        if (parsed) environment[parsed.key] = parsed.value;
      }
    }
    if (!execStart) return null;
    const programArguments = parseSystemdExecStart(execStart);
    return {
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

export type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) info.activeState = activeState;
  const subState = entries.substate;
  if (subState) info.subState = subState;
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = Number.parseInt(mainPidValue, 10);
    if (Number.isFinite(pid) && pid > 0) info.mainPid = pid;
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = Number.parseInt(execMainStatusValue, 10);
    if (Number.isFinite(status)) info.execMainStatus = status;
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) info.execMainCode = execMainCode;
  return info;
}

async function execSystemctl(
  args: string[],
  scope: SystemdScope,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const fullArgs = scope === "user" ? ["--user", ...args] : args;
    const { stdout, stderr } = await execFileAsync("systemctl", fullArgs, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function isSystemdServiceAvailable(scope: SystemdScope): Promise<boolean> {
  const res = await execSystemctl(["status"], scope);
  if (res.code === 0) return true;
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (!detail) return false;
  if (detail.includes("not found")) return false;
  if (detail.includes("failed to connect")) return false;
  if (detail.includes("not been booted")) return false;
  if (detail.includes("no such file or directory")) return false;
  if (detail.includes("not supported")) return false;
  return false;
}

export async function isSystemdUserServiceAvailable(): Promise<boolean> {
  return await isSystemdServiceAvailable("user");
}

async function assertSystemdAvailable(options: {
  env?: Record<string, string | undefined>;
  scope?: SystemdScope;
} = {}) {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const scope = options.scope ?? resolveSystemdScope(env);
  const res = await execSystemctl(["status"], scope);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  if (detail.toLowerCase().includes("not found")) {
    throw new Error("systemctl not available; systemd services are required on Linux.");
  }
  const label = scope === "user" ? "systemctl --user" : "systemctl";
  throw new Error(`${label} unavailable: ${detail || "unknown error"}`.trim());
}

export async function installSystemdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
}): Promise<{ unitPath: string }> {
  await assertSystemdAvailable({ env });
  const scope = resolveSystemdScope(env);

  const unitPath = resolveSystemdUnitPathForScope(env, scope);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  const serviceDescription =
    description ??
    formatGatewayServiceDescription({
      profile: env.CLAWDBOT_PROFILE,
      version: environment?.CLAWDBOT_SERVICE_VERSION ?? env.CLAWDBOT_SERVICE_VERSION,
    });
  const unit = buildSystemdUnit({
    description: serviceDescription,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(unitPath, unit, "utf8");

  const serviceName = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
  const unitName = `${serviceName}.service`;
  const reload = await execSystemctl(["daemon-reload"], scope);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
  }

  const enable = await execSystemctl(["enable", unitName], scope);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
  }

  const restart = await execSystemctl(["restart", unitName], scope);
  if (restart.code !== 0) {
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
  }

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  stdout.write("\n");
  stdout.write(`${formatLine("Installed systemd service", unitPath)}\n`);
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSystemdAvailable({ env });
  const scope = resolveSystemdScope(env);
  const serviceName = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
  const unitName = `${serviceName}.service`;
  await execSystemctl(["disable", "--now", unitName], scope);

  const unitPath = resolveSystemdUnitPathForScope(env, scope);
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

export async function stopSystemdService({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const resolvedEnv = env ?? {};
  await assertSystemdAvailable({ env: resolvedEnv });
  const scope = resolveSystemdScope(resolvedEnv);
  const serviceName = resolveSystemdServiceName(resolvedEnv);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(["stop", unitName], scope);
  if (res.code !== 0) {
    throw new Error(`systemctl stop failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped systemd service", unitName)}\n`);
}

export async function restartSystemdService({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const resolvedEnv = env ?? {};
  await assertSystemdAvailable({ env: resolvedEnv });
  const scope = resolveSystemdScope(resolvedEnv);
  const serviceName = resolveSystemdServiceName(resolvedEnv);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(["restart", unitName], scope);
  if (res.code !== 0) {
    throw new Error(`systemctl restart failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted systemd service", unitName)}\n`);
}

export async function isSystemdServiceEnabled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const env = args.env ?? {};
  const scope = resolveSystemdScope(env);
  const available = await isSystemdServiceAvailable(scope).catch(() => false);
  if (!available) return false;
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(["is-enabled", unitName], scope);
  return res.code === 0;
}

export async function readSystemdServiceRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const scope = resolveSystemdScope(env);
  try {
    await assertSystemdAvailable({ env, scope });
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(
    [
      "show",
      unitName,
      "--no-page",
      "--property",
      "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
    ],
    scope,
  );
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = detail.toLowerCase().includes("not found");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const activeState = parsed.activeState?.toLowerCase();
  const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
  return {
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
  };
}
export type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isSystemctlAvailable(): Promise<boolean> {
  const res = await execSystemctl(["status"], "user");
  if (res.code === 0) return true;
  const detail = `${res.stderr || res.stdout}`.toLowerCase();
  return !detail.includes("not found");
}

export async function findLegacySystemdUnits(
  env: Record<string, string | undefined>,
): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable();
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name, "user");
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctl(["is-enabled", `${name}.service`], "user");
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) return units;

  const systemctlAvailable = await isSystemctlAvailable();
  for (const unit of units) {
    if (systemctlAvailable) {
      await execSystemctl(["disable", "--now", `${unit.name}.service`], "user");
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
