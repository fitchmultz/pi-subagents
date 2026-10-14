#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function help() {
  console.log(`Usage: node scripts/intercom-bridge-credentials.mjs <init|issue|revoke|renew-server> DIR [NAME] [--cwd PATH] [--port N] [--days N]

init    Create a new private CA, loopback server certificate and grok-bot credential.
issue   Issue a fresh client certificate; preserve local identity policies.
revoke  Remove the named client from the allowlist. Does not delete saved credentials.
renew-server  Renew the loopback server key/certificate using the same CA; preserve clients.

Options: --cwd PATH  Local project identity for init/issue (default: current directory)
         --port N    Loopback bridge port for init (default: 9443)
         --days N    Certificate validity (1–3650; client default: 7, renew-server: 365)
         -h, --help  Show help
Environment: OPENSSL  OpenSSL executable (default: openssl; requires -addext support)

Examples:
  node scripts/intercom-bridge-credentials.mjs init ~/.pi/intercom-bridge --cwd "$PWD"
  node scripts/intercom-bridge-credentials.mjs issue ~/.pi/intercom-bridge grok-bot
  node scripts/intercom-bridge-credentials.mjs revoke ~/.pi/intercom-bridge grok-bot

After issue/revoke, send SIGHUP to the helper PID to activate the allowlist.
After renew-server, restart only the helper; existing client credentials remain valid.
Rotation/revocation stops that identity's helper-launched Pi children; journals remain.
Concurrent credential commands fail rather than overwrite each other's authorization.
After a crashed command, inspect DIR/.credentials.lock/owner and remove that lock
only after confirming its process has stopped.
Exit: 0 success, 1 filesystem/OpenSSL failure, 2 invalid arguments.
Never transfer ca.key or server.key to the remote host.`);
}

function privatePath(path, directory = false) {
  const st = lstatSync(path);
  if (
    st.isSymbolicLink() ||
    !(directory ? st.isDirectory() : st.isFile()) ||
    st.uid !== process.getuid() ||
    st.mode & 0o077
  ) {
    throw new Error(`Expected an owned, private ${directory ? "directory" : "file"}: ${path}`);
  }
}

function atomicConfig(path, config) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function openssl(...args) {
  execFileSync(process.env.OPENSSL || "openssl", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
}

function key(path) {
  openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", path);
  privatePath(path);
}

function issueCertificate(dir, stem, name, { server = false, days = 7 } = {}) {
  const keyPath = join(dir, `${stem}.key`);
  const certPath = join(dir, `${stem}.crt`);
  const csrPath = join(dir, `${stem}.csr`);
  const extPath = join(dir, `${stem}.ext`);
  key(keyPath);
  try {
    openssl("req", "-new", "-key", keyPath, "-subj", `/CN=${name}`, "-out", csrPath);
    writeFileSync(
      extPath,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${server ? "serverAuth" : "clientAuth"}\n${server ? "subjectAltName=DNS:localhost,IP:127.0.0.1\n" : ""}`,
      { mode: 0o600, flag: "wx" },
    );
    openssl(
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      join(dir, "ca.crt"),
      "-CAkey",
      join(dir, "ca.key"),
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      String(days),
      "-sha256",
      "-extfile",
      extPath,
      "-out",
      certPath,
    );
  } finally {
    rmSync(csrPath, { force: true });
    rmSync(extPath, { force: true });
  }
  const cert = new X509Certificate(readFileSync(certPath));
  return {
    cert: certPath,
    key: keyPath,
    fingerprint256: cert.fingerprint256,
    expires: cert.validTo,
  };
}

function readConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(config) || !Array.isArray(config.clients) || typeof config.ca !== "string") {
    throw new Error("Invalid clients allowlist.");
  }
  const clients = config.clients.map((client) => {
    if (
      !isRecord(client) ||
      typeof client.name !== "string" ||
      typeof client.cwd !== "string" ||
      typeof client.fingerprint256 !== "string"
    ) {
      throw new Error("Invalid client identity.");
    }
    return { ...client, name: client.name, cwd: client.cwd, fingerprint256: client.fingerprint256 };
  });
  return { ...config, ca: config.ca, clients };
}

let args;
let port;
let certificateDays;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      cwd: { type: "string" },
      port: { type: "string" },
      days: { type: "string" },
    },
  });
  if (args.values.help) {
    help();
    process.exit(0);
  }
  const [action, dir, name] = args.positionals;
  port = args.values.port === undefined ? 9443 : Number(args.values.port);
  const defaultDays = action === "renew-server" ? 365 : 7;
  certificateDays = args.values.days === undefined ? defaultDays : Number(args.values.days);
  if (
    !["init", "issue", "revoke", "renew-server"].includes(action) ||
    !dir ||
    args.positionals.length > 3 ||
    (["issue", "revoke"].includes(action) && !name) ||
    (action === "renew-server" && (name || args.values.cwd)) ||
    (name && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) ||
    (action === "revoke" && (args.values.cwd || args.values.days)) ||
    (action !== "init" && args.values.port !== undefined) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isInteger(certificateDays) ||
    certificateDays < 1 ||
    certificateDays > 3650
  ) {
    throw new Error("Invalid arguments; use --help.");
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exit(2);
}

let lock;
try {
  process.umask(0o077);
  const [action, rawDir, suppliedName] = args.positionals;
  const dir = resolve(rawDir);
  const name = suppliedName || "grok-bot";
  const configPath = join(dir, "config.json");
  let config;
  if (action === "init") {
    // Never overwrite a CA.
    mkdirSync(dir, { mode: 0o700 });
  }
  privatePath(dir, true);
  const lockPath = join(dir, ".credentials.lock");
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Another credential command holds ${lockPath}; inspect its owner before retrying.`,
        { cause: error },
      );
    }
    throw error;
  }
  lock = lockPath;
  writeFileSync(join(lock, "owner"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  if (action === "init") {
    key(join(dir, "ca.key"));
    openssl(
      "req",
      "-new",
      "-x509",
      "-key",
      join(dir, "ca.key"),
      "-days",
      "3650",
      "-sha256",
      "-subj",
      "/CN=Pi Intercom Bridge CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-out",
      join(dir, "ca.crt"),
    );
    const server = issueCertificate(dir, "server", "localhost", { server: true, days: 365 });
    config = {
      port,
      ca: join(dir, "ca.crt"),
      cert: server.cert,
      key: server.key,
      clients: [],
    };
  } else {
    privatePath(dir, true);
    privatePath(configPath);
    config = readConfig(configPath);
  }
  if (action === "revoke") {
    if (!config.clients.some((client) => client.name === name)) {
      throw new Error(`No authorized client named ${name}.`);
    }
    config.clients = config.clients.filter((client) => client.name !== name);
    atomicConfig(configPath, config);
    console.log(
      JSON.stringify({ revoked: name, config: configPath, next: "Send SIGHUP to the helper PID." }),
    );
  } else if (action === "renew-server") {
    privatePath(join(dir, "ca.key"));
    const server = issueCertificate(dir, `server-${randomBytes(8).toString("hex")}`, "localhost", {
      server: true,
      days: certificateDays,
    });
    config.cert = server.cert;
    config.key = server.key;
    atomicConfig(configPath, config);
    console.log(
      JSON.stringify({
        renewed: "server",
        ...server,
        ca: config.ca,
        config: configPath,
        next: "Restart only this helper; client keys and CA are unchanged.",
      }),
    );
  } else {
    privatePath(join(dir, "ca.key"));
    const credential = issueCertificate(dir, `${name}-${randomBytes(8).toString("hex")}`, name, {
      days: certificateDays,
    });
    const previous = config.clients.find((client) => client.name === name);
    config.clients = config.clients.filter((client) => client.name !== name);
    config.clients.push({
      ...previous,
      fingerprint256: credential.fingerprint256,
      name,
      cwd: resolve(args.values.cwd || previous?.cwd || process.cwd()),
    });
    atomicConfig(configPath, config);
    console.log(
      JSON.stringify({
        name,
        ...credential,
        ca: config.ca,
        config: configPath,
        next: "Transfer only client cert/key and ca.crt; reload helper allowlist with SIGHUP.",
      }),
    );
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  if (lock) {
    rmSync(join(lock, "owner"), { force: true });
    rmdirSync(lock);
  }
}
