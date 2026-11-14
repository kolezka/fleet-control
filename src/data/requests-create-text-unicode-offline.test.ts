import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

const fields = ["question", "proposedAction", "scope"] as const;
const malformed = ["a\ud800", "a\udc00", "a\udc00\ud800"];

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
  const input = { runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval" as const, question: "Proceed?", proposedAction: "Continue", scope: "review" };
  const snapshot = () => ({ runs: db.query("SELECT * FROM runs ORDER BY id").all(), requests: db.query("SELECT * FROM requests ORDER BY id").all(), events: db.query("SELECT * FROM request_events ORDER BY seq").all() });
  return { db, requests, input, snapshot };
}

function expectError(fn: () => unknown, kind: RequestError["kind"]) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).kind).toBe(kind);
}

for (const field of fields) {
  for (const value of malformed) {
    test(`create rejects malformed ${field} ${JSON.stringify(value)} without writes`, () => {
      const f = fixture();
      const before = f.snapshot();
      try {
        expectError(() => f.requests.create({ ...f.input, [field]: value }), "invalid");
      } finally {
        try { expect(f.snapshot()).toEqual(before); } finally { f.db.close(); }
      }
    });
  }

  test(`create preserves authorization and revision precedence for malformed ${field}`, () => {
    const f = fixture();
    const before = f.snapshot();
    try {
      expectError(() => f.requests.create({ ...f.input, origin: "other", expectedRevision: 2, [field]: malformed[0]! }), "forbidden");
      expectError(() => f.requests.create({ ...f.input, expectedRevision: 2, [field]: malformed[0]! }), "conflict");
      expect(f.snapshot()).toEqual(before);
    } finally { f.db.close(); }
  });
}

test("create preserves supplementary characters and literal replacement characters exactly", () => {
  const f = fixture();
  try {
    const values = { question: "  Question 😀 �  ", proposedAction: "Action 😀 �", scope: "Scope 😀 �" };
    const created = f.requests.create({ ...f.input, ...values });
    expect(created.question).toBe("Question 😀 �");
    expect(created.proposedAction).toBe(values.proposedAction);
    expect(created.scope).toBe(values.scope);
    expect(f.requests.get(created.id)).toEqual(created);
    expect(f.requests.list({ runId: "run" })).toEqual([created]);
  } finally { f.db.close(); }
});

test("create samples mutable text getters once and persists their first values", () => {
  const f = fixture();
  const reads = { question: 0, proposedAction: 0, scope: 0 };
  try {
    const created = f.requests.create({
      ...f.input,
      get question() { return ++reads.question === 1 ? "  First question 😀  " : "changed"; },
      get proposedAction() { return ++reads.proposedAction === 1 ? "First action 😀" : "changed"; },
      get scope() { return ++reads.scope === 1 ? "First scope 😀" : "changed"; },
    });
    expect(reads).toEqual({ question: 1, proposedAction: 1, scope: 1 });
    expect([created.question, created.proposedAction, created.scope]).toEqual(["First question 😀", "First action 😀", "First scope 😀"]);
    expect(f.requests.get(created.id)).toEqual(created);
  } finally { f.db.close(); }
});

for (const question of [malformed[0]!, "  "]) {
  for (const field of ["proposedAction", "scope"] as const) {
    test(`create rejects question ${JSON.stringify(question)} before reading ${field}`, () => {
      const f = fixture();
      const before = f.snapshot();
      try {
        const input = { ...f.input, question };
        Object.defineProperty(input, field, { get() { throw new Error(`${field} read`); } });
        expectError(() => f.requests.create(input), "invalid");
        expect(f.snapshot()).toEqual(before);
      } finally { f.db.close(); }
    });
  }
}

test("create rejects malformed proposedAction before reading scope", () => {
  const f = fixture();
  const before = f.snapshot();
  try {
    expectError(() => f.requests.create({
      ...f.input, proposedAction: malformed[0]!,
      get scope(): string { throw new Error("scope read"); },
    }), "invalid");
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

test("create reads allowedResponses before question but after authorization and revision", () => {
  const f = fixture();
  const before = f.snapshot();
  const sentinel = new Error("allowedResponses read");
  const input = {
    ...f.input, question: malformed[0]!,
    get allowedResponses(): string[] { throw sentinel; },
  };
  try {
    expectError(() => f.requests.create({ ...f.input, origin: "other", get allowedResponses(): string[] { throw sentinel; } }), "forbidden");
    expectError(() => f.requests.create({ ...f.input, expectedRevision: 2, get allowedResponses(): string[] { throw sentinel; } }), "conflict");
    expect(() => f.requests.create(input)).toThrow(sentinel);
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

test("create retains optional empty defaults and required question behavior", () => {
  const f = fixture();
  try {
    const created = f.requests.create({ ...f.input, proposedAction: undefined, scope: undefined });
    expect(created.proposedAction).toBe("");
    expect(created.scope).toBe("");
    const before = f.snapshot();
    expectError(() => f.requests.create({ ...f.input, question: "  " }), "invalid");
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});
