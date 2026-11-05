/*
 * addbook.js - "Add a book" for the admin of a subject site.
 *
 * Loaded on demand by js/hub.js when Admin mode is on (like js/status.js).
 * It does three things for the signed-in admin:
 *
 *   1. Starts the book-pipeline "Create book" action, so the new repo gets
 *      exactly the properties that action gives every book repo: private,
 *      made from the book template, topics, secrets, variable and pull
 *      request settings. Nothing is set up twice, here or there.
 *   2. Uploads the chosen EPUB / PDF / DOCX files into the new repo's
 *      references/ folder, named <slug>.<ext>.
 *   3. Remembers the book as "being built" until it shows up on the shelf.
 *
 * Everything runs in the admin's browser with the admin's own GitHub token,
 * which sits in Firestore at adminSecrets/<uid> where only that admin can
 * read it (firestore/status.rules). The book name and the files go only to
 * GitHub's API and to the private repos: no workflow of a public repo is
 * started, so nothing about the book reaches a public log.
 *
 * Plain ES5-style browser code with no build step. The functions that need
 * no page (slugOf, planFiles, createBook) are exported for tests/addbook.test.js.
 */
(function addBookModule(root) {
  "use strict";

  var API = "https://api.github.com";
  var WORKFLOW = "create-book.yml";
  var EXTENSIONS = ["epub", "pdf", "docx"];
  var MAX_BYTES = 90 * 1024 * 1024;      // the Contents API stops at 100 MB
  var SECRETS = "adminSecrets";

  var ctx = null;                        // {user, db, fs} from hub.js
  var options = {};                      // from hub.js (see init)
  var saved = { githubToken: "", pending: [] };

  // ------------------------------------------------------------- pure logic

  /**
   * The repo name the Create book action gives a book name: lower case,
   * accents dropped, apostrophes removed, anything else one "-".
   * Must stay the same as the action in book-pipeline.
   * @param {string} name  the book name
   * @returns {string} the slug, or "" when nothing is left
   */
  function slugOf(name) {
    var plain = String(name || "").normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
    return plain.toLowerCase().replace(/'/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  /** @returns {string} the lower-case extension of a file name, or "" */
  function extensionOf(fileName) {
    var found = /\.([A-Za-z0-9]+)$/.exec(fileName || "");
    return found ? found[1].toLowerCase() : "";
  }

  /**
   * Decide where each chosen file goes in references/. The first file of
   * each type is named <slug>.<ext>; a second file of the same type keeps its
   * own name (cleaned), so nothing is overwritten.
   * @param {string} slug  the repo name
   * @param {{name: string, size: number}[]} files  the chosen files
   * @returns {{items: object[], problems: string[]}} items have file, path,
   *   renamed (true when the name changed) and ext
   */
  function planFiles(slug, files) {
    var taken = {};
    var used = {};
    var items = [];
    var problems = [];
    Array.prototype.forEach.call(files, function each(file) {
      var ext = extensionOf(file.name);
      if (EXTENSIONS.indexOf(ext) === -1) {
        problems.push(file.name + " is not an EPUB, PDF or DOCX file.");
        return;
      }
      if (file.size > MAX_BYTES) {
        problems.push(file.name + " is larger than 90 MB.");
        return;
      }
      var path;
      if (!used[ext]) {
        path = slug + "." + ext;
        used[ext] = true;
      } else {
        path = file.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "");
      }
      if (taken[path]) {
        problems.push(file.name + " would overwrite " + path + ".");
        return;
      }
      taken[path] = true;
      items.push({ file: file, path: path, ext: ext, renamed: path !== file.name });
    });
    return { items: items, problems: problems };
  }

  /** @returns {Promise} resolves after the given milliseconds */
  function wait(ms) {
    return new Promise(function later(resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Create a book: start the action, wait for it, upload the files.
   * @param {object} deps
   * @param {function(string, string, object=): Promise<{status: number, data: *}>} deps.api
   *   a GitHub call: (method, path, body) -> status and parsed JSON
   * @param {function(File): Promise<string>} deps.readBase64  a file's content as base64
   * @param {function(number): Promise} [deps.sleep]  pause (tests make it instant)
   * @param {string} deps.owner  the account that owns the repos
   * @param {string} deps.pipeline  "owner/book-pipeline"
   * @param {string} deps.name  the book name
   * @param {string} deps.subject  the subject site name
   * @param {object[]} deps.items  from planFiles
   * @param {function(string): void} [deps.onStep]  progress text
   * @returns {Promise<{slug: string, runUrl: string}>}
   */
  function createBook(deps) {
    var api = deps.api;
    var sleep = deps.sleep || wait;
    var step = deps.onStep || function none() {};
    var slug = slugOf(deps.name);
    var pipeline = deps.pipeline;
    var runsPath = "/repos/" + pipeline + "/actions/workflows/" + WORKFLOW + "/runs" +
      "?event=workflow_dispatch&per_page=10";
    var before = {};
    var run = null;

    function fail(message) { throw new Error(message); }

    return Promise.resolve().then(function check() {
      if (!slug) { fail("That name leaves no letters or digits for a repo name."); }
      return api("GET", "/repos/" + deps.owner + "/" + slug);
    }).then(function free(reply) {
      if (reply.status !== 404) { fail("A repo called " + slug + " already exists."); }
      return api("GET", "/repos/" + pipeline);
    }).then(function pipelineRepo(reply) {
      if (reply.status !== 200) {
        fail("The token cannot see " + pipeline + " (needs Actions: read and write).");
      }
      deps.branch = reply.data.default_branch;
      return api("GET", runsPath);
    }).then(function known(reply) {
      ((reply.data && reply.data.workflow_runs) || []).forEach(function each(item) {
        before[item.id] = true;
      });
      step("Starting the Create book action");
      return api("POST", "/repos/" + pipeline + "/actions/workflows/" + WORKFLOW +
        "/dispatches", { ref: deps.branch,
          inputs: { book_name: deps.name, subject: deps.subject } });
    }).then(function started(reply) {
      if (reply.status !== 204) {
        fail("GitHub refused to start the action (" + reply.status + "). " +
          ((reply.data && reply.data.message) || ""));
      }
      return findRun(0);
    }).then(function followed() {
      return followRun(0);
    }).then(function created() {
      return uploadAll(0);
    }).then(function done() {
      return { slug: slug, runUrl: run && run.html_url };
    });

    /** Find the run this click started: the newest one we had not seen. */
    function findRun(attempt) {
      return sleep(attempt ? 3000 : 1500).then(function look() {
        return api("GET", runsPath);
      }).then(function seen(reply) {
        var fresh = ((reply.data && reply.data.workflow_runs) || []).filter(function not(item) {
          return !before[item.id];
        });
        if (fresh.length) { run = fresh[0]; return null; }
        if (attempt >= 20) { fail("The action did not start. Check the pipeline repo."); }
        return findRun(attempt + 1);
      });
    }

    /** Wait until the run is over. */
    function followRun(attempt) {
      if (run.status === "completed") {
        if (run.conclusion !== "success") {
          fail("The Create book action ended with " + run.conclusion + ". Open it: " + run.html_url);
        }
        return null;
      }
      if (attempt >= 100) { fail("The action is taking too long. Open it: " + run.html_url); }
      step("Creating the repo and its settings");
      return sleep(3000).then(function poll() {
        return api("GET", "/repos/" + pipeline + "/actions/runs/" + run.id);
      }).then(function now(reply) {
        if (reply.status === 200) { run = reply.data; }
        return followRun(attempt + 1);
      });
    }

    /** Upload the files one after the other (parallel commits collide). */
    function uploadAll(index) {
      if (index >= deps.items.length) { return null; }
      var item = deps.items[index];
      step("Uploading " + (index + 1) + " of " + deps.items.length);
      return deps.readBase64(item.file).then(function content(base64) {
        return putFile(item, base64, 0);
      }).then(function next() {
        return uploadAll(index + 1);
      });
    }

    /** One file; a new repo can need a moment before it accepts files. */
    function putFile(item, base64, attempt) {
      return api("PUT", "/repos/" + deps.owner + "/" + slug + "/contents/references/" +
        encodeURIComponent(item.path), { message: "Add references", content: base64 })
        .then(function put(reply) {
          if (reply.status === 200 || reply.status === 201) { return null; }
          var again = reply.status === 404 || reply.status === 409 || reply.status >= 500;
          if (again && attempt < 5) {
            return sleep(3000).then(function retry() { return putFile(item, base64, attempt + 1); });
          }
          return fail("Could not upload " + item.path + " (" + reply.status + "). " +
            ((reply.data && reply.data.message) || ""));
        });
    }
  }

  // ----------------------------------------------------------- page helpers

  /**
   * @param {string} tag
   * @param {string=} className
   * @param {string=} text
   * @returns {HTMLElement}
   */
  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  /** @returns {Promise<string>} a file's content as base64 */
  function readBase64(file) {
    return new Promise(function read(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function done() {
        resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      };
      reader.onerror = function bad() { reject(new Error("Could not read " + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * A GitHub call with the admin's token.
   * @param {string} token
   * @returns {function(string, string, object=): Promise<{status: number, data: *}>}
   */
  function githubWith(token) {
    return function call(method, path, body) {
      var init = {
        method: method,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      };
      if (body) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return fetch(API + path, init).then(function reply(response) {
        if (response.status === 204) { return { status: 204, data: null }; }
        return response.json().catch(function none() { return null; })
          .then(function data(parsed) { return { status: response.status, data: parsed }; });
      });
    };
  }

  // -------------------------------------------------------- saved settings

  /** @returns {*} this admin's Firestore document reference */
  function secretsRef() {
    return ctx.fs.doc(ctx.db, SECRETS, ctx.user.uid);
  }

  /** Read the saved token and the books being built. */
  function load() {
    return ctx.fs.getDoc(secretsRef()).then(function got(snapshot) {
      var data = snapshot.exists() ? snapshot.data() : {};
      saved = { githubToken: data.githubToken || "", pending: data.pending || [] };
      var published = options.isPublished || function no() { return false; };
      var left = saved.pending.filter(function keep(entry) { return !published(entry.slug); });
      if (left.length !== saved.pending.length) {
        saved.pending = left;
        return save();
      }
      return null;
    });
  }

  /** Write the saved settings back (merging, so nothing else is lost). */
  function save() {
    return ctx.fs.setDoc(secretsRef(), saved, { merge: true });
  }

  // ----------------------------------------------------------------- the UI

  var dialog = null;
  var lastFocus = null;

  /** Close the dialog and give the focus back. */
  function close() {
    if (dialog) { dialog.remove(); dialog = null; }
    document.removeEventListener("keydown", onKey);
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); }
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.key === "Escape") { close(); }
  }

  /**
   * Open the dialog and show one screen at a time.
   * @param {string} title  the screen's heading
   * @param {string} stepText  for example "Step 1 of 2" ("" for none)
   * @param {number} progress  0 to 1 for the bar, or -1 for no bar
   * @returns {HTMLElement} the body to fill
   */
  function screen(title, stepText, progress) {
    if (!dialog) {
      lastFocus = document.activeElement;
      dialog = make("div", "ab-backdrop");
      document.body.appendChild(dialog);
      document.addEventListener("keydown", onKey);
    }
    dialog.textContent = "";
    var box = make("div", "ab-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Add a book");
    var head = make("div", "ab-head");
    var closer = make("button", "ab-close", "×");
    closer.type = "button";
    closer.setAttribute("aria-label", "Close");
    closer.addEventListener("click", close);
    head.appendChild(make("h2", null, title));
    if (stepText) { head.appendChild(make("span", "ab-step", stepText)); }
    head.appendChild(closer);
    box.appendChild(head);
    if (progress >= 0) {
      var bar = make("div", "ab-bar");
      var fill = make("div", "ab-bar-fill");
      fill.style.width = Math.round(progress * 100) + "%";
      bar.appendChild(fill);
      box.appendChild(bar);
    }
    var body = make("div", "ab-body");
    box.appendChild(body);
    dialog.appendChild(box);
    return body;
  }

  /**
   * @param {string} text
   * @param {string} kind  "primary" or "plain"
   * @param {function(): void} onClick
   * @returns {HTMLButtonElement}
   */
  function button(text, kind, onClick) {
    var node = make("button", "ab-button ab-" + kind, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  /** Screen: paste the GitHub token once. */
  function tokenScreen(next) {
    var body = screen("Add a book", "", -1);
    var warning = make("div", "ab-note ab-warn");
    warning.appendChild(make("strong", null, "GitHub is not connected"));
    warning.appendChild(make("p", null, "Adding a book needs permission to create repos, start " +
      "the Create book action and push files. Add a token once; it is kept on your account only."));
    body.appendChild(warning);
    var label = make("label", "ab-label", "GitHub token");
    label.setAttribute("for", "ab-token");
    var input = make("input", "ab-input ab-mono");
    input.id = "ab-token";
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("spellcheck", "false");
    body.appendChild(label);
    body.appendChild(input);
    body.appendChild(make("p", "ab-hint", "Fine-grained, for your repos: Administration, " +
      "Contents, Actions (read and write) and Metadata (read)."));
    var list = make("ul", "ab-list");
    ["In your private account data, readable only when you are signed in as the admin",
      "Never in a repo, never on the page", "Remove it any time from the admin settings"]
      .forEach(function add(line) { list.appendChild(make("li", null, line)); });
    body.appendChild(list);
    var message = make("p", "ab-error");
    message.setAttribute("role", "alert");
    body.appendChild(message);
    var go = button("Save and continue", "primary", function store() {
      var value = input.value.trim();
      if (!value) { message.textContent = "Paste the token first."; return; }
      go.disabled = true;
      githubWith(value)("GET", "/user").then(function who(reply) {
        if (reply.status !== 200) {
          throw new Error("GitHub did not accept that token.");
        }
        saved.githubToken = value;
        return save();
      }).then(next).catch(function bad(problem) {
        go.disabled = false;
        message.textContent = problem.message;
      });
    });
    body.appendChild(go);
    body.appendChild(button("Not now", "plain", close));
    input.focus();
  }

  /** Screen 1: name and subject. */
  function nameScreen(state, api) {
    var body = screen("Add a book", "Step 1 of 2", 0.5);
    var label = make("label", "ab-label", "Book name");
    label.setAttribute("for", "ab-name");
    var input = make("input", "ab-input");
    input.id = "ab-name";
    input.value = state.name || "";
    input.autocomplete = "off";
    body.appendChild(label);
    body.appendChild(input);
    var line = make("div", "ab-repo");
    var slugBox = make("span", "ab-mono ab-chip", "");
    var checkBox = make("span", "ab-check", "");
    checkBox.setAttribute("aria-live", "polite");
    line.appendChild(make("span", null, "Repo"));
    line.appendChild(slugBox);
    line.appendChild(checkBox);
    body.appendChild(line);

    body.appendChild(make("div", "ab-label", "Subject"));
    var chips = make("div", "ab-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Subject");
    body.appendChild(chips);
    var hint = make("p", "ab-hint", "Loading your subjects…");
    body.appendChild(hint);
    body.appendChild(make("div", "ab-note", "Creates a private repo from the book template, " +
      "with the book and subject topics, the key and the pull request settings."));

    var message = make("p", "ab-error");
    message.setAttribute("role", "alert");
    body.appendChild(message);
    var go = button("Continue to files", "primary", function forward() {
      state.name = input.value.trim();
      state.slug = slugOf(state.name);
      if (!state.slug) { message.textContent = "Type the book's name."; return; }
      if (!state.subject) { message.textContent = "Pick a subject."; return; }
      if (state.free === false) { message.textContent = "That repo name is taken."; return; }
      filesScreen(state, api);
    });
    body.appendChild(go);
    body.appendChild(button("Cancel", "plain", close));

    var timer = null;
    /** Show the repo name and whether it is free. */
    function refresh() {
      var slug = slugOf(input.value);
      slugBox.textContent = slug || "–";
      checkBox.textContent = "";
      checkBox.className = "ab-check";
      state.free = null;
      clearTimeout(timer);
      if (!slug) { return; }
      checkBox.textContent = "Checking…";
      timer = setTimeout(function ask() {
        api("GET", "/repos/" + state.owner + "/" + slug).then(function answer(reply) {
          if (slugOf(input.value) !== slug) { return; }
          state.free = reply.status === 404;
          checkBox.textContent = state.free ? "Name is free" : "Already exists";
          checkBox.className = "ab-check " + (state.free ? "ab-ok" : "ab-bad");
        }).catch(function none() { checkBox.textContent = ""; });
      }, 400);
    }
    input.addEventListener("input", refresh);
    refresh();
    input.focus();

    /** Draw the subject chips. */
    function drawChips() {
      chips.textContent = "";
      state.subjects.forEach(function each(name) {
        var chip = make("button", "ab-subject", name);
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(state.subject === name));
        chip.addEventListener("click", function pick() {
          state.subject = name;
          drawChips();
        });
        chips.appendChild(chip);
      });
    }
    if (state.subjects) {
      hint.textContent = "The list comes from your repos tagged subject.";
      drawChips();
    } else {
      api("GET", "/search/repositories?q=" + encodeURIComponent("topic:subject user:" + state.owner) +
        "&per_page=30").then(function found(reply) {
        var names = ((reply.data && reply.data.items) || []).map(function each(item) {
          return item.name;
        }).sort();
        state.subjects = names;
        if (!state.subject && names.indexOf(options.subjectRepo) !== -1) {
          state.subject = options.subjectRepo;
        }
        hint.textContent = names.length ? "The list comes from your repos tagged subject." :
          "No repos tagged subject were found.";
        drawChips();
      }).catch(function bad() { hint.textContent = "Could not load the subjects."; });
    }
  }

  /** Screen 2: choose the files. */
  function filesScreen(state, api) {
    var body = screen("Add files", "Step 2 of 2", 1);
    var who = make("p", "ab-for");
    who.appendChild(document.createTextNode("For "));
    who.appendChild(make("strong", null, state.name));
    who.appendChild(document.createTextNode(" in " + state.subject));
    body.appendChild(who);

    var drop = make("div", "ab-drop");
    drop.appendChild(make("strong", null, "Add EPUB, PDF or DOCX"));
    drop.appendChild(make("span", "ab-hint", "Drop files here, or choose them from your device"));
    var picker = make("input");
    picker.type = "file";
    picker.multiple = true;
    picker.accept = ".epub,.pdf,.docx";
    picker.hidden = true;
    var choose = button("Choose files", "plain", function open() { picker.click(); });
    drop.appendChild(choose);
    drop.appendChild(picker);
    body.appendChild(drop);
    var listBox = make("ul", "ab-files");
    body.appendChild(listBox);
    body.appendChild(make("div", "ab-note", "Files go to the private book repo only. " +
      "The site publishes just the encrypted build. EPUB is used for the build; " +
      "PDF and DOCX are kept as fallbacks."));
    var message = make("p", "ab-error");
    message.setAttribute("role", "alert");
    body.appendChild(message);

    var chosen = state.files || [];
    /** Redraw the list of chosen files. */
    function draw() {
      var plan = planFiles(state.slug, chosen);
      listBox.textContent = "";
      plan.items.forEach(function each(item) {
        var row = make("li", "ab-file");
        row.appendChild(make("span", "ab-mono ab-grow", item.path));
        row.appendChild(make("span", "ab-hint", (item.file.size / 1048576).toFixed(1) + " MB"));
        if (item.renamed) {
          row.appendChild(make("span", "ab-hint", "was " + item.file.name));
        }
        var remove = make("button", "ab-remove", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove " + item.path);
        remove.addEventListener("click", function drop() {
          chosen = chosen.filter(function not(file) { return file !== item.file; });
          draw();
        });
        row.appendChild(remove);
        listBox.appendChild(row);
      });
      message.textContent = plan.problems.join(" ");
      state.plan = plan;
    }
    /** @param {FileList} files */
    function add(files) {
      Array.prototype.forEach.call(files, function each(file) { chosen.push(file); });
      draw();
    }
    picker.addEventListener("change", function pick() { add(picker.files); picker.value = ""; });
    drop.addEventListener("dragover", function over(event) { event.preventDefault(); });
    drop.addEventListener("drop", function dropped(event) {
      event.preventDefault();
      add(event.dataTransfer.files);
    });
    draw();

    /** @param {boolean} withFiles */
    function create(withFiles) {
      state.files = chosen;
      if (state.plan.problems.length) { return; }
      state.items = withFiles ? state.plan.items : [];
      workingScreen(state, api);
    }
    body.appendChild(button("Create book", "primary", function make1() {
      if (!state.plan.items.length) { message.textContent = "Add a file, or use Create without files."; return; }
      create(true);
    }));
    body.appendChild(button("Create without files", "plain", function make2() { create(false); }));
    body.appendChild(button("Back", "plain", function back() { nameScreen(state, api); }));
  }

  /** Screen 3: working. */
  function workingScreen(state, api) {
    var body = screen("Creating " + state.name, "", -1);
    body.appendChild(make("p", "ab-hint", "This keeps going on GitHub if you leave this page."));
    var status = make("p", "ab-working", "Starting…");
    status.setAttribute("role", "status");
    body.appendChild(status);
    var message = make("p", "ab-error");
    message.setAttribute("role", "alert");
    body.appendChild(message);

    createBook({
      api: api,
      readBase64: readBase64,
      owner: state.owner,
      pipeline: options.pipeline || state.owner + "/book-pipeline",
      name: state.name,
      subject: state.subject,
      items: state.items,
      onStep: function progress(text) { status.textContent = text + "…"; },
    }).then(function done(result) {
      saved.pending = saved.pending.filter(function other(entry) { return entry.slug !== result.slug; });
      saved.pending.push({ slug: result.slug, title: state.name, subject: state.subject,
        owner: state.owner, at: new Date().toISOString(), files: state.items.map(function name(item) { return item.path; }) });
      return save().catch(function ignore() { /* the book exists either way */ }).then(function show() {
        if (options.onChange) { options.onChange(); }
        doneScreen(state, result);
      });
    }).catch(function failed(problem) {
      status.textContent = "";
      message.textContent = problem.message;
      body.appendChild(button("Try again", "primary", function again() { nameScreen(state, api); }));
      body.appendChild(button("Close", "plain", close));
    });
  }

  /** Screen 4: done. */
  function doneScreen(state, result) {
    var body = screen(state.name + " is created", "", -1);
    body.appendChild(make("p", null, state.items.length ?
      state.items.length + " file" + (state.items.length === 1 ? "" : "s") + " uploaded to references/." :
      "No files yet. Add them to references/ in the repo."));
    body.appendChild(make("p", "ab-hint", "The book shows on your shelf as \"Not published yet\" " +
      "until its encrypted build is published."));
    var open = make("a", "ab-button ab-primary", "Open the repo");
    open.href = "https://github.com/" + state.owner + "/" + result.slug;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    body.appendChild(open);
    body.appendChild(button("Back to the shelf", "plain", close));
  }

  /**
   * Open the dialog.
   * @returns {Promise} resolves once the first screen is shown
   */
  function open() {
    var token = saved.githubToken;
    var state = { files: [] };
    /** Find out who the token belongs to, then start. */
    function start() {
      var api = githubWith(saved.githubToken);
      return api("GET", "/user").then(function who(reply) {
        if (reply.status !== 200) { saved.githubToken = ""; return tokenScreen(start); }
        state.owner = reply.data.login;
        return nameScreen(state, api);
      });
    }
    return token ? start() : Promise.resolve(tokenScreen(start));
  }

  /** @returns {object[]} the books being built, newest first */
  function pending() {
    return saved.pending.slice().reverse();
  }

  /**
   * The shelf's "being built" card for one entry.
   * @param {{slug: string, title: string, subject: string, owner: string, files: string[]}} entry
   * @returns {HTMLElement} an li
   */
  function pendingCard(entry) {
    var item = make("li", "ab-pending");
    item.appendChild(make("span", "ab-badge", "Not published yet"));
    item.appendChild(make("strong", "ab-title", entry.title));
    item.appendChild(make("span", "ab-hint", entry.subject + " · " +
      (entry.files && entry.files.length ? "files uploaded" : "no files yet")));
    var actions = make("div", "ab-actions");
    var repo = make("a", "ab-button ab-plain", "Open repo");
    repo.href = "https://github.com/" + (entry.owner || "") + "/" + entry.slug;
    repo.target = "_blank";
    repo.rel = "noopener noreferrer";
    var dismiss = make("button", "ab-button ab-plain", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", function drop() {
      saved.pending = saved.pending.filter(function other(one) { return one.slug !== entry.slug; });
      save().then(function done() { if (options.onChange) { options.onChange(); } });
    });
    actions.appendChild(repo);
    actions.appendChild(dismiss);
    item.appendChild(actions);
    return item;
  }

  /** @returns {HTMLElement} the dashed "Add book" tile (an li) */
  function tile() {
    var item = make("li", "ab-tile");
    var tileButton = make("button", "ab-tile-button");
    tileButton.type = "button";
    tileButton.appendChild(make("span", "ab-plus", "+"));
    tileButton.appendChild(make("span", null, "Add book"));
    tileButton.appendChild(make("span", "ab-hint", "Only you see this, while Admin mode is on"));
    tileButton.addEventListener("click", open);
    item.appendChild(tileButton);
    return item;
  }

  /**
   * @param {{user: object, db: object, fs: object}} context  from hub.js
   * @param {{subjectRepo: string, pipeline: string, isPublished: function(string): boolean,
   *   onChange: function}} setup
   * @returns {Promise} resolves when the saved settings are read
   */
  function init(context, setup) {
    ctx = context;
    options = setup || {};
    return load();
  }

  root.SubjectAddBook = {
    init: init, open: open, tile: tile, pending: pending, pendingCard: pendingCard,
    ready: function ready() { return !!ctx; },
    slugOf: slugOf, planFiles: planFiles, createBook: createBook,
  };
}(typeof window !== "undefined" ? window : this));
