// Check a certificate and key the way the service does at start, before swapping them in.
// Usage: bun scripts/tls-check.ts <cert.pem> <key.pem>
// A bad pair would stop the service at its next start, so check the new files first, then restart.
import { tlsFromEnv } from "../src/config.ts";

export async function checkPair(certPath: string, keyPath: string, now = new Date()): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  try {
    await tlsFromEnv({ FLEET_CONTROL_TLS_CERT: certPath, FLEET_CONTROL_TLS_KEY: keyPath }, (p) => Bun.file(p).text(), now, (m) => lines.push(`warning: ${m}`));
    return { ok: true, lines: [...lines, "certificate and key pass the service start check"] };
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("FLEET_CONTROL_TLS") || error instanceof Error && error.message.startsWith("TLS certificate")
      ? error.message
      : "file could not be read";
    return { ok: false, lines: [`refused: ${message}`] };
  }
}

if (import.meta.main) {
  const [cert, key] = process.argv.slice(2);
  if (!cert || !key || process.argv.length !== 4) {
    console.error("usage: bun scripts/tls-check.ts <cert.pem> <key.pem>");
    process.exit(2);
  }
  const result = await checkPair(cert, key);
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  process.exit(result.ok ? 0 : 1);
}
