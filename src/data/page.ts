// Keyset pages for the local SQLite lists. A cursor is the last row's sort key plus the filter it was made under.
export const PAGE = 100;
export const MAX_PAGE = 1000;

// fail builds the caller's own error, so MCP and REST report it as invalid input.
type Fail = (message: string) => Error;

export function checkLimit(fail: Fail, limit: number = PAGE): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw fail(`limit must be between 1 and ${MAX_PAGE}`);
  return limit;
}

export function encodeCursor(values: (string | null)[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

// Returns the sort key, refusing a cursor made for a different filter.
export function decodeCursor(fail: Fail, cursor: string, keys: number, filter: (string | null)[]): string[] {
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(text).toString("base64url") !== cursor) throw new Error();
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== keys + filter.length) throw new Error();
    const key = parsed.slice(0, keys);
    if (!key.every((v) => typeof v === "string" && v.isWellFormed())) throw new Error();
    if (parsed.slice(keys).some((v, i) => v !== filter[i])) throw new Error();
    return key as string[];
  } catch {
    throw fail("invalid cursor or cursor filter mismatch");
  }
}
