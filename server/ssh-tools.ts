import { Client } from "ssh2";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createSdkMcpServer, tool } from "./agent-sdk.js";

const SSH_HOST_KEY = "ssh_host";
const SSH_PORT_KEY = "ssh_port";
const SSH_USERNAME_KEY = "ssh_username";
const SSH_AUTH_METHOD_KEY = "ssh_auth_method";
const SSH_PASSWORD_KEY = "ssh_password";
const SSH_PRIVATE_KEY_KEY = "ssh_private_key";

const SSH_SETTING_KEYS = [
  SSH_HOST_KEY,
  SSH_PORT_KEY,
  SSH_USERNAME_KEY,
  SSH_AUTH_METHOD_KEY,
  SSH_PASSWORD_KEY,
  SSH_PRIVATE_KEY_KEY,
] as const;

interface SshConfig {
  host: string | null;
  port: number | null;
  username: string | null;
  authMethod: string | null;
  password: string | null;
  privateKey: string | null;
}

async function getSshConfig(): Promise<SshConfig> {
  const raw = await convex.query(api.settings.getMany, {
    keys: [...SSH_SETTING_KEYS],
  });
  const portRaw = raw[SSH_PORT_KEY] ? parseInt(raw[SSH_PORT_KEY]!, 10) : null;
  return {
    host: raw[SSH_HOST_KEY] ?? null,
    port: portRaw && !isNaN(portRaw) ? portRaw : null,
    username: raw[SSH_USERNAME_KEY] ?? null,
    authMethod: raw[SSH_AUTH_METHOD_KEY] ?? null,
    password: raw[SSH_PASSWORD_KEY] ?? null,
    privateKey: raw[SSH_PRIVATE_KEY_KEY] ?? null,
  };
}

function execSsh(config: SshConfig, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };

    const timer = setTimeout(() => finish(new Error("SSH command timed out")), timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(err);
        stream.on("close", () => finish());
        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      });
    });

    conn.on("error", finish);

    conn.connect({
      host: config.host!,
      port: config.port ?? 22,
      username: config.username!,
      readyTimeout: Math.min(timeoutMs, 10000),
      ...(config.authMethod === "key" && config.privateKey
        ? { privateKey: config.privateKey }
        : {}),
      ...(config.authMethod === "password" && config.password
        ? { password: config.password }
        : {}),
    });
  });
}

function isConfigured(config: SshConfig): boolean {
  return Boolean(config.host && config.username);
}

export async function isSshConfigured(): Promise<boolean> {
  const config = await getSshConfig();
  return isConfigured(config);
}

export function createSshMcp() {
  return createSdkMcpServer({
    name: "boop-ssh",
    version: "0.1.0",
    tools: [
      tool(
        "ssh_exec",
        "Run a shell command on a remote server via SSH. The server credentials are configured through the settings UI. Use this for server management, file operations, deployments, or any remote command execution. Uses key-based auth (recommended) or password auth.",
        {
          command: z.string().describe("The shell command to execute on the remote server."),
          timeout: z.number().int().min(1).max(120).optional().default(30).describe("Command timeout in seconds."),
        },
        async ({ command, timeout }) => {
          const config = await getSshConfig();
          if (!isConfigured(config)) {
            return {
              content: [{ type: "text" as const, text: "SSH is not configured. Set up host, username, and auth in Settings first." }],
            };
          }
          const timeoutMs = (timeout ?? 30) * 1000;
          try {
            const result = await execSsh(config, command, timeoutMs);
            const output = result.stdout.trim();
            const errors = result.stderr.trim();
            const parts: string[] = [];
            if (output) parts.push(output);
            if (errors) parts.push(`[stderr]\n${errors}`);
            return {
              content: [{ type: "text" as const, text: parts.join("\n\n") || "(no output)" }],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `SSH command failed:\n${err instanceof Error ? err.message : String(err)}` }],
              is_error: true,
            };
          }
        },
      ),
      tool(
        "ssh_test",
        "Test the SSH connection by running a simple echo command. Returns connection status and latency info.",
        {
          timeout: z.number().int().min(1).max(30).optional().default(10).describe("Connection test timeout in seconds."),
        },
        async ({ timeout }) => {
          const config = await getSshConfig();
          if (!isConfigured(config)) {
            return {
              content: [{ type: "text" as const, text: "SSH is not configured. Set up host and username first." }],
              is_error: true,
            };
          }
          const timeoutMs = (timeout ?? 10) * 1000;
          const start = Date.now();
          try {
            await execSsh(config, "echo boop-ssh-ok", timeoutMs);
            const ms = Date.now() - start;
            return {
              content: [{ type: "text" as const, text: `SSH connection to ${config.username}@${config.host} succeeded in ${ms}ms.` }],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `SSH connection to ${config.username}@${config.host} failed:\n${err instanceof Error ? err.message : String(err)}` }],
              is_error: true,
            };
          }
        },
      ),
    ],
  });
}
