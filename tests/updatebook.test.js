// Tests for js/updatebook.js (no page needed). Run: node --test tests/updatebook.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = {};
vm.createContext(sandbox);
for (const name of ["addbook.js", "updatebook.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", name), "utf8"), sandbox);
}
const U = sandbox.SubjectUpdateBook;
const plain = (value) => JSON.parse(JSON.stringify(value));
const f = (p, sha) => ({ path: p, sha });

test("diffTemplate lists new, changed and removed actions, never data", () => {
  const shell = [f(".github/workflows/a.yml", "1"), f(".github/workflows/b.yml", "2"),
    f("README.md", "3"), f("references/x.epub", "9"), f("index.enc", "8")];
  const repo = [f(".github/workflows/a.yml", "1"), f(".github/workflows/b.yml", "X"),
    f(".github/workflows/old.yml", "5"), f("references/x.epub", "0"), f("notes/n.md", "4")];
  assert.deepEqual(plain(U.diffTemplate(shell, repo)), {
    added: ["README.md"], changed: [".github/workflows/b.yml"], removed: [".github/workflows/old.yml"],
  });
});

test("checkProperties compares with what Create book sets", () => {
  const good = {
    name: "Deep Work", subject: "habit",
    repo: { description: "Deep Work", topics: ["habit", "book"], private: true, allow_update_branch: true,
      delete_branch_on_merge: true, allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false },
    secrets: ["SUBJECT_REPO_TOKEN", "SUBJECT_KEY"], variables: ["SUBJECT_REPO"],
  };
  assert.ok(U.checkProperties(good).every((row) => row.ok));
  const bad = Object.assign({}, good, { secrets: ["SUBJECT_KEY"], repo: Object.assign({}, good.repo, { allow_squash_merge: true }) });
  const off = U.checkProperties(bad).filter((row) => !row.ok).map((row) => row.label);
  assert.deepEqual(plain(off), ["allow squash merge", "Secret SUBJECT_REPO_TOKEN"]);
  const unknown = U.checkProperties(Object.assign({}, good, { readError: "x" }));
  assert.ok(unknown.filter((row) => !row.ok).length === 3);
});

test("planChanges counts what the admin chose", () => {
  const form = { oldName: "Deep Work", newName: "Deep Work 2", rename: true, repoName: "deep-work", files: [], sync: true, properties: false };
  assert.deepEqual(plain(U.planChanges(form)), { nameChanged: true, newSlug: "deep-work-2", count: 2, runWorkflow: true, steps: ["rename", "workflow"] });
  assert.equal(U.planChanges(Object.assign({}, form, { newName: "Deep Work", sync: false })).count, 0);
  assert.equal(U.planChanges(Object.assign({}, form, { rename: false })).newSlug, "deep-work");
});

function fakeApi(log, options = {}) {
  let polls = 0;
  return (method, url, body) => {
    log.push([method, url, body]);
    const reply = (status, data) => Promise.resolve({ status, data });
    if (method === "GET" && url === "/repos/me/actions") return reply(200, { default_branch: "main" });
    if (method === "GET" && url.indexOf("/workflows/update-book.yml/runs") !== -1) {
      polls += 1;
      return reply(200, { workflow_runs: polls > 1 ? [{ id: 7, status: "completed", conclusion: options.conclusion || "success", html_url: "u" }] : [] });
    }
    if (method === "POST" && url.endsWith("/dispatches")) return reply(204, null);
    if (method === "GET" && url === "/repos/me/new-name") return reply(options.taken ? 200 : 404, {});
    if (method === "PUT") return reply(200, {});
    if (method === "PATCH") return reply(200, { name: body.name || "old-name" });
    return reply(404, {});
  };
}
const base = (log, extra) => Object.assign({
  api: fakeApi(log), readBase64: () => Promise.resolve("QQ=="), sleep: () => Promise.resolve(),
  owner: "me", repo: "old-name", pipeline: "me/actions", subject: "habit",
  newName: "", newSlug: "old-name", files: [], existing: [], sync: false, properties: false,
}, extra);

test("updateBook replaces files, renames, then runs the pipeline with the new repo name", async () => {
  const log = [];
  const result = await U.updateBook(base(log, {
    newName: "New Name", newSlug: "new-name", sync: true, properties: true,
    files: [{ name: "b.EPUB" }, { name: "c.pdf" }],
    existing: [f("references/old-name.epub", "S1"), f("README.md", "S2")],
  }));
  const calls = log.map((c) => c[0] + " " + c[1].replace(/\?.*/, ""));
  assert.ok(calls.indexOf("PUT /repos/me/old-name/contents/references/old-name.epub") <
    calls.indexOf("PATCH /repos/me/old-name"));
  assert.ok(calls.indexOf("PATCH /repos/me/old-name") < calls.indexOf("POST /repos/me/actions/actions/workflows/update-book.yml/dispatches"));
  const put = log.filter((c) => c[0] === "PUT");
  assert.equal(put[0][2].sha, "S1");               // replaces the existing epub
  assert.equal(put[1][1].endsWith("references/old-name.pdf"), true); // new pdf
  assert.equal("sha" in put[1][2], false);
  assert.deepEqual(plain(log.find((c) => c[0] === "PATCH")[2]), { description: "New Name", name: "new-name" });
  const dispatch = log.find((c) => c[0] === "POST");
  assert.deepEqual(plain(dispatch[2].inputs), { repo: "new-name", subject: "habit", dry_run: "false" });
  assert.equal(result.runUrl, "u");
});

test("updateBook sends the renamed repo name to the pipeline", async () => {
  const log = [];
  await U.updateBook(base(log, { newName: "New Name", newSlug: "new-name", sync: true }));
  assert.equal(log.find((c) => c[0] === "POST")[2].inputs.repo, "new-name");
});

test("updateBook stops when the new repo name is taken, before changing anything", async () => {
  const log = [];
  await assert.rejects(U.updateBook(base(log, { newSlug: "new-name", api: fakeApi(log, { taken: true }), files: [{ name: "a.pdf" }] })),
    /already exists/);
  assert.equal(log.some((c) => c[0] === "PUT" || c[0] === "PATCH"), false);
});

test("updateBook without sync or properties does not start the pipeline", async () => {
  const log = [];
  await U.updateBook(base(log, { newName: "Other" }));
  assert.equal(log.some((c) => c[0] === "POST"), false);
});

test("updateBook reports a failed pipeline run", async () => {
  const log = [];
  await assert.rejects(U.updateBook(base(log, { sync: true, api: fakeApi(log, { conclusion: "failure" }) })),
    /Update book action ended with failure/);
});
