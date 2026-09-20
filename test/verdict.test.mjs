// test/verdict.test.mjs — Deliberation Engine Task 5: the closing verdict line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, VERDICT_KINDS } from "../src/verdict.mjs";

describe("parseVerdict", () => {
  it("reads a clean AGREE", () => {
    const v = parseVerdict("Some reasoning.\nAGREE: use the outbox");
    assert.equal(v.kind, "AGREE");
    assert.equal(v.body, "use the outbox");
    assert.equal(v.malformed, false);
  });

  it("takes the LAST verdict line when several appear", () => {
    const v = parseVerdict("DISAGREE: no\nmore thought\nAGREE: yes");
    assert.equal(v.kind, "AGREE");
    assert.equal(v.body, "yes");
  });

  it("tolerates leading whitespace", () => {
    assert.equal(parseVerdict("   ESCALATE: unsafe").kind, "ESCALATE");
    assert.equal(parseVerdict("\tDISAGREE: tabs too").kind, "DISAGREE");
  });

  it("treats a missing verdict line as DISAGREE", () => {
    const v = parseVerdict("I think we should use the outbox.");
    assert.equal(v.kind, "DISAGREE");
    assert.equal(v.malformed, true);
    assert.equal(v.body, "");
  });

  it("treats lowercase as malformed, not agreement", () => {
    const v = parseVerdict("agree: yes");
    assert.equal(v.kind, "DISAGREE");
    assert.equal(v.malformed, true);
  });

  it("treats empty text as DISAGREE", () => {
    assert.equal(parseVerdict("").kind, "DISAGREE");
    assert.equal(parseVerdict(null).malformed, true);
    assert.equal(parseVerdict(undefined).kind, "DISAGREE");
    assert.equal(parseVerdict(42).malformed, true);
  });

  it("a verdict token that is not at the start of its line does not count", () => {
    const v = parseVerdict("I would AGREE: with that if it were tested.");
    assert.equal(v.kind, "DISAGREE");
    assert.equal(v.malformed, true);
  });

  it("markdown-wrapped tokens are malformed: **AGREE:** is not the protocol", () => {
    assert.equal(parseVerdict("**AGREE:** use the outbox").malformed, true);
    assert.equal(parseVerdict("- AGREE: use the outbox").malformed, true);
    assert.equal(parseVerdict("> AGREE: use the outbox").malformed, true);
  });

  it("CRLF line endings do not leak a \\r into the body", () => {
    const v = parseVerdict("reasoning\r\nAGREE: use the outbox\r\n");
    assert.equal(v.kind, "AGREE");
    assert.equal(v.body, "use the outbox");
    assert.equal(v.malformed, false);
  });

  it("an AGREE with no answer after the colon is malformed: agreement must state what is agreed", () => {
    const v = parseVerdict("AGREE:");
    assert.equal(v.kind, "DISAGREE");
    assert.equal(v.malformed, true);
    assert.equal(parseVerdict("AGREE:   \n").malformed, true);
    // DISAGREE / ESCALATE carry no false-consensus risk; an empty body is allowed.
    assert.deepEqual(parseVerdict("DISAGREE:"), { kind: "DISAGREE", body: "", malformed: false, line: "DISAGREE:" });
    assert.equal(parseVerdict("ESCALATE:").kind, "ESCALATE");
  });

  it("the raw matched line is returned for the record", () => {
    const v = parseVerdict("thinking\n  ESCALATE: this sends money  ");
    assert.equal(v.line, "ESCALATE: this sends money");
    assert.equal(v.body, "this sends money");
  });

  it("a later malformed attempt does not override an earlier clean verdict; the last CLEAN line wins", () => {
    const v = parseVerdict("AGREE: use the outbox\nagree: also this");
    assert.equal(v.kind, "AGREE");
    assert.equal(v.body, "use the outbox");
    assert.equal(v.malformed, false);
  });

  it("VERDICT_KINDS is the fixed protocol", () => {
    assert.deepEqual(VERDICT_KINDS, ["AGREE", "DISAGREE", "ESCALATE"]);
  });
});
