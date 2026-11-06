// Tests for js/addbook.js (no page needed). Run: node --test tests/addbook.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "js", "addbook.js"), "utf8"),
  sandbox);
const { slugOf, planFiles, createBook } = sandbox.SubjectAddBook;
// Objects made inside the vm have another Object prototype; compare as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

// The expected values were produced by the Create book action's own shell
// code (actions/.github/workflows/create-book.yml) for the same names.
test("slugOf gives the same repo names as the Create book action", () => {
  const expected = {
    "Deep Work": "deep-work",
    "Atomic Habits: Tiny Changes": "atomic-habits-tiny-changes",
    "The Hitchhiker's Guide": "the-hitchhikers-guide",
    "Café Society — Édition": "cafe-society-edition",
    "  ---  ": "",
    "Don’t Panic": "dont-panic",
    "A/B Testing 2.0": "a-b-testing-2-0",
    "ÄÖÜ ß": "aou",
    "日本語": "",
  };
  for (const [name, slug] of Object.entries(expected)) {
    assert.equal(slugOf(name), slug, name);
  }
});

const file = (name, size = 1000) => ({ name, size });

test("planFiles names the first file of each type after the book", () => {
  const plan = planFiles("deep-work", [file("Book (1).EPUB"), file("x.pdf"), file("n.docx")]);
  assert.deepEqual(plain(plan.items.map((i) => i.path)),
    ["deep-work.epub", "deep-work.pdf", "deep-work.docx"]);
  assert.deepEqual(plain(plan.problems), []);
  assert.ok(plan.items.every((i) => i.renamed));
});

test("a second file of a type keeps its own, cleaned name", () => {
  const plan = planFiles("deep-work", [file("a.pdf"), file("Second copy (2).pdf")]);
  assert.deepEqual(plain(plan.items.map((i) => i.path)), ["deep-work.pdf", "Second-copy-2-.pdf"]);
});

test("planFiles refuses other types, huge files and name clashes", () => {
  const plan = planFiles("b", [file("a.txt"), file("a.pdf", 91 * 1024 * 1024),
    file("b.pdf"), file("b.pdf")]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.problems.length, 3);
  assert.match(plan.problems[0], /not an EPUB, PDF or DOCX/);
  assert.match(plan.problems[1], /larger than 90 MB/);
  assert.match(plan.problems[2], /overwrite/);
});

/**
 * A fake GitHub: records calls and answers like the real one for the calls
 * createBook makes.
 */
function fakeGithub(options = {}) {
  const calls = [];
  let polls = 0;
  const state = { runs: [{ id: 1, status: "completed", conclusion: "success" }], uploads: [] };
  const api = async (method, route, body) => {
    calls.push([method, route, body]);
    if (route === "/repos/me/deep-work") {
      return { status: options.exists ? 200 : 404, data: {} };
    }
    if (route === "/repos/me/actions") {
      return { status: options.noPipeline ? 404 : 200, data: { default_branch: "main" } };
    }
    if (route.startsWith("/repos/me/actions/actions/workflows/create-book.yml/runs")) {
      return { status: 200, data: { workflow_runs: state.runs } };
    }
    if (route.endsWith("/dispatches")) {
      if (options.refuse) { return { status: 422, data: { message: "bad input" } }; }
      state.runs = [{ id: 2, status: "queued", html_url: "https://run/2" }, ...state.runs];
      return { status: 204, data: null };
    }
    if (route === "/repos/me/actions/actions/runs/2") {
      polls += 1;
      const done = polls >= 2;
      return { status: 200, data: { id: 2, html_url: "https://run/2",
        status: done ? "completed" : "in_progress",
        conclusion: done ? (options.runFails ? "failure" : "success") : null } };
    }
    if (method === "PUT" && route.startsWith("/repos/me/deep-work/contents/references/")) {
      if (options.notReadyYet && state.uploads.length === 0 && !state.tried) {
        state.tried = true;
        return { status: 404, data: { message: "Not Found" } };
      }
      state.uploads.push(decodeURIComponent(route.split("/references/")[1]));
      return { status: 201, data: {} };
    }
    throw new Error("unexpected call " + method + " " + route);
  };
  return { api, calls, state };
}

function run(fake, extra = {}) {
  const steps = [];
  const promise = createBook({
    api: fake.api, sleep: async () => {}, readBase64: async (f) => "b64:" + f.name,
    owner: "me", pipeline: "me/actions", name: "Deep Work", subject: "emotion",
    items: [{ file: file("a.epub"), path: "deep-work.epub" },
      { file: file("a.pdf"), path: "deep-work.pdf" }],
    onStep: (text) => steps.push(text), ...extra,
  });
  return { promise, steps };
}

test("createBook starts the action with the name and subject, then uploads", async () => {
  const fake = fakeGithub();
  const { promise, steps } = run(fake);
  const result = await promise;
  assert.equal(result.slug, "deep-work");
  const dispatch = fake.calls.find((c) => c[1].endsWith("/dispatches"));
  assert.deepEqual(plain(dispatch[2]), { ref: "main", inputs: { book_name: "Deep Work", subject: "emotion" } });
  assert.deepEqual(fake.state.uploads, ["deep-work.epub", "deep-work.pdf"]);
  const put = fake.calls.find((c) => c[0] === "PUT");
  assert.deepEqual(plain(put[2]), { message: "Add references", content: "b64:a.epub" });
  assert.ok(steps.some((s) => /Uploading 2 of 2/.test(s)));
  // order: the repo is only touched after the action succeeded
  const firstPut = fake.calls.findIndex((c) => c[0] === "PUT");
  const lastPoll = fake.calls.map((c) => c[1]).lastIndexOf("/repos/me/actions/actions/runs/2");
  assert.ok(lastPoll < firstPut);
});

test("createBook never calls a public repo or sends a name anywhere else", async () => {
  const fake = fakeGithub();
  await run(fake).promise;
  for (const [, route, body] of fake.calls) {
    assert.ok(/^\/repos\/me\/(actions|deep-work)/.test(route), route);
    if (body && !route.includes("/contents/")) {
      assert.ok(!/me\/deep-work/.test(JSON.stringify(body)), route);
    }
  }
});

test("a name that is already a repo stops before anything starts", async () => {
  const fake = fakeGithub({ exists: true });
  await assert.rejects(run(fake).promise, /already exists/);
  assert.ok(!fake.calls.some((c) => c[0] === "POST"));
});

test("an empty name stops before any call", async () => {
  const fake = fakeGithub();
  await assert.rejects(run(fake, { name: "---" }).promise, /no letters or digits/);
  assert.equal(fake.calls.length, 0);
});

test("a refused dispatch, a missing pipeline and a failed run are explained", async () => {
  await assert.rejects(run(fakeGithub({ refuse: true })).promise, /refused to start/);
  await assert.rejects(run(fakeGithub({ noPipeline: true })).promise, /cannot see me\/actions/);
  const failing = fakeGithub({ runFails: true });
  await assert.rejects(run(failing).promise, /ended with failure.*https:\/\/run\/2/);
  assert.ok(!failing.calls.some((c) => c[0] === "PUT"), "no upload after a failed run");
});

test("a new repo that is not ready yet gets the file again", async () => {
  const fake = fakeGithub({ notReadyYet: true });
  await run(fake).promise;
  assert.deepEqual(fake.state.uploads, ["deep-work.epub", "deep-work.pdf"]);
});
