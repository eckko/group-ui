"use strict";
// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const status = require("../js/status.js");

const file = (hash) => ({ present: true, hash, name: "x" });
const gone = { present: false, hash: null, name: null };
const auto = (over) => Object.assign({
  files: { formats: { epub: file("e1"), pdf: file("p1"), docx: gone } },
  structure: { present: true, hash: "s1" },
  notes: { formats: { epub: file("n1"), pdf: file("n2"), docx: file("n3") } },
  quiz: { present: true, hash: "q1" },
  required: { files: ["epub", "pdf"], notes: ["epub", "pdf", "docx"] },
}, over || {});
const so = (hash, basedOn) => ({ hash, basedOn: basedOn === undefined ? null : basedOn });

test("a sign-off matching the hash is ok; a different hash is stale", () => {
  assert.equal(status.itemState(file("a"), so("a")).state, "ok");
  assert.deepEqual(status.itemState(file("b"), so("a")),
    { state: "stale", reason: "hash_changed" });
  assert.equal(status.itemState(file("a"), undefined).state, "check");
  assert.equal(status.itemState(gone, so("a")).state, "none");
});

test("notes go stale when the structure they were checked against changes", () => {
  assert.deepEqual(status.itemState(file("a"), so("a", "s0"), "s1"),
    { state: "stale", reason: "structure_changed" });
  assert.equal(status.itemState(file("a"), so("a", "s1"), "s1").state, "ok");
});

test("everything signed off is All done", () => {
  const signoffs = {
    files_epub: so("e1"), files_pdf: so("p1"), structure: so("s1"),
    notes_epub: so("n1", "s1"), notes_pdf: so("n2", "s1"), notes_docx: so("n3", "s1"),
    quiz: so("q1", "s1"),
  };
  const info = status.derive({ auto: auto(), signoffs });
  assert.deepEqual(info.headline, { kind: "ok", text: "All done" });
  assert.equal(info.autoDone, 4);
  assert.equal(info.manualDone, 4);
});

test("a changed notes file asks for a re-check of the notes", () => {
  const signoffs = {
    files_epub: so("e1"), files_pdf: so("p1"), structure: so("s1"),
    notes_epub: so("OLD", "s1"), notes_pdf: so("n2", "s1"), notes_docx: so("n3", "s1"),
  };
  const info = status.derive({ auto: auto(), signoffs });
  assert.deepEqual(info.headline, { kind: "attn", text: "Re-check notes" });
  assert.equal(info.stages[2].manual, "stale");
  assert.equal(info.stages[0].manual, "ok");
  assert.ok(status.stepsFor(info.stages[2]).join(" ").includes("Tap ✓ on the EPUB"));
});

test("a format marked as an error needs attention until the file changes", () => {
  const bad = { hash: "n1", basedOn: "s1", result: "error" };
  assert.deepEqual(status.itemState({ present: true, hash: "n1" }, bad, "s1"),
    { state: "stale", reason: "marked_error" });
  assert.deepEqual(status.itemState({ present: true, hash: "n2" }, bad, "s1"),
    { state: "stale", reason: "hash_changed" });
  assert.deepEqual(status.itemState({ present: true, hash: "n1" }, { hash: "n1", basedOn: "s1" }, "s1"),
    { state: "ok" });
});

test("a missing required file is a problem, an optional one is not", () => {
  const withoutPdf = auto({ files: { formats: { epub: file("e1"), pdf: gone, docx: gone } } });
  const info = status.derive({ auto: withoutPdf, signoffs: {} });
  assert.equal(info.stages[0].auto, "fail");
  assert.deepEqual(info.headline, { kind: "attn", text: "PDF missing" });
  assert.equal(status.derive({ auto: auto(), signoffs: {} }).stages[0].auto, "ok");
});

test("a book the pipeline has not seen is Not checked yet", () => {
  assert.deepEqual(status.derive(undefined).headline, { kind: "none", text: "Not checked yet" });
});

test("a built book with nothing signed off asks for your check", () => {
  const info = status.derive({ auto: auto(), signoffs: {} });
  assert.deepEqual(info.headline, { kind: "check", text: "Your check: files" });
});

test("a stage that is not built is Not started, not a failure", () => {
  const onlyFiles = auto({ structure: { present: false, hash: null },
    notes: { formats: { epub: gone, pdf: gone, docx: gone } }, quiz: { present: false, hash: null } });
  const signoffs = { files_epub: so("e1"), files_pdf: so("p1") };
  const info = status.derive({ auto: onlyFiles, signoffs });
  assert.deepEqual(info.headline, { kind: "none", text: "Structure not built yet" });
});

test("a book whose only gap is the quiz says No quiz yet", () => {
  const noQuiz = auto({ quiz: { present: false, hash: null } });
  const signoffs = {
    files_epub: so("e1"), files_pdf: so("p1"), structure: so("s1"),
    notes_epub: so("n1", "s1"), notes_pdf: so("n2", "s1"), notes_docx: so("n3", "s1"),
  };
  assert.deepEqual(status.derive({ auto: noQuiz, signoffs }).headline,
    { kind: "none", text: "No quiz yet" });
});

test("every stage of an unchecked book knows it was never checked", () => {
  const info = status.derive(undefined);
  assert.ok(info.stages.every((stage) => stage.known === false));
  assert.ok(status.derive({ auto: auto(), signoffs: {} }).stages.every((stage) => stage.known));
});
