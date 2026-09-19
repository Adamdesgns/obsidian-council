export function parseVerdict(text) {
  const line = String(text ?? "").trim().split(/\r?\n/).at(-1) || "";
  const m = /^(AGREE|DISAGREE|ESCALATE):[ \t]*(\S.*)$/.exec(line);
  return m ? { kind: m[1], body: m[2].trim(), malformed: false }
    : { kind: "DISAGREE", body: "", malformed: true };
}
