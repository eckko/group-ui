/*
 * status.js: the admin "Status" view of a subject hub (book build status).
 *
 * Loaded by js/hub.js only for a signed-in admin who turned Admin mode on in
 * the gear; every other reader never downloads it. Source of truth:
 * https://github.com/eckko/group-ui.
 *
 * Where the data comes from (Firestore, one document per book repo):
 *   bookStatus/<book folder>
 *     auto      written by the book-pipeline "Check books" workflow: which
 *               files exist and a hash of each (see tools/book_status.py there)
 *     signoffs  written here when the admin taps ✓ or ✗:
 *               { <stage>_<format>: { result ("ok"|"error", absent = ok), hash, basedOn, verifiedAt, verifiedBy } }
 *               Only the latest sign-off per item is kept.
 * Nothing is stored as "verified" or "stale": the state is worked out on every
 * read by comparing the sign-off's hash with the current one, so a tick can
 * never go out of date. Notes and the quiz also remember the structure hash
 * they were checked against (basedOn), so they go stale when it changes.
 *
 * No book content lives in this file. Plain ES5-style browser code.
 */
(function statusModule(root) {
  "use strict";

  var STAGES = [["files", "Files"], ["structure", "Structure"],
    ["notes", "Notes"], ["quiz", "Quiz"]];
  var FORMATS = ["epub", "pdf", "docx"];
  var FORMAT_NAMES = { epub: "EPUB", pdf: "PDF", docx: "DOCX" };
  var DEFAULT_WORKFLOW =
    "https://github.com/eckko/book-pipeline/actions/workflows/check-books.yml";

  // ------------------------------------------------ the state (pure code)

  /** @returns {string} the id of one signed-off item, such as "notes_epub" */
  function itemId(stage, format) {
    return format ? stage + "_" + format : stage;
  }

  /**
   * @param {{present: boolean, hash: string}} fact  what the pipeline saw
   * @param {object|undefined} signoff  the admin's latest sign-off
   * @param {string|null|undefined} basedOn  the structure hash it must match
   *   (undefined when the item does not depend on the structure)
   * @returns {{state: string, reason: (string|undefined)}} state is none
   *   (nothing there), check (waiting for the admin), ok or stale
   */
  function itemState(fact, signoff, basedOn) {
    if (!fact || !fact.present) { return { state: "none" }; }
    if (!signoff) { return { state: "check" }; }
    if (signoff.hash !== fact.hash) {
      return { state: "stale", reason: "hash_changed" };
    }
    if (basedOn !== undefined && (signoff.basedOn || null) !== (basedOn || null)) {
      return { state: "stale", reason: "structure_changed" };
    }
    if (signoff.result === "error") { return { state: "stale", reason: "marked_error" }; }
    return { state: "ok" };
  }

  /**
   * @param {string} key  files, structure, notes or quiz
   * @param {object} auto  the pipeline's facts
   * @param {object} signoffs  the admin's sign-offs by item id
   * @returns {object} the stage with its items and its two states:
   *   auto: ok | fail (a required file is missing) | none (not there yet)
   *   manual: ok | check | stale | none
   */
  function deriveStage(key, auto, signoffs) {
    var facts = auto[key] || {};
    var structureHash = (auto.structure || {}).hash || null;
    var basedOn = (key === "notes" || key === "quiz") ? structureHash : undefined;
    var required = (auto.required || {})[key] || [];
    var items = [];
    if (key === "files" || key === "notes") {
      FORMATS.forEach(function each(format) {
        var fact = (facts.formats || {})[format] || { present: false };
        var id = itemId(key, format);
        var result = itemState(fact, signoffs[id], basedOn);
        items.push({
          id: id, stage: key, format: format, label: FORMAT_NAMES[format],
          present: !!fact.present, required: required.indexOf(format) !== -1,
          name: fact.name || "", hash: fact.hash || null,
          state: result.state, reason: result.reason, signoff: signoffs[id],
          basedOn: basedOn,
        });
      });
    } else {
      var one = itemState(facts, signoffs[key], basedOn);
      items.push({
        id: key, stage: key, format: "", label: key === "quiz" ? "Quiz" : "Structure",
        present: !!facts.present, required: true, name: "", hash: facts.hash || null,
        state: one.state, reason: one.reason, signoff: signoffs[key], basedOn: basedOn,
      });
    }
    var present = items.filter(function has(item) { return item.present; });
    var missing = items.filter(function lack(item) {
      return item.required && !item.present;
    });
    var manual = "none";
    if (present.length) {
      manual = "ok";
      present.forEach(function worst(item) {
        if (item.state === "stale") { manual = "stale"; }
        else if (item.state === "check" && manual !== "stale") { manual = "check"; }
      });
    }
    return {
      key: key, name: nameOf(key), items: items, missing: missing,
      auto: !present.length ? "none" : missing.length ? "fail" : "ok",
      manual: manual,
    };
  }

  /** @returns {string} the stage's display name */
  function nameOf(key) {
    for (var i = 0; i < STAGES.length; i += 1) {
      if (STAGES[i][0] === key) { return STAGES[i][1]; }
    }
    return key;
  }

  /**
   * @param {object|undefined} doc  bookStatus/<folder>, or undefined
   * @returns {object} stages, counts and the headline for the card
   */
  function derive(doc) {
    var auto = (doc && doc.auto) || {};
    var signoffs = (doc && doc.signoffs) || {};
    var stages = STAGES.map(function each(stage) {
      return deriveStage(stage[0], auto, signoffs);
    });
    var out = {
      known: !!(doc && doc.auto), stages: stages,
      autoDone: stages.filter(function ok(s) { return s.auto === "ok"; }).length,
      manualDone: stages.filter(function ok(s) { return s.manual === "ok"; }).length,
    };
    stages.forEach(function mark(stage) { stage.known = out.known; });
    out.headline = headline(out);
    return out;
  }

  /** @returns {{kind: string, text: string}} the one chip for a book */
  function headline(info) {
    if (!info.known) { return { kind: "none", text: "Not checked yet" }; }
    var i;
    var stage;
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      if (stage.manual === "stale") {
        return { kind: "attn", text: "Re-check " + stage.name.toLowerCase() };
      }
    }
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      if (stage.auto === "fail") {
        var lack = stage.missing[0];
        return { kind: "attn", text: (lack.format ? lack.label : stage.name) + " missing" };
      }
    }
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      if (stage.manual === "check") {
        return { kind: "check", text: "Your check: " + stage.name.toLowerCase() };
      }
    }
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      if (stage.auto === "none") {
        return { kind: "none", text: i === 0 ? "Not started" :
          stage.key === "quiz" ? "No quiz yet" : stage.name + " not built yet" };
      }
    }
    return { kind: "ok", text: "All done" };
  }

  /** @returns {string[]} what to do for a stage that needs attention */
  function stepsFor(stage) {
    var needs = stage.items.filter(function bad(item) {
      return item.state === "stale" || item.state === "check";
    });
    var steps = [];
    if (stage.missing.length) {
      steps.push("Add the missing " + stage.missing.map(function name(item) {
        return item.label;
      }).join(" and ") + " to references/ in the book repo.");
      steps.push("The nightly check will see it, or tap Re-run checks.");
    }
    if (needs.length) {
      var what = needs[0].format ? "the " + stage.name.toLowerCase() + " " + needs[0].label :
        "the " + stage.name.toLowerCase();
      steps.push("Open " + what + " in the reader.");
      steps.push(stage.key === "notes" || stage.key === "quiz" ?
        "Look over the headings against the book structure." :
        "Look it over.");
      steps.push("Tap ✓ " + (needs[0].format ? "on the " + needs[0].label + " " : "") + "if it is right, or ✗ if it has an error.");
    }
    return steps;
  }

  var api = {
    itemId: itemId, itemState: itemState, deriveStage: deriveStage,
    derive: derive, headline: headline, stepsFor: stepsFor,
    STAGES: STAGES, FORMATS: FORMATS,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  // ------------------------------------------------------------ the UI

  var ctx = null;                     // { user, db, fs } from hub.js
  var options = {};                   // { workflowUrl, onChange }
  var docs = {};                      // bookStatus documents by folder
  var page = null;                    // the open full page, if any
  var opener = null;
  var opened = {};                    // cards the admin opened or shut by hand

  /** @returns {HTMLElement} */
  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  /** @returns {Date|null} */
  function toDate(value) {
    if (!value) { return null; }
    if (typeof value.toDate === "function") { return value.toDate(); }
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  /** @returns {string} "3 Nov" (or "3 Nov, 06:02" with the time) */
  function when(value, withTime) {
    var date = toDate(value);
    if (!date) { return ""; }
    var text = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return withTime ? text + ", " + date.toLocaleTimeString(undefined,
      { hour: "2-digit", minute: "2-digit" }) : text;
  }

  /** @returns {string} the CSS class of one segment of the two bars */
  function segClass(state) { return "st-seg st-" + state; }

  /** Read every bookStatus document once. @returns {Promise} */
  function load() {
    return ctx.fs.getDocs(ctx.fs.collection(ctx.db, "bookStatus")).then(function got(snapshot) {
      docs = {};
      snapshot.forEach(function each(item) { docs[item.id] = item.data(); });
    });
  }

  /**
   * Save the admin's sign-off for one item, then reload that book.
   * @returns {Promise}
   */
  function sign(book, item, result) {
    var change = {};
    change["signoffs." + item.id] = {
      result: result === "error" ? "error" : "ok", hash: item.hash, basedOn: item.basedOn === undefined ? null : item.basedOn,
      verifiedAt: ctx.fs.serverTimestamp(),
      verifiedBy: ctx.user.email || ctx.user.uid,
    };
    var ref = ctx.fs.doc(ctx.db, "bookStatus", book.folder);
    return ctx.fs.updateDoc(ref, change).then(function reload() {
      return ctx.fs.getDoc(ref);
    }).then(function fresh(snapshot) {
      docs[book.folder] = snapshot.data();
    });
  }

  /** @returns {object} the derived status of a book */
  function infoFor(book) { return derive(docs[book.folder]); }

  /**
   * The footer band of a book card or list row.
   * @returns {HTMLElement}
   */
  function band(book) {
    var info = infoFor(book);
    var box = make("div", "st-band");
    var line = make("div", "st-band-row");
    line.appendChild(make("span", "st-chip st-chip-" + info.headline.kind, info.headline.text));
    var segs = make("span", "st-segs");
    info.stages.forEach(function each(stage) {
      var seg = make("span", "st-pair");
      seg.title = stage.name;
      seg.appendChild(make("span", segClass(stage.auto)));
      seg.appendChild(make("span", segClass(stage.manual)));
      segs.appendChild(seg);
    });
    segs.setAttribute("aria-hidden", "true");
    line.appendChild(segs);
    var open = make("button", "st-open", "Status ›");
    open.type = "button";
    open.setAttribute("aria-label", "Status of " + book.title + ": " + info.headline.text);
    open.addEventListener("click", function go() { openPage(book, open); });
    line.appendChild(open);
    box.appendChild(line);
    box.appendChild(make("span", "st-counts", info.known ?
      "Auto-checked " + info.autoDone + " of 4 · You verified " + info.manualDone + " of 4" :
      "The nightly check has not seen this book yet"));
    return box;
  }

  /**
   * A status dot for the compact list: tap it to open the status page.
   * @returns {HTMLElement}
   */
  function dot(book) {
    var info = infoFor(book);
    var button = make("button", "st-dotbtn");
    button.type = "button";
    button.setAttribute("aria-label", "Status of " + book.title + ": " + info.headline.text);
    button.appendChild(make("span", "st-dot st-chip-" + info.headline.kind));
    button.addEventListener("click", function go() { openPage(book, button); });
    return button;
  }

  // ---------------------------------------------------- the full page

  /** @returns {{kind: string, title: string, text: string, item: object}|null} */
  function nextStep(info, book) {
    var i;
    var j;
    var stage;
    var item;
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      for (j = 0; j < stage.items.length; j += 1) {
        item = stage.items[j];
        if (item.state === "stale") {
          var was = item.signoff && when(item.signoff.verifiedAt);
          var thing = (item.format ? stage.name.toLowerCase() + " " + item.label : stage.name.toLowerCase());
          return {
            kind: "attn", item: item, stage: stage,
            title: (item.reason === "marked_error" ? "Fix the " : "Look at the ") + thing +
              (item.reason === "marked_error" ? "" : " again"),
            text: item.reason === "marked_error" ? "You marked it as having an error" + (was ? " on " + was : "") + "." :
              (item.reason === "structure_changed" ?
              "The book structure changed after you verified it" :
              "It changed after you verified it") + (was ? " on " + was : "") + ".",
          };
        }
      }
    }
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      if (stage.missing.length) {
        return {
          kind: "attn", item: null, stage: stage,
          title: "Add the " + stage.missing[0].label + (stage.key === "notes" ? " notes" : ""),
          text: "The book repo has no " + stage.missing[0].label + " yet.",
        };
      }
    }
    for (i = 0; i < info.stages.length; i += 1) {
      stage = info.stages[i];
      for (j = 0; j < stage.items.length; j += 1) {
        item = stage.items[j];
        if (item.state === "check") {
          return {
            kind: "check", item: item, stage: stage,
            title: "Check the " + (item.format ? stage.name.toLowerCase() + " " + item.label : stage.name.toLowerCase()),
            text: "The auto-check is done. It needs your eyes in the reader.",
          };
        }
      }
    }
    return null;
  }

  /** @returns {string} the link that opens a book's reader or quiz */
  function readerLink(book, stage) {
    var view = stage && stage.key === "quiz" ? "quiz" : "read";
    return options.bookLink ? options.bookLink(book, view) :
      encodeURIComponent(book.folder) + "/index.html?view=" + view;
  }

  /** @returns {HTMLElement} one stage card of the full page */
  function stageCard(book, stage, redraw) {
    /* Open by default only when something is wrong; a stage that just waits
       for your check stays closed. */
    var needs = stage.auto === "fail" || stage.manual === "stale";
    var flag = opened[book.folder + "/" + stage.key];
    var open = flag === undefined ? needs : flag;
    var kind = (stage.auto === "fail" || stage.manual === "stale") ? "attn" :
      stage.manual === "check" ? "check" : stage.manual === "ok" ? "ok" : "none";
    var card = make("section", "st-card st-card-" + kind);
    var head = make("button", "st-card-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.appendChild(make("span", "st-num st-num-" + kind, String(STAGES.map(function k(s) {
      return s[0];
    }).indexOf(stage.key) + 1)));
    var text = make("span", "st-card-text");
    text.appendChild(make("span", "st-card-name", stage.name));
    var tags = make("span", "st-tags");
    var autoTag = { ok: ["ok", "✓ Auto-checked"], fail: ["attn", "! Needs files"],
      none: ["none", "– Not built yet"] }[stage.auto];
    var manualTag = { ok: ["ok", "✓ You verified"], check: ["check", "Your check needed"],
      stale: ["attn", "! Needs your re-check"],
      none: ["none", "– Waiting on the build"] }[stage.manual];
    if (stage.known && stage.key === "quiz" && stage.auto === "none") {
      autoTag = ["none", "– No quiz yet"];
      manualTag = ["none", "– Waiting on the quiz"];
    }
    if (!stage.known) {
      autoTag = ["none", "– Not checked yet"];
      manualTag = ["none", "– Waiting on the check"];
    }
    tags.appendChild(make("span", "st-tag st-chip-" + autoTag[0], autoTag[1]));
    tags.appendChild(make("span", "st-tag st-chip-" + manualTag[0], manualTag[1]));
    text.appendChild(tags);
    head.appendChild(text);
    head.appendChild(make("span", "st-chev" + (open ? " st-up" : ""), "⌄"));
    head.addEventListener("click", function toggle() {
      opened[book.folder + "/" + stage.key] = !open;
      redraw();
    });
    card.appendChild(head);
    if (!open) { return card; }

    var body = make("div", "st-card-body");
    body.appendChild(make("h4", "st-sub", "Auto-checked"));
    stage.items.forEach(function each(item) {
      var good = item.present;
      var row = make("p", "st-fact");
      row.appendChild(make("span", "st-glyph " + (good ? "st-ok" : item.required ? "st-attn" : "st-none"),
        good ? "✓" : item.required ? "!" : "–"));
      row.appendChild(make("span", null, item.label + (good ? " found" + (item.name ? " (" + item.name + ")" : "") :
        item.required ? " is missing" : " not added (optional)")));
      body.appendChild(row);
    });
    body.appendChild(make("h4", "st-sub", "You verified"));
    stage.items.filter(function has(item) { return item.present; }).forEach(function each(item) {
      var row = make("div", "st-item st-item-" + item.state);
      var names = make("span", "st-item-names");
      names.appendChild(make("span", null, item.label + (item.name ? " (" + item.name + ")" : "")));
      var at = item.signoff && when(item.signoff.verifiedAt);
      var sub = item.state === "ok" ? "Verified " + at :
        item.state === "stale" ? (item.reason === "marked_error" ? "Error marked " + at :
          item.reason === "structure_changed" ? "Structure changed since " + at :
          "File changed since " + at) :
        "Not checked yet";
      names.appendChild(make("small", item.state === "stale" ? "st-attn-text" : null, sub));
      row.appendChild(names);
      var link = make("a", "st-mini", "Open");
      link.href = readerLink(book, stage);
      link.setAttribute("aria-label", "Open " + item.label + " in reader");
      row.appendChild(link);
      [["ok", "✓", "Mark " + item.label + " verified"], ["error", "✗", "Mark " + item.label + " as error"]]
        .forEach(function each(def) {
          var on = def[0] === "ok" ? item.state === "ok" :
            item.state === "stale" && item.reason === "marked_error";
          var mark = make("button", "st-mark st-mark-" + def[0] + (on ? " st-on" : ""), def[1]);
          mark.type = "button";
          mark.setAttribute("aria-label", def[2]);
          mark.setAttribute("aria-pressed", on ? "true" : "false");
          mark.addEventListener("click", function save() {
            mark.disabled = true;
            sign(book, item, def[0]).then(function done() {
              redraw();
              if (options.onChange) { options.onChange(); }
            }).catch(function failed() {
              mark.disabled = false;
              mark.title = "Could not save, try again";
              mark.textContent = "!";
            });
          });
          row.appendChild(mark);
        });
      body.appendChild(row);
    });
    card.appendChild(body);
    return card;
  }

  /** Build (or rebuild) the full status page for one book. */
  function drawPage(book, shell) {
    var info = infoFor(book);
    var doc = docs[book.folder] || {};
    shell.textContent = "";
    var top = make("div", "st-top");
    var back = make("button", "st-back", "‹ " + (options.subjectTitle || "Books"));
    back.type = "button";
    back.addEventListener("click", function close() { history.back(); });
    top.appendChild(back);
    top.appendChild(make("span", "st-chip st-chip-admin", "Admin · Status"));
    shell.appendChild(top);

    var summary = make("section", "st-summary");
    var who = make("div", "st-who");
    var tile = make("div", "st-tile", book.short);
    tile.style.background = book.colour;
    who.appendChild(tile);
    var names = make("div", "st-names");
    names.appendChild(make("h1", null, book.title));
    names.appendChild(make("p", "st-repo", book.folder));
    names.appendChild(make("span", "st-chip st-chip-" + info.headline.kind, info.headline.text));
    who.appendChild(names);
    summary.appendChild(who);
    var bars = make("div", "st-bars");
    info.stages.forEach(function each(stage) {
      var cell = make("div", "st-bar");
      var pair = make("span", "st-pair");
      pair.appendChild(make("span", segClass(stage.auto)));
      pair.appendChild(make("span", segClass(stage.manual)));
      cell.appendChild(pair);
      cell.appendChild(make("small", stage.manual === "stale" ? "st-attn-text" : null, stage.name));
      bars.appendChild(cell);
    });
    summary.appendChild(bars);
    summary.appendChild(make("p", "st-legend", "Top bar: Auto-checked " + info.autoDone +
      " of 4 · Bottom bar: You verified " + info.manualDone + " of 4"));
    var next = nextStep(info, book);
    if (next) {
      var box = make("div", "st-next st-next-" + next.kind);
      box.appendChild(make("small", null, "Next step"));
      box.appendChild(make("strong", null, next.title));
      box.appendChild(make("span", null, next.text));
      if (next.item) {
        var go = make("a", "st-btn st-primary", "Open " + next.stage.name.toLowerCase() +
          (next.item.format ? " " + next.item.label : "") + " in reader");
        go.href = readerLink(book, next.stage);
        box.appendChild(go);
      }
      summary.appendChild(box);
    }
    shell.appendChild(summary);

    info.stages.forEach(function each(stage) {
      shell.appendChild(stageCard(book, stage, function redraw() { drawPage(book, shell); }));
    });

    var pipe = make("section", "st-pipe");
    pipe.appendChild(make("small", null, "Pipeline"));
    [["Last auto-check", doc.checkedAt ? when(doc.checkedAt, true) : "never"],
      ["Build", doc.build || "–"]].forEach(function each(pair) {
      var row = make("p", "st-pipe-row");
      row.appendChild(make("span", null, pair[0]));
      row.appendChild(make("span", null, pair[1]));
      pipe.appendChild(row);
    });
    pipe.appendChild(make("p", "st-note", "Checks run on every update and every night. " +
      "Only your latest sign-off per item is kept."));
    var rerun = make("a", "st-btn", "Re-run checks ↗");
    rerun.href = options.workflowUrl || DEFAULT_WORKFLOW;
    rerun.target = "_blank";
    rerun.rel = "noopener";
    pipe.appendChild(rerun);
    pipe.appendChild(make("p", "st-note", "Opens the workflow in GitHub. Results appear here when it finishes."));
    shell.appendChild(pipe);
  }

  /** Open the full status page of one book. */
  function openPage(book, from) {
    if (page) { return; }
    opener = from || null;
    page = make("div", "st-page");
    page.setAttribute("role", "dialog");
    page.setAttribute("aria-modal", "true");
    page.setAttribute("aria-label", "Status of " + book.title);
    var shell = make("div", "st-shell");
    page.appendChild(shell);
    document.body.appendChild(page);
    document.body.style.overflow = "hidden";
    history.pushState({ subjectStatus: book.folder }, "");
    drawPage(book, shell);
    var back = shell.querySelector(".st-back");
    if (back) { back.focus(); }
  }

  /** Close the page (the browser's Back, or the page's own back button). */
  function closePage() {
    if (!page) { return; }
    page.remove();
    page = null;
    document.body.style.overflow = "";
    if (opener && document.body.contains(opener)) { opener.focus(); }
    opener = null;
    if (options.onChange) { options.onChange(); }
  }

  window.addEventListener("popstate", closePage);
  document.addEventListener("keydown", function key(event) {
    if (event.key === "Escape" && page) { history.back(); }
  });

  /**
   * @param {{user: object, db: object, fs: object}} context  from hub.js
   * @param {{workflowUrl: string, subjectTitle: string, onChange: function}} setup
   * @returns {Promise} resolves when the first read is done
   */
  function init(context, setup) {
    ctx = context;
    options = setup || {};
    return load();
  }

  root.SubjectStatus = {
    init: init, reload: load, band: band, dot: dot, openPage: openPage,
    derive: derive, ready: function ready() { return !!ctx; },
  };
}(typeof window !== "undefined" ? window : this));
