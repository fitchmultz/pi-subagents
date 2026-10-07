import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { execute } from "./protected-macos-transport.mjs";

function networkAddress(address, prefix) {
  assert.ok(Number.isInteger(prefix) && prefix >= 0 && prefix <= 32);
  const number = address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (number & mask) >>> 0;
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".")}/${prefix}`;
}
function destination(token, flags) {
  const [short, suffix, extra] = token.split("/");
  assert.equal(extra, undefined, `Unresolved BSD destination: ${token}`);
  const octets = short.split(".");
  assert.ok(
    octets.length >= 1 &&
      octets.length <= 4 &&
      octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255),
    `Unresolved BSD destination: ${token}`,
  );
  const expanded = [...octets, ...Array(4 - octets.length).fill("0")].join(".");
  const implicit = flags.includes("H") ? 32 : octets.length * 8;
  const prefix = suffix === undefined ? implicit : Number(suffix);
  assert.ok(suffix === undefined || /^\d{1,2}$/.test(suffix), `Unresolved BSD prefix: ${token}`);
  return networkAddress(expanded, prefix);
}
function interfaceDestinations(interfaces) {
  const addresses = [];
  const ipv4Interfaces = new Set();
  let current;
  for (const line of interfaces.split("\n")) {
    const header = /^([A-Za-z0-9_.-]+): flags=/.exec(line);
    if (header) {
      current = header[1];
    }
    if (!/^\s*inet\s/.test(line)) {
      continue;
    }
    const match = /^\s*inet (\S+)(?: --> (\S+))? netmask (0x[\da-fA-F]+)/.exec(line);
    assert.ok(match && isIPv4(match[1]), `Unresolved IPv4 interface: ${line}`);
    const mask = Number(match[3]);
    const bits = mask.toString(2).padStart(32, "0");
    assert.match(bits, /^1*0*$/, "Noncontiguous interface mask");
    if (current) {
      ipv4Interfaces.add(current);
    }
    if (!match[1].startsWith("127.")) {
      addresses.push(networkAddress(match[1], bits.indexOf("0") === -1 ? 32 : bits.indexOf("0")));
    }
    if (match[2]) {
      assert.ok(isIPv4(match[2]));
      addresses.push(`${match[2]}/32`);
    }
  }
  return { addresses, ipv4Interfaces };
}
function defaultDestination(route, interfaces) {
  if (isIPv4(route.gateway)) {
    return `${route.gateway}/32`;
  }
  // Scoped on-link defaults have no distinct gateway address. Their actual
  // interface subnet/local/PTP peer must have entered the blocked inventory.
  assert.match(route.gateway, /^link#[1-9][0-9]*$/);
  assert.ok(
    route.flags.includes("I") && !route.flags.includes("G") && interfaces.has(route.netif),
    "Unresolved scoped default route interface",
  );
  return null;
}
// Called by both the operational inventory command and guest PF refresh.
export function destinationInventory(snapshot) {
  assert.ok(isIPv4(snapshot.publicIP));
  const interfaces = interfaceDestinations(snapshot.interfaces);
  const addresses = new Set([
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "224.0.0.0/4",
    "240.0.0.0/4",
    `${snapshot.publicIP}/32`,
    ...interfaces.addresses,
  ]);
  let header = false;
  for (const line of snapshot.routes.split("\n")) {
    if (/^Destination\s+Gateway\s+Flags\s/.test(line)) {
      header = true;
      continue;
    }
    if (!header || line.trim() === "") {
      continue;
    }
    const [token, gateway, flags, netif] = line.trim().split(/\s+/);
    assert.ok(token && gateway && flags, `Unresolved BSD route: ${line}`);
    if (token === "default") {
      const resolved = defaultDestination({ gateway, flags, netif }, interfaces.ipv4Interfaces);
      if (resolved) {
        addresses.add(resolved);
      }
    } else {
      addresses.add(destination(token, flags));
    }
  }
  assert.ok(header, "IPv4 BSD route destination header missing");
  return { ...snapshot, blocked: [...addresses].sort().join("\n") + "\n" };
}
export function inventory() {
  return destinationInventory({
    interfaces: execute("/sbin/ifconfig", ["-a"]),
    routes: execute("/usr/sbin/netstat", ["-rn", "-f", "inet"]),
    publicIP: execute(
      "/usr/bin/curl",
      ["-q", "-fsS", "--max-time", "20", "https://api.ipify.org"],
      { env: { PATH: "/usr/bin:/bin" } },
    ).trim(),
  });
}
