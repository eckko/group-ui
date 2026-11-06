/* updatebook.js - "Update a book", an admin-only tool on the shelf.
 *
 * Loaded on demand after js/addbook.js (which it borrows its dialog, GitHub
 * call and pipeline runner from). An admin taps the thin arrow bar under a
 * book's status panel, opens the Manage drawer and chooses "Update this
 * book". From there they can:
 *   - change the book name (and, if they like, rename the repo to match),
 *   - replace the book's EPUB and/or PDF,
 *   - copy the shell repo's actions and files again ("Sync"),
 *   - set the repo properties Create book sets (name, topics, secrets,
 *     variables, pull request settings).
 * Sync and properties both run through the pipeline's update-book.yml,
 * because secrets cannot be written from a browser. Nothing here touches a
 * book's data files.
 *
 * Plain ES5-style browser code with no build step. The functions that need
 * no page (planChanges, diffTemplate, checkProperties, updateBook) are
 * exported for tests/updatebook.test.js.
 */
(function updateBookModule(root) {
  "use strict";

  var WORKFLOW = "update-book.yml";
  var SHELL = "eckko/item-template";
  var NO_CHANGE = "no change";
  /* what Create book sets on a new repo (actions/create-book.yml) */
  var SECRETS = ["SUBJECT_REPO_TOKEN", "SUBJECT_KEY"];
  var VARIABLES = ["SUBJECT_REPO"];
  var SETTINGS = {
    private: true,
    allow_update_branch: true,
    delete_branch_on_merge: true,
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
  };
  /* the pipeline never touches these; neither does the file diff */
  var DATA_PREFIXES = ["references/", "data/", "pool/", "notes/"];

  var kit = null;

  // ------------------------------------------------------------- pure logic

  /** @returns {boolean} true when a repo path is book data, which is never synced */
  function isData(path) {
    return DATA_PREFIXES.some(function is(prefix) { return path.indexOf(prefix) === 0; }) ||
      path === "index.enc" || path === "boot.json";
  }

  /**
   * Which of the shell repo's files differ from the book repo's.
   * @param {{path: string, sha: string}[]} shell  the shell repo's files
   * @param {{path: string, sha: string}[]} repo  the book repo's files
   * @returns {{added: string[], changed: string[], removed: string[]}}
   */
  function diffTemplate(shell, repo) {
    var have = {};
    var want = {};
    repo.forEach(function each(file) { have[file.path] = file.sha; });
    var result = { added: [], changed: [], removed: [] };
    shell.forEach(function each(file) {
      if (isData(file.path)) { return; }
      want[file.path] = true;
      if (!(file.path in have)) { result.added.push(file.path); }
      else if (have[file.path] !== file.sha) { result.changed.push(file.path); }
    });
    repo.forEach(function each(file) {
      /* only the actions are removed; other files are the book's own */
      if (file.path.indexOf(".github/") === 0 && !want[file.path] && !isData(file.path)) {
        result.removed.push(file.path);
      }
    });
    return result;
  }

  /**
   * Compare a repo with what Create book sets.
   * @param {object} state
   * @param {string} state.name  the book name (the repo description)
   * @param {string} state.subject  the subject site name
   * @param {object} state.repo  GitHub's repo JSON (private, topics, merge settings, ...)
   * @param {string[]} state.secrets  secret names the repo has
   * @param {string[]} state.variables  variable names the repo has
   * @param {?string} state.readError  set when the secrets or variables could not be read
   * @returns {{label: string, want: string, have: string, ok: boolean, hidden: boolean}[]}
   */
  function checkProperties(state) {
    var repo = state.repo || {};
    var rows = [];
    function add(label, want, have, hidden) {
      rows.push({ label: label, want: want, have: have, ok: want === have, hidden: !!hidden });
    }
    add("Description", state.name, repo.description || "");
    var topics = (repo.topics || []).slice().sort().join(", ");
    add("Topics", ["book", state.subject].sort().join(", "), topics);
    Object.keys(SETTINGS).forEach(function each(key) {
      add(key.replace(/_/g, " "), String(SETTINGS[key]), String(!!repo[key]));
    });
    SECRETS.forEach(function each(name) {
      var present = (state.secrets || []).indexOf(name) !== -1;
      add("Secret " + name, "set", state.readError ? "unknown" : (present ? "set" : "missing"), true);
    });
    VARIABLES.forEach(function each(name) {
      var present = (state.variables || []).indexOf(name) !== -1;
      add("Variable " + name, "set", state.readError ? "unknown" : (present ? "set" : "missing"), false);
    });
    return rows;
  }

  /**
   * What an update would do, given the admin's choices.
   * @param {object} form
   * @param {string} form.oldName  the current book name
   * @param {string} form.newName  the typed name
   * @param {boolean} form.rename  also rename the repo
   * @param {string} form.repoName  the current repo name
   * @param {File[]} form.files  the files to put in place
   * @param {boolean} form.sync  copy the shell repo's actions and files
   * @param {boolean} form.properties  set the repo properties
   * @returns {{nameChanged: boolean, newSlug: string, count: number, runWorkflow: boolean, steps: string[]}}
   */
  function planChanges(form) {
    var newName = String(form.newName || "").trim();
    var nameChanged = !!newName && newName !== form.oldName;
    var newSlug = form.rename && nameChanged ? root.SubjectAddBook.slugOf(newName) : form.repoName;
    var steps = [];
    if (nameChanged) { steps.push(form.rename && newSlug !== form.repoName ? "rename" : "describe"); }
    if (form.files.length) { steps.push("files"); }
    var run = !!(form.sync || form.properties);
    if (run) { steps.push("workflow"); }
    var count = (nameChanged ? 1 : 0) + form.files.length + (form.sync ? 1 : 0) + (form.properties ? 1 : 0);
    return { nameChanged: nameChanged, newSlug: newSlug, count: count, runWorkflow: run, steps: steps };
  }

  /** @returns {{path: string, sha: string}[]} the files of a GitHub tree reply */
  function treeFiles(reply) {
    return ((reply.data && reply.data.tree) || []).filter(function blob(item) {
      return item.type === "blob";
    }).map(function pick(item) { return { path: item.path, sha: item.sha }; });
  }

  /**
   * Read what the update screen shows about a book repo.
   * @param {object} deps  {api, owner, repo, name, subject}
   * @returns {Promise<object>}
   */
  function loadRepoState(deps) {
    var api = deps.api;
    var state = { name: deps.name, subject: deps.subject, secrets: [], variables: [], readError: null };
    var base = "/repos/" + deps.owner + "/" + deps.repo;
    return api("GET", base).then(function repo(reply) {
      if (reply.status !== 200) { throw new Error("The token cannot see " + deps.owner + "/" + deps.repo + "."); }
      state.repo = reply.data;
      return Promise.all([
        api("GET", base + "/git/trees/" + reply.data.default_branch + "?recursive=1"),
        api("GET", "/repos/" + SHELL + "/git/trees/HEAD?recursive=1"),
        api("GET", base + "/actions/secrets?per_page=100"),
        api("GET", base + "/actions/variables?per_page=30"),
      ]);
    }).then(function all(replies) {
      state.files = treeFiles(replies[0]);
      state.diff = replies[1].status === 200 ? diffTemplate(treeFiles(replies[1]), state.files) : null;
      if (replies[2].status === 200 && replies[3].status === 200) {
        state.secrets = (replies[2].data.secrets || []).map(function n(s) { return s.name; });
        state.variables = (replies[3].data.variables || []).map(function n(v) { return v.name; });
      } else {
        state.readError = "Reading secrets and variables needs admin access to the repo.";
      }
      state.rows = checkProperties(state);
      return state;
    });
  }

  /**
   * Do an update, in this order: replace files (repo still has its old name),
   * rename or describe, then one pipeline run for sync and properties.
   * @param {object} deps
   * @param {function} deps.api  a GitHub call
   * @param {function(File): Promise<string>} deps.readBase64
   * @param {function(number): Promise} [deps.sleep]
   * @param {string} deps.owner
   * @param {string} deps.repo  the current repo name
   * @param {string} deps.pipeline
   * @param {string} deps.subject
   * @param {string} deps.newName  the book name to set ("" to keep it)
   * @param {string} deps.newSlug  the repo name after the update
   * @param {File[]} deps.files
   * @param {{path: string, sha: string}[]} deps.existing  the repo's files (for the replaced paths)
   * @param {boolean} deps.sync
   * @param {boolean} deps.properties
   * @param {function(string): void} [deps.onStep]
   * @returns {Promise<{repo: string, runUrl: string}>}
   */
  function updateBook(deps) {
    var api = deps.api;
    var step = deps.onStep || function none() {};
    var runUrl = "";
    var base = "/repos/" + deps.owner + "/" + deps.repo;
    var slug = deps.repo;

    function fail(message) { throw new Error(message); }

    function target(file) {
      var ext = kit.extensionOf(file.name);
      var found = null;
      deps.existing.forEach(function each(item) {
        if (!found && item.path.indexOf("references/") === 0 &&
            kit.extensionOf(item.path) === ext) { found = item; }
      });
      return found || { path: "references/" + deps.repo + "." + ext, sha: "" };
    }

    function putFiles(index) {
      if (index >= deps.files.length) { return null; }
      var file = deps.files[index];
      var place = target(file);
      step("Replacing files " + (index + 1) + " of " + deps.files.length);
      return deps.readBase64(file).then(function body(content) {
        var data = { message: "Replace " + place.path, content: content };
        if (place.sha) { data.sha = place.sha; }
        return api("PUT", base + "/contents/" + place.path, data);
      }).then(function done(reply) {
        if (reply.status !== 200 && reply.status !== 201) {
          fail("GitHub did not accept " + place.path + " (" + reply.status + "). " +
            ((reply.data && reply.data.message) || ""));
        }
        return putFiles(index + 1);
      });
    }

    return Promise.resolve().then(function check() {
      if (deps.newSlug && deps.newSlug !== deps.repo) {
        return api("GET", "/repos/" + deps.owner + "/" + deps.newSlug).then(function free(reply) {
          if (reply.status === 200) { fail("A repo named " + deps.newSlug + " already exists."); }
          return null;
        });
      }
      return null;
    }).then(function files() {
      return putFiles(0);
    }).then(function rename() {
      var patch = {};
      if (deps.newName) { patch.description = deps.newName; }
      if (deps.newSlug && deps.newSlug !== deps.repo) { patch.name = deps.newSlug; }
      if (!Object.keys(patch).length) { return null; }
      step(patch.name ? "Renaming the repo" : "Saving the book name");
      return api("PATCH", base, patch).then(function renamed(reply) {
        if (reply.status !== 200) {
          fail("GitHub did not rename the repo (" + reply.status + "). " +
            ((reply.data && reply.data.message) || ""));
        }
        if (patch.name) { slug = reply.data.name || patch.name; }
        return null;
      });
    }).then(function pipeline() {
      if (!deps.sync && !deps.properties) { return null; }
      step("Syncing actions and setting repo properties");
      return root.SubjectAddBook.runWorkflow({
        api: api, sleep: deps.sleep, pipeline: deps.pipeline, workflow: WORKFLOW,
        inputs: { repo: slug, subject: deps.subject || NO_CHANGE, dry_run: "false" },
        label: "Update book", running: "Syncing actions and setting repo properties",
        onStep: step,
      }).then(function ran(run) { runUrl = run.html_url || ""; return null; });
    }).then(function done() {
      return { repo: slug, runUrl: runUrl };
    });
  }

  // ----------------------------------------------------------------- the UI

  var options = {};
  var drawer = null;
  var drawerFocus = null;

  /** @returns {string} the repo name of a book on the shelf */
  function repoOf(book) { return book.repo || book.id; }

  /**
   * An inline SVG icon.
   * @param {string} path  the SVG path data
   * @param {number} size
   * @returns {SVGElement}
   */
  function icon(path, size) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var shape = document.createElementNS(ns, "path");
    shape.setAttribute("d", path);
    svg.appendChild(shape);
    return svg;
  }

  /**
   * The thin arrow bar under a card's status panel.
   * @param {object} book
   * @returns {HTMLButtonElement}
   */
  function bar(book) {
    var node = kit.make("button", "ub-bar");
    node.type = "button";
    node.setAttribute("aria-label", "Manage " + book.title);
    node.setAttribute("aria-haspopup", "dialog");
    node.appendChild(icon("M6 9l6 6 6-6", 22));
    node.addEventListener("click", function manage() { openDrawer(book, node); });
    return node;
  }

  /** Close the Manage drawer. */
  function closeDrawer() {
    if (drawer) { drawer.remove(); drawer = null; }
    document.removeEventListener("keydown", onDrawerKey);
    if (drawerFocus && drawerFocus.focus) { drawerFocus.focus(); }
  }

  /** @param {KeyboardEvent} event */
  function onDrawerKey(event) {
    if (event.key === "Escape") { closeDrawer(); }
  }

  /**
   * The bottom drawer: Update this book, Open repo on GitHub.
   * @param {object} book
   * @param {HTMLElement} from  what opened it, for focus
   */
  function openDrawer(book, from) {
    closeDrawer();
    drawerFocus = from;
    drawer = kit.make("div", "ub-backdrop");
    drawer.addEventListener("click", function outside(event) {
      if (event.target === drawer) { closeDrawer(); }
    });
    var sheet = kit.make("div", "ub-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Manage " + book.title);
    sheet.appendChild(kit.make("div", "ub-grip"));
    var head = kit.make("div", "ub-sheet-head");
    head.appendChild(kit.make("h2", null, "Manage " + book.title));
    var closer = kit.make("button", "ab-close", "×");
    closer.type = "button";
    closer.setAttribute("aria-label", "Close");
    closer.addEventListener("click", closeDrawer);
    head.appendChild(closer);
    sheet.appendChild(head);

    var update = kit.make("button", "ub-row");
    update.type = "button";
    update.appendChild(kit.make("span", "ub-row-icon", "✎"));
    var text = kit.make("span", "ub-row-text");
    text.appendChild(kit.make("span", "ub-row-title", "Update this book"));
    text.appendChild(kit.make("span", "ub-row-sub", "Name, files, actions, repo properties"));
    update.appendChild(text);
    update.appendChild(icon("M9 5l7 7-7 7", 20));
    update.addEventListener("click", function go() {
      closeDrawer();
      openUpdate(book);
    });
    sheet.appendChild(update);

    var owner = String(options.pipeline || "").split("/")[0];
    var repo = kit.make("a", "ub-row");
    repo.href = "https://github.com/" + (owner ? owner + "/" : "") + repoOf(book);
    repo.target = "_blank";
    repo.rel = "noopener noreferrer";
    repo.appendChild(kit.make("span", "ub-row-icon", "⌂"));
    repo.appendChild(kit.make("span", "ub-row-title", "Open repo on GitHub"));
    sheet.appendChild(repo);
    sheet.appendChild(kit.make("p", "ab-hint", "Build status stays on the card (tap the lavender panel)."));
    drawer.appendChild(sheet);
    document.body.appendChild(drawer);
    document.addEventListener("keydown", onDrawerKey);
    update.focus();
  }

  /**
   * A labelled checkbox row.
   * @returns {{row: HTMLElement, box: HTMLInputElement}}
   */
  function check(id, label, hint, checked) {
    var row = kit.make("label", "ub-check");
    row.setAttribute("for", id);
    var box = kit.make("input");
    box.type = "checkbox";
    box.id = id;
    box.checked = !!checked;
    var text = kit.make("span", "ub-check-text");
    text.appendChild(kit.make("span", "ub-check-label", label));
    if (hint) { text.appendChild(kit.make("span", "ab-hint", hint)); }
    row.appendChild(box);
    row.appendChild(text);
    return { row: row, box: box };
  }

  /** @returns {HTMLElement} a card with a heading */
  function card(title) {
    var box = kit.make("section", "ub-card");
    box.appendChild(kit.make("h3", null, title));
    return box;
  }

  /**
   * The Update screen.
   * @param {object} book
   */
  function openUpdate(book) {
    kit.use("Update a book", true);
    var holder = kit.screen("Update " + book.title, "", -1);
    holder.appendChild(kit.make("p", "ab-working", "Reading the repo"));
    kit.withGithub(function ready(api, owner) {
      return loadRepoState({
        api: api, owner: owner, repo: repoOf(book), name: book.title,
        subject: options.subjectRepo || "",
      }).then(function loaded(state) {
        updateScreen(book, api, owner, state);
      });
    }).catch(function bad(problem) {
      var body = kit.screen("Update " + book.title, "", -1);
      body.appendChild(kit.make("p", "ab-error", problem.message));
      body.appendChild(kit.button("Close", "plain", kit.close));
    });
  }

  /** @returns {number} how many rows differ */
  function differing(rows) {
    return rows.filter(function not(row) { return !row.ok; }).length;
  }

  /**
   * The form itself, once the repo is read.
   */
  function updateScreen(book, api, owner, state) {
    var body = kit.screen("Update " + book.title, "", -1);
    var repoName = repoOf(book);
    var picked = [];

    var left = kit.make("div", "ub-col");
    var right = kit.make("div", "ub-col");

    // name
    var nameCard = card("Book name");
    var nameLabel = kit.make("label", "ab-label", "Name");
    nameLabel.setAttribute("for", "ub-name");
    var nameInput = kit.make("input", "ab-input");
    nameInput.id = "ub-name";
    nameInput.value = book.title;
    nameInput.autocomplete = "off";
    var rename = check("ub-rename", "Also rename the repo", "Changes the repo name to match.", false);
    var slugLine = kit.make("div", "ab-repo");
    slugLine.appendChild(kit.make("span", null, "Repo:"));
    var slugChip = kit.make("span", "ab-chip ab-mono", repoName);
    slugLine.appendChild(slugChip);
    var slugState = kit.make("span", null, "");
    slugLine.appendChild(slugState);
    nameCard.appendChild(nameLabel);
    nameCard.appendChild(nameInput);
    nameCard.appendChild(rename.row);
    nameCard.appendChild(slugLine);
    left.appendChild(nameCard);

    // files
    var fileCard = card("Source files");
    fileCard.appendChild(kit.make("p", "ab-hint", "Replace the EPUB and/or PDF. A file of the same type replaces the one in the repo."));
    var chooser = kit.make("input");
    chooser.type = "file";
    chooser.multiple = true;
    chooser.accept = ".epub,.pdf";
    chooser.id = "ub-files";
    chooser.setAttribute("aria-label", "Choose EPUB or PDF files");
    var fileList = kit.make("ul", "ab-files");
    fileCard.appendChild(chooser);
    fileCard.appendChild(fileList);
    left.appendChild(fileCard);

    // sync
    var diff = state.diff;
    var diffCount = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0;
    var syncCard = card("Actions from the shell repo");
    var sync = check("ub-sync", "Copy the shell repo's actions again",
      diff ? (diffCount ? diffCount + " files differ. Opens a pull request." : "Already the same as the shell repo.") :
        "Could not read the shell repo. The action can still run.", diffCount > 0);
    syncCard.appendChild(sync.row);
    if (diffCount) {
      var names = kit.make("ul", "ab-list");
      diff.added.map(function a(p) { return "New: " + p; })
        .concat(diff.changed.map(function c(p) { return "Changed: " + p; }))
        .concat(diff.removed.map(function r(p) { return "Removed: " + p; }))
        .slice(0, 12).forEach(function each(line) { names.appendChild(kit.make("li", null, line)); });
      syncCard.appendChild(names);
    }
    right.appendChild(syncCard);

    // properties (collapsible)
    var off = differing(state.rows);
    var props = kit.make("details", "ub-card ub-props");
    if (off) { props.open = false; }
    var summary = kit.make("summary", null, "Repo properties");
    props.appendChild(summary);
    props.appendChild(kit.make("p", "ab-hint", "Same as Create book. " + off + " of " + state.rows.length + " differ."));
    if (state.readError) { props.appendChild(kit.make("p", "ab-error", state.readError)); }
    var table = kit.make("ul", "ub-rows");
    state.rows.forEach(function each(row) {
      var line = kit.make("li", "ub-prop");
      line.appendChild(kit.make("span", "ub-prop-name", row.label));
      line.appendChild(kit.make("span", "ub-prop-have", row.hidden ? "value hidden" : row.have));
      line.appendChild(kit.make("span", row.ok ? "ab-ok" : "ab-bad", row.ok ? "ok" : "Differs"));
      table.appendChild(line);
    });
    props.appendChild(table);
    var propsOn = check("ub-props-on", "Set all to Create book values", null, off > 0);
    props.appendChild(propsOn.row);
    right.appendChild(props);

    var columns = kit.make("div", "ub-columns");
    columns.appendChild(left);
    columns.appendChild(right);
    body.appendChild(columns);

    var message = kit.make("p", "ab-error");
    message.setAttribute("role", "alert");
    var apply = kit.button("Nothing to change", "primary", go);
    body.appendChild(message);
    body.appendChild(apply);

    function form() {
      return {
        oldName: book.title, newName: nameInput.value, rename: rename.box.checked,
        repoName: repoName, files: picked, sync: sync.box.checked, properties: propsOn.box.checked,
      };
    }

    function refresh() {
      var plan = planChanges(form());
      apply.disabled = plan.count === 0;
      apply.textContent = plan.count ? "Apply " + plan.count + " change" + (plan.count === 1 ? "" : "s") : "Nothing to change";
      if (rename.box.checked && plan.nameChanged) {
        slugChip.textContent = plan.newSlug || "(no letters)";
        slugState.textContent = plan.newSlug === repoName ? "" : "…";
        if (plan.newSlug && plan.newSlug !== repoName) {
          api("GET", "/repos/" + owner + "/" + plan.newSlug).then(function free(reply) {
            if (slugChip.textContent !== plan.newSlug) { return; }
            slugState.className = reply.status === 404 ? "ab-ok" : "ab-bad";
            slugState.textContent = reply.status === 404 ? "Name is free" : "Name is taken";
            if (reply.status !== 404) { apply.disabled = true; }
          });
        }
      } else {
        slugChip.textContent = repoName;
        slugState.textContent = "";
      }
    }

    function drawFiles() {
      fileList.textContent = "";
      picked.forEach(function each(file, index) {
        var item = kit.make("li", "ab-file");
        item.appendChild(kit.make("span", "ab-grow", file.name + " · " + Math.round(file.size / 1024 / 1024 * 10) / 10 + " MB"));
        var drop = kit.make("button", "ab-remove", "Remove");
        drop.type = "button";
        drop.addEventListener("click", function remove() { picked.splice(index, 1); drawFiles(); refresh(); });
        item.appendChild(drop);
        fileList.appendChild(item);
      });
    }

    chooser.addEventListener("change", function chosen() {
      Array.prototype.slice.call(chooser.files).forEach(function each(file) {
        var ext = kit.extensionOf(file.name);
        if (ext === "epub" || ext === "pdf") { picked.push(file); }
      });
      chooser.value = "";
      drawFiles();
      refresh();
    });
    [nameInput, rename.box, sync.box, propsOn.box].forEach(function wire(node) {
      node.addEventListener("input", refresh);
      node.addEventListener("change", refresh);
    });
    refresh();

    function go() {
      var plan = planChanges(form());
      var base = (options.pipeline || "");
      if (!base) {
        message.textContent = "Set admin.pipeline in subject.json to use the sync and property actions.";
        if (plan.runWorkflow) { return; }
      }
      working(plan);
      updateBook({
        api: api, readBase64: kit.readBase64, owner: owner, repo: repoName, pipeline: base,
        subject: options.subjectRepo || "", newName: plan.nameChanged ? form().newName.trim() : "",
        newSlug: plan.newSlug, files: picked, existing: state.files,
        sync: sync.box.checked, properties: propsOn.box.checked, onStep: onStep,
      }).then(function finished(result) {
        done(book, result);
      }).catch(function bad(problem) {
        var again = kit.screen("Update " + book.title, "", -1);
        again.appendChild(kit.make("p", "ab-error", problem.message));
        again.appendChild(kit.button("Back", "plain", function back() { openUpdate(book); }));
        again.appendChild(kit.button("Close", "plain", kit.close));
      });
    }

    var progressText = null;
    function working() {
      var view = kit.screen("Updating " + book.title, "", 0.5);
      progressText = kit.make("p", "ab-working", "Starting");
      view.appendChild(progressText);
      view.appendChild(kit.make("p", "ab-hint", "The actions and the repo properties run together in one pipeline run. You can close this; the run carries on."));
    }
    function onStep(text) { if (progressText) { progressText.textContent = text; } }
  }

  /** The finished screen. */
  function done(book, result) {
    var body = kit.screen("Book updated", "", 1);
    body.appendChild(kit.make("p", "ab-ok", "Done. " + book.title + " is updated."));
    body.appendChild(kit.make("p", "ab-hint", "The shelf keeps showing the old book until a pull request is merged and the book publishes again."));
    if (result.runUrl) {
      var link = kit.make("a", "ab-button ab-plain", "Open the action run");
      link.href = result.runUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      body.appendChild(link);
    }
    body.appendChild(kit.button("Close", "primary", function finish() {
      kit.close();
      if (options.onChange) { options.onChange(); }
    }));
  }

  /**
   * @param {object} setup  the same object js/addbook.js got from hub.js
   * @returns {boolean} true when the update tool can be used
   */
  function init(setup) {
    if (!root.SubjectAddBook || !root.SubjectAddBook.kit) { return false; }
    kit = root.SubjectAddBook.kit;
    options = setup || {};
    return true;
  }

  root.SubjectUpdateBook = {
    init: init, bar: bar, open: openUpdate,
    ready: function ready() { return !!kit; },
    diffTemplate: diffTemplate, checkProperties: checkProperties, planChanges: planChanges,
    loadRepoState: loadRepoState, updateBook: updateBook, isData: isData,
  };
  if (root.SubjectAddBook && root.SubjectAddBook.kit) { kit = root.SubjectAddBook.kit; }
}(typeof window !== "undefined" ? window : this));
