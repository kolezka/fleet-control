import { X509Certificate, createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type TlsFiles = { certFile: string; keyFile: string };

// Both variables or neither; paths must be absolute. Errors never include the paths.
export function tlsFilesFromEnv(cert: string | undefined, key: string | undefined, label: string): TlsFiles | undefined {
  if ((cert === undefined) !== (key === undefined)) throw new Error(`${label} TLS needs both certificate and key files`);
  if (cert === undefined || key === undefined) return undefined;
  if (!cert.startsWith("/") || !key.startsWith("/")) throw new Error(`${label} TLS files must be absolute paths`);
  return { certFile: cert, keyFile: key };
}

const keyLimit = 64 * 1024;

// Same rules as the credentials file: no final symlink, regular file owned by this user,
// no group or other access, small.
async function readPrivateKeyFile(path: string, label: string): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error(`unreadable ${label} TLS files`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > keyLimit) throw new Error(`${label} TLS key file must be private and at most 64 KiB`);
    const bytes = new Uint8Array(keyLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > keyLimit) throw new Error(`${label} TLS key file must be private and at most 64 KiB`);
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

// Parse and pair-check before any database work, so a bad certificate fails early.
// An injected reader replaces both reads (tests only).
export async function loadTlsFiles(files: TlsFiles, label: string, read?: (path: string) => Promise<string>) {
  let cert: string;
  try { cert = await (read ?? ((path) => Bun.file(path).text()))(files.certFile); }
  catch { throw new Error(`unreadable ${label} TLS files`); }
  let key: string;
  if (read) {
    try { key = await read(files.keyFile); }
    catch { throw new Error(`unreadable ${label} TLS files`); }
  } else {
    key = await readPrivateKeyFile(files.keyFile, label);
  }
  try { if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) throw new Error("mismatch"); }
  catch { throw new Error(`invalid ${label} TLS files`); }
  return { cert, key };
}
