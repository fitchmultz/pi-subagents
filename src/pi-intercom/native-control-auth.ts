import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { TLSSocket } from "node:tls";
import { loadControlPolicy } from "./bridge-config.ts";
import { getPiAgentDir } from "./agent-dir.ts";
import { fingerprint } from "./bridge-protocol.ts";

export function authenticatedCertificateChain(socket: Readonly<TLSSocket>): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  let cert = socket.getPeerCertificate(true);
  for (let depth = 0; depth < 8; depth += 1) {
    const parsed = new X509Certificate(cert.raw);
    if (seen.has(parsed.fingerprint256)) {
      break;
    }
    seen.add(parsed.fingerprint256);
    blocks.push(parsed.toString());
    cert = cert.issuerCertificate;
  }
  return blocks.join("\n");
}
function certificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > 8) {
    throw new Error("Invalid bounded certificate chain.");
  }
  return blocks.map((block) => new X509Certificate(block));
}
function validNow(cert: X509Certificate): boolean {
  return Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now();
}
function trustedChain(
  chain: readonly X509Certificate[],
  roots: readonly X509Certificate[],
): boolean {
  let current = chain.at(0);
  if (current === undefined || current.ca || !validNow(current)) {
    return false;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const subject: X509Certificate = current;
    const issuer: X509Certificate | undefined = [...roots, ...chain.slice(1)].find(
      (candidate) =>
        candidate.ca &&
        validNow(candidate) &&
        subject.checkIssued(candidate) &&
        subject.verify(candidate.publicKey),
    );
    if (!issuer) {
      return false;
    }
    if (roots.some((root) => root.fingerprint256 === issuer.fingerprint256)) {
      return true;
    }
    current = issuer;
  }
  return false;
}
function controlPolicyPath(): string {
  const configured = process.env.PI_INTERCOM_BRIDGE_CONFIG;
  if (configured !== undefined) {
    return configured;
  }
  const standard = join(getPiAgentDir(), "intercom", "bridge.json");
  return existsSync(standard) ? standard : join(homedir(), ".pi", "intercom-bridge", "config.json");
}
/** Unix broker peers are same-user trusted. Names/payload claims grant no authority. */
export function authorizedControlPeer(peerId: string, certificate: string): boolean {
  try {
    const configPath = controlPolicyPath();
    const config = loadControlPolicy(configPath);
    const chain = certificates(certificate);
    const client = chain.at(0);
    if (client === undefined) {
      return false;
    }
    const fp = fingerprint(client.fingerprint256);
    return (
      peerId === `remote-${fp.toLowerCase()}` &&
      config.clients.has(fp) &&
      trustedChain(chain, certificates(config.ca.toString("utf8")))
    );
  } catch {
    return false;
  }
}
