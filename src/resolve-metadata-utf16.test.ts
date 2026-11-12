import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";

function setup(historicalAllowedResponses?: string[]) {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "phase" });
  let request = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "?", allowedResponses: ["approve"] });
  // create now rejects malformed responses, so write the historical row directly.
  if (historicalAllowedResponses) {
    db.run("UPDATE requests SET allowed_responses = ? WHERE id = ?", [JSON.stringify(historicalAllowedResponses), request.id]);
    request = requests.get(request.id)!;
  }
  return { db, requests, request };
}

const bad = "bad\ud800";

test("reject malformed actor and note on new writes without changing state", () => {
  for (const fields of [{ actor: bad, note: "ok" }, { actor: "person", note: bad }, { actor: "person", note: "\udc00" }]) {
    const { db, requests, request } = setup();
    const events = requests.events();
    expect(() => requests.resolve({ requestId: request.id, response: "approve", expectedRevision: 1, ...fields })).toThrow(/encoding/);
    expect(requests.get(request.id)).toEqual(request);
    expect(requests.events()).toEqual(events);
    db.close();
  }
});

test("preserve validation precedence and lazy note getter", () => {
  const { db, requests, request } = setup();
  const input = { requestId: request.id, actor: bad, expectedRevision: 2, response: "wrong", get note(): string { throw new Error("note accessed"); } };
  expect(() => requests.resolve(input)).toThrow(/revision/);
  input.expectedRevision = 1;
  expect(() => requests.resolve(input)).toThrow(/response must/);
  requests.withdraw({ requestId: request.id, actor: "supervisor", reason: "stop" });
  expect(() => requests.resolve(input)).toThrow(/withdrawn/);
  db.close();
});

test("trim actor, keep replay conflicts and accept historical malformed allowed response", () => {
  const { db, requests, request } = setup([bad]);
  const input = { requestId: request.id, response: bad, actor: "  person 😀  ", expectedRevision: 1, note: "fine 😀" };
  const resolved = requests.resolve(input);
  expect(resolved.resolvedBy).toBe("person 😀");
  expect(requests.events().at(-1)?.actor).toBe("person 😀");
  expect(resolved.response).toBe("bad�");
  expect(() => requests.resolve(input)).toThrow(/already answered/);
  const replay = { ...input, response: resolved.response! };
  expect(requests.resolve(replay)).toEqual(resolved);
  expect(() => requests.resolve({ ...replay, note: bad })).toThrow(/already answered/);
  db.close();
});
