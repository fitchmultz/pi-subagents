import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function readBridgeFile(path: string, privateFile: boolean, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) {
      throw new Error("Configuration/TLS file must be a bounded regular file.");
    }
    if (privateFile && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)) {
      throw new Error("Config and TLS key must be owned by the current user with mode 0600.");
    }
    const data = readFileSync(fd);
    if (data.length > limit) {
      throw new Error("Configuration/TLS file exceeds its size limit.");
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

export function writeBridgeJson(path: string, value: object): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
