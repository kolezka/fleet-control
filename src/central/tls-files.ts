import { X509Certificate, createPrivateKey } from "node:crypto";

export type TlsFiles = { certFile: string; keyFile: string };

// Both variables or neither; paths must be absolute. Errors never include the paths.
export function tlsFilesFromEnv(cert: string | undefined, key: string | undefined, label: string): TlsFiles | undefined {
  if ((cert === undefined) !== (key === undefined)) throw new Error(`${label} TLS needs both certificate and key files`);
  if (cert === undefined || key === undefined) return undefined;
  if (!cert.startsWith("/") || !key.startsWith("/")) throw new Error(`${label} TLS files must be absolute paths`);
  return { certFile: cert, keyFile: key };
}

// Parse and pair-check before any database work, so a bad certificate fails early.
export async function loadTlsFiles(files: TlsFiles, label: string, read: (path: string) => Promise<string> = (path) => Bun.file(path).text()) {
  let tls: { cert: string; key: string };
  try { tls = { cert: await read(files.certFile), key: await read(files.keyFile) }; }
  catch { throw new Error(`unreadable ${label} TLS files`); }
  try { if (!new X509Certificate(tls.cert).checkPrivateKey(createPrivateKey(tls.key))) throw new Error("mismatch"); }
  catch { throw new Error(`invalid ${label} TLS files`); }
  return tls;
}
