import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { scramVerifier } from "./cooperative-provision.ts";

// The test database trusts every login, so only a byte comparison with PostgreSQL's own verifier
// proves the runtime role can log in with its password on a server that checks it.
const url = process.env.CENTRAL_TEST_DATABASE_URL;
test.skipIf(!url)("SCRAM verifier matches the one PostgreSQL computes", async () => {
  const sql = new SQL(url!, { max: 1 });
  const role = `scram_probe_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL password_encryption = 'scram-sha-256'");
      await tx.unsafe(`CREATE ROLE "${role}" PASSWORD '${password}'`);
      const [{ rolpassword }] = await tx`SELECT rolpassword FROM pg_authid WHERE rolname = ${role}`;
      const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(rolpassword)!;
      expect(scramVerifier(password, Buffer.from(match[2]!, "base64"), Number(match[1]))).toBe(rolpassword);
      throw new Error("rollback");
    }).catch((error) => { if (!(error instanceof Error && error.message === "rollback")) throw error; });
  } finally {
    await sql.close();
  }
});
