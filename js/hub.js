/*
 * hub.js: the whole UI of a subject site's hub page (the shelf).
 *
 * Source of truth: https://github.com/eckko/group-ui. A subject
 * repo has an index.html with a tiny
 * loader that reads "uiVersion" from the subject's subject.json (for example
 * "1" = the newest 1.x.x) and loads this file from jsDelivr:
 *   https://cdn.jsdelivr.net/gh/eckko/group-ui@1/js/hub.js
 * Everything else comes from here too: css/hub.css and the neutral default
 * icons in img/ (added to the page by this file, from the same version).
 * A subject gives its sign-in screen and icons their own look from its own
 * repo, through "theme" in subject.json (see README.md); the template never
 * holds one subject's look. Subject repos hold encrypted data and that theme
 * only; change the UI in this repo and release a new tag.
 *
 * What it does: nothing is shown until the reader has signed in (js/unlock.js
 * from the quiz template gets the subject key, the same way the book pages
 * do). After that it lists the books in the subject's books.json with their
 * covers, which are encrypted like everything else: each book's
 * data/manifest.enc names the cover and media/<id>_front_cover.enc is
 * decrypted in the browser. A book without a cover gets a typographic tile.
 * The reader can search, filter, sort and switch between cards, a list and a
 * compact list. Progress is read from this browser's saved quiz progress
 * (recall-quiz:<book id>). The round gear at the bottom right is the quiz
 * template's reading panel (theme, font, size...) plus "Sign out".
 *
 * Admins also get an "Admin > Book status" switch in the gear: it loads
 * js/status.js and css/status.css, which add each book's build status (see
 * README.md, "Admin book status"). Other readers never download them.
 *
 * Reads, next to the page: subject.json (title, bookDetails, theme) and books.json
 * (written by the quiz template's tools/site/build_hub.py). No book content
 * lives in this file.
 */
(function subjectSiteUi() {
  "use strict";

  /* The subject's public settings, read once (see readSettings). */
  var settingsPromise = null;

  /* The quiz template that provides sign-in, the gear and themes. */
  var QUIZ_TEMPLATE_TAG = "3.2.4";
  var JSDELIVR = "https://cdn.jsdelivr.net/gh/eckko/";
  var QUIZ_CDN = "https://cdn.jsdelivr.net/gh/eckko/item-ui@" +
    QUIZ_TEMPLATE_TAG + "/";

  /* Where this file was loaded from (the same tag of this repo). */
  var script = document.currentScript;
  var UI_BASE = script && script.src ?
    script.src.replace(/js\/hub\.js(\?.*)?$/, "") : "";

  /** The hub's markup: the sign-in screen and the shelf. */
  var MARKUP = [
    "<section id=\"gate\" aria-label=\"Sign in\">",
    "  <div class=\"gate-art\" aria-hidden=\"true\"></div>",
    "  <div class=\"gate-body\">",
    "    <h1 id=\"gateTitle\">Books</h1>",
    "    <p class=\"gate-line\">Sign in to open your books. Your account holds the key that unlocks them.</p>",
    "    <div id=\"lockslot\"><p class=\"gate-line\" id=\"gateWait\" role=\"status\">Checking sign-in…</p></div>",
    "  </div>",
    "</section>",
    "",
    "<main id=\"app\" hidden>",
    "  <header class=\"top\">",
    "    <h1 id=\"heading\">Books</h1>",
    "    <p class=\"count\" id=\"count\" aria-live=\"polite\">Checking sign-in…</p>",
    "",
    "    <p class=\"status\" id=\"status\" role=\"status\">Sign in to see your books.</p>",
    "",
    "    <div class=\"controls\" id=\"controls\" hidden>",
    "      <div class=\"row\">",
    "        <div class=\"search\">",
    "          <svg aria-hidden=\"true\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"></circle><path d=\"M20 20l-3.5-3.5\"></path></svg>",
    "          <input id=\"query\" type=\"search\" placeholder=\"Search books\" aria-label=\"Search books\" autocomplete=\"off\">",
    "        </div>",
    "        <div class=\"seg\" id=\"views\" role=\"group\" aria-label=\"Layout\">",
    "          <button type=\"button\" data-view=\"cards\" aria-label=\"Cards\" aria-pressed=\"true\"><svg aria-hidden=\"true\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"4\" width=\"7\" height=\"7\" rx=\"1.5\"></rect><rect x=\"13\" y=\"4\" width=\"7\" height=\"7\" rx=\"1.5\"></rect><rect x=\"4\" y=\"13\" width=\"7\" height=\"7\" rx=\"1.5\"></rect><rect x=\"13\" y=\"13\" width=\"7\" height=\"7\" rx=\"1.5\"></rect></svg></button>",
    "          <button type=\"button\" data-view=\"list\" aria-label=\"List\" aria-pressed=\"false\"><svg aria-hidden=\"true\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"5\" width=\"4\" height=\"5\" rx=\"1\"></rect><rect x=\"4\" y=\"14\" width=\"4\" height=\"5\" rx=\"1\"></rect><path d=\"M11 7.5h9M11 16.5h9\"></path></svg></button>",
    "          <button type=\"button\" data-view=\"compact\" aria-label=\"Compact\" aria-pressed=\"false\"><svg aria-hidden=\"true\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M5 7h14M5 12h14M5 17h14\"></path></svg></button>",
    "        </div>",
    "      </div>",
    "      <div class=\"chips\" id=\"chips\"></div>",
    "    </div>",
    "  </header>",
    "",
    "  <div id=\"shelf\" hidden>",
    "    <div id=\"books\"></div>",
    "  </div>",
    "</main>"
  ].join("\n");

  function showHub() {
    "use strict";

    /* The quiz template (reading panel, sign-in, themes), by one exact tag
       (never a branch). Change it here, in this repo, and release a new tag. */
    var CDN = QUIZ_CDN;
    var UI_KEY = "recall-hub:ui";
    var ADMIN_KEY = "recall-hub:admin";
    /* Must equal FIREBASE_VERSION in the quiz template's js/unlock.js, so the
       admin check shares the sign-in's Firebase app. */
    /* Must equal DEFAULT_CONFIG in the quiz template's js/unlock.js. */
    var FIREBASE_CONFIG = {
      apiKey: "AIzaSyBuMaFDHAx1cEvD7eInPlusJEHa2mU47Ww",
      authDomain: "reading-progress-39717.firebaseapp.com",
      projectId: "reading-progress-39717",
      storageBucket: "reading-progress-39717.firebasestorage.app",
      messagingSenderId: "180364097468",
      appId: "1:180364097468:web:448c46155e6a013b155db9",
    };
    var FIREBASE_ROOT = "https://www.gstatic.com/firebasejs/12.19.0/firebase-";
    var OPENED_KEY = "recall-hub:opened:";
    var PROGRESS_KEY = "recall-quiz:";
    var SHARED_SCRIPTS = ["js/default-settings.js", "js/themes-list.js",
      "js/theme-picker.js", "js/helpers.js", "js/reading-settings.js",
      "js/reading-panel.js"];
    var TILE_COLOURS = ["#2f4a8f", "#1f5f5b", "#8a3b2a", "#5b3f8c",
      "#8f5214", "#3d5a2a", "#7a2e55", "#2b3a4a"];
    var FILTERS = [["all", "All"], ["going", "In progress"],
      ["new", "Not started"], ["done", "Done"]];
    var SORTS = [["az", "A–Z"], ["recent", "Recent"],
      ["progress", "Progress"], ["size", "Size"]];

    var gate = document.getElementById("gate");
    var gateTitle = document.getElementById("gateTitle");
    var lockSlot = document.getElementById("lockslot");
    var app = document.getElementById("app");
    var heading = document.getElementById("heading");
    var count = document.getElementById("count");
    var status = document.getElementById("status");
    var shelf = document.getElementById("shelf");
    var chipsBox = document.getElementById("chips");
    var listBox = document.getElementById("books");
    var queryBox = document.getElementById("query");
    var viewButtons = document.querySelectorAll("#views button");

    var books = [];                    // books.json entries plus what we learn
    var ui = loadUi();
    var key = null;                    // CryptoKey once signed in
    var adminCtx = null;               // {user, db, fs} once known to be an admin
    var adminMode = loadAdminMode();   // the admin's own switch in the gear
    var adminSetup = {};               // passed to js/status.js
    var siteInfo = { ui: "", template: "" };   // uiVersion and templateTag of subject.json
    var adminError = "";
    var versions = null;               // what the CDN reports (cached for the gear)
    var gearPanel = null;

    // ---------------------------------------------------------- helpers

    /** @returns {boolean} whether this browser has Admin mode switched on */
    function loadAdminMode() {
      try {
        return localStorage.getItem(ADMIN_KEY) === "1";
      } catch (problem) {
        return false;
      }
    }

    /** @returns {{view: string, sort: string, filter: string}} */
    function loadUi() {
      var saved = {};
      try {
        saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
      } catch (problem) {
        saved = {};
      }
      return {
        view: ["cards", "list", "compact"].indexOf(saved.view) !== -1 ? saved.view : "cards",
        sort: SORTS.some(function has(s) { return s[0] === saved.sort; }) ? saved.sort : "az",
        filter: FILTERS.some(function has(f) { return f[0] === saved.filter; }) ? saved.filter : "all",
        query: "",
      };
    }

    /** Remember layout, sort and filter on this device. */
    function saveUi() {
      try {
        localStorage.setItem(UI_KEY, JSON.stringify({
          view: ui.view, sort: ui.sort, filter: ui.filter }));
      } catch (problem) {
        // storage blocked: the choice lasts until the page closes
      }
    }

    /**
     * @param {string} tag  element name
     * @param {string} [className]
     * @param {string} [text]
     * @returns {HTMLElement}
     */
    function make(tag, className, text) {
      var element = document.createElement(tag);
      if (className) {
        element.className = className;
      }
      if (text !== undefined) {
        element.textContent = text;
      }
      return element;
    }

    /** @param {string} file  @returns {Promise<object>} parsed JSON */
    function loadJson(file) {
      return fetch(file, { cache: "no-cache" }).then(function read(reply) {
        if (!reply.ok) {
          throw new Error(file + ": HTTP " + reply.status);
        }
        return reply.json();
      });
    }

    /**
     * @param {string} address
     * @returns {Promise} resolves when the classic script has run
     */
    function addScript(address) {
      return new Promise(function add(resolve, reject) {
        var script = document.createElement("script");
        script.src = address;
        script.onload = resolve;
        script.onerror = function failed() {
          reject(new Error("could not load " + address));
        };
        document.head.appendChild(script);
      });
    }

    /** @param {string} address  adds a stylesheet link */
    function addStyle(address) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = address;
      document.head.appendChild(link);
    }

    /** @param {Uint8Array} bytes  @returns {string} an image type */
    function sniff(bytes) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50) { return "image/png"; }
      if (bytes[0] === 0xff && bytes[1] === 0xd8) { return "image/jpeg"; }
      if (bytes[0] === 0x47 && bytes[1] === 0x49) { return "image/gif"; }
      if (bytes[0] === 0x52 && bytes[1] === 0x49) { return "image/webp"; }
      return "image/svg+xml";
    }

    /**
     * @param {number} when  a time in ms
     * @returns {string} "today", "yesterday", "3 days ago", ...
     */
    function ago(when) {
      var days = Math.floor((Date.now() - when) / 86400000);
      if (days <= 0) { return "today"; }
      if (days === 1) { return "yesterday"; }
      return days + " days ago";
    }

    /** @param {object} book  @returns {string} "A, B" or "" */
    function authorsText(book) {
      var authors = book.authors;
      return Array.isArray(authors) ? authors.join(", ") : (authors || "");
    }

    /**
     * @param {object} book
     * @returns {string} "Author(s) \u00b7 edition \u00b7 year", whatever is known
     */
    function byline(book) {
      return [authorsText(book), book.edition || "", book.year || ""]
        .filter(Boolean).join(" \u00b7 ");
    }

    /** @param {string} title  @returns {string} a sort key without The/A */
    function sortKey(title) {
      return title.replace(/^(the|a)\s+/i, "").toLowerCase();
    }

    // ---------------------------------------------------- what we know

    /**
     * Read this browser's saved quiz progress for one book.
     * @param {object} book
     */
    function readProgress(book) {
      var answered = 0;
      var last = 0;
      try {
        var saved = JSON.parse(localStorage.getItem(PROGRESS_KEY + book.id) || "{}");
        Object.keys(saved.questions || {}).forEach(function each(id) {
          var record = saved.questions[id];
          if (record && record.timesSeen > 0) {
            answered += 1;
            last = Math.max(last, record.lastAnswered || 0);
          }
        });
      } catch (problem) {
        answered = 0;
      }
      var opened = 0;
      try {
        opened = Number(localStorage.getItem(OPENED_KEY + book.id)) || 0;
      } catch (problem) {
        opened = 0;
      }
      book.answered = answered;
      book.lastTouched = Math.max(last, opened);
    }

    /** @param {object} book  @returns {number} percent answered, 0 to 100 */
    function percent(book) {
      if (!book.questions) {
        return 0;
      }
      return Math.min(100, Math.round(100 * book.answered / book.questions));
    }

    /** @param {object} book  @returns {string} the status line */
    function statusText(book) {
      var pct = book.questions ? 100 * book.answered / book.questions : 0;
      if (!book.answered) {
        return "Not started";
      }
      var when = book.lastTouched ? " · " + ago(book.lastTouched) : "";
      var label = pct >= 100 ? "All answered" :
        pct < 1 ? book.answered + " answered" : pct + "% answered";
      return label + when;
    }

    /**
     * Decrypt one RQE1 file of this subject.
     * @param {string} path
     * @returns {Promise<Uint8Array>}
     */
    function fetchPlain(path) {
      return fetch(path).then(function check(reply) {
        if (!reply.ok) {
          throw new Error(path + ": HTTP " + reply.status);
        }
        return reply.arrayBuffer();
      }).then(function open(buffer) {
        return window.SubjectUnlock.decrypt(buffer, key);
      });
    }

    /**
     * Where one of a book's own files is. On a site with encrypted names
     * the index lists it; on an older site it sits in the book's folder.
     * @param {object} book
     * @param {string} path  for example "data/manifest.enc"
     * @returns {string}
     */
    function fileAddress(book, path) {
      if (book.files) {
        if (!book.files[path]) {
          throw new Error("not in the book's file list");
        }
        return book.files[path];
      }
      return encodeURIComponent(book.folder) + "/" + path;
    }

    /**
     * The page that opens a book.
     * @param {object} book
     * @param {string} view  "read" or "quiz"
     * @returns {string}
     */
    function bookAddress(book, view) {
      if (book.files) {
        return (view === "quiz" ? "q.html" : "r.html") + "?b=" +
          encodeURIComponent(book.id);
      }
      return encodeURIComponent(book.folder) + "/index.html?view=" + view;
    }

    /**
     * Load a book's manifest (summary, counts, cover) and its cover, then
     * redraw. A failure just leaves the book as a typographic tile.
     * @param {object} book
     */
    function learnBook(book) {
      Promise.resolve().then(function first() {
        return fetchPlain(fileAddress(book, "data/manifest.enc"));
      }).then(function got(bytes) {
        var manifest = JSON.parse(new TextDecoder().decode(bytes));
        book.summary = (manifest.book && manifest.book.summary) || "";
        book.chapters = (manifest.chapters || []).length;
        book.questions = (manifest.chapters || []).reduce(function add(sum, chapter) {
          return sum + (chapter.questions || 0);
        }, 0);
        book.ideas = (manifest.chapters || []).reduce(function add(sum, chapter) {
          return sum + (chapter.ideas || 0);
        }, 0);
        draw();
        var cover = manifest.book && manifest.book.cover;
        if (!cover) {
          return null;
        }
        return fetchPlain(fileAddress(book,
          "media/" + cover.replace(/\//g, "_") + ".enc"))
          .then(function image(plain) {
            book.coverUrl = URL.createObjectURL(
              new Blob([plain], { type: sniff(plain) }));
            draw();
          });
      }).catch(function ignore() {
        // locked or missing: the tile stays
      });
    }

    // ------------------------------------------------------------ views

    /**
     * @param {object} book
     * @param {string} label
     * @param {string} view  "read" or "quiz"
     * @param {boolean} primary
     * @returns {HTMLElement} a link, or a greyed-out label when the book has
     *   no such view
     */
    function makeAction(book, label, view, primary) {
      var has = (book.views || []).indexOf(view) !== -1;
      var action = make(has ? "a" : "span", "action" + (primary ? " primary" : ""), label);
      if (has) {
        action.href = bookAddress(book, view);
        action.addEventListener("click", function remember() {
          try {
            localStorage.setItem(OPENED_KEY + book.id, String(Date.now()));
          } catch (problem) {
            // not stored
          }
        });
        action.setAttribute("aria-label", label + ": " + book.title);
      } else {
        action.setAttribute("aria-disabled", "true");
        action.title = "Not available for this book yet";
      }
      return action;
    }

    /**
     * The cover picture, or a typographic tile in the book's colour.
     * @param {object} book
     * @param {boolean} titleIsHeading  the tile's title is the book's h2
     * @returns {HTMLElement}
     */
    function makeArt(book, titleIsHeading) {
      var art = make("div", "art");
      art.style.background = book.colour;
      if (book.coverUrl) {
        art.style.background = "var(--color-border, #d5dbe5)";
        var image = make("img", "cover-img");
        image.src = book.coverUrl;
        image.alt = "Cover of " + book.title;
        art.appendChild(image);
        return art;
      }
      var tile = make("div", "cover");
      tile.style.background = book.colour;
      tile.appendChild(make(titleIsHeading ? "h2" : "p", "t", book.short));
      var line = authorsText(book) || (book.chapters ? book.chapters + " chapters" : "");
      if (line) {
        tile.appendChild(make("div", "m", line));
      }
      art.appendChild(tile);
      return art;
    }

    /** @param {object} book  @returns {HTMLElement} the progress bar */
    function makeBar(book) {
      var bar = make("div", "bar" + (percent(book) >= 100 ? " done" : ""));
      var fill = make("i");
      fill.style.width = percent(book) + "%";
      bar.appendChild(fill);
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(percent(book)));
      bar.setAttribute("aria-label", "Answered");
      return bar;
    }

    /** @param {object} book  @returns {HTMLElement} one card */
    function makeCard(book) {
      var item = make("li", "book");
      item.appendChild(makeArt(book, true));
      if (book.coverUrl) {
        item.appendChild(make("h2", "sr-only", book.title));
      }
      var meta = make("div", "meta");
      meta.appendChild(makeBar(book));
      meta.appendChild(make("p", "small", statusText(book)));
      var actions = make("div", "actions");
      actions.appendChild(makeAction(book, "Read", "read", true));
      actions.appendChild(makeAction(book, "Test", "quiz", false));
      meta.appendChild(actions);
      item.appendChild(meta);
      return withStatus(item, book);
    }

    /** @param {object} book  @returns {HTMLElement} one list row */
    function makeRow(book) {
      var item = make("li", "book listrow");
      item.appendChild(makeArt(book, false));
      var body = make("div", "body");
      body.appendChild(make("h2", null, book.title));
      if (byline(book)) {
        body.appendChild(make("p", "byline", byline(book)));
      }
      body.appendChild(makeBar(book));
      var facts = [statusText(book)];
      if (book.chapters) {
        facts.push(book.chapters + " chapters", book.ideas + " ideas",
          book.questions + " questions");
      }
      body.appendChild(make("p", "small", facts.join(" · ")));
      var actions = make("div", "actions");
      actions.appendChild(makeAction(book, "Read book", "read", true));
      actions.appendChild(makeAction(book, "Test only", "quiz", false));
      body.appendChild(actions);
      item.appendChild(body);
      return withStatus(item, book);
    }

    /** @param {object} book  @returns {HTMLElement} one compact row */
    function makeCompact(book) {
      var item = make("li", "crow");
      var dot = make("span", "dot");
      dot.style.background = book.colour;
      dot.setAttribute("aria-hidden", "true");
      var text = make("div", "text");
      text.appendChild(make("h2", null, book.title));
      text.appendChild(make("p", "small", statusText(book)));
      item.appendChild(dot);
      item.appendChild(text);
      item.appendChild(makeCompactLink(book, "Read", "read"));
      item.appendChild(makeCompactLink(book, "Test", "quiz"));
      if (adminOn()) { item.appendChild(window.SubjectStatus.dot(book)); }
      return item;
    }

    /**
     * @param {object} book
     * @param {string} label
     * @param {string} view
     * @returns {HTMLElement}
     */
    function makeCompactLink(book, label, view) {
      var link = makeAction(book, label, view, false);
      link.className = "";
      return link;
    }

    // ------------------------------------------------------ admin

    /** @returns {object} the Firebase web config, picked as the quiz template picks it */
    function firebaseConfig() {
      var meta = document.querySelector('meta[name="firebase-config"]');
      if (meta) {
        try { return JSON.parse(meta.content); } catch (problem) { /* use the default */ }
      }
      return FIREBASE_CONFIG;
    }

    /**
     * Is the signed-in reader an admin? Only an account with a document in
     * admins/<uid> is. Uses the sign-in's own Firebase app (no second login).
     * @returns {Promise<{user: object, db: object, fs: object}|null>}
     */
    function checkAdmin() {
      return Promise.all([import(FIREBASE_ROOT + "app.js"),
        import(FIREBASE_ROOT + "auth.js"),
        import(FIREBASE_ROOT + "firestore.js")]).then(function sdk(modules) {
        /* A reader who is already unlocked on this device never starts the
           sign-in's Firebase app, so start it here, with the same settings
           (the same app and saved sign-in as the quiz template's). */
        var app = modules[0].getApps().length ? modules[0].getApp() :
          modules[0].initializeApp(firebaseConfig());
        var auth = modules[1].getAuth(app);
        return new Promise(function wait(resolve) {
          var stop = modules[1].onAuthStateChanged(auth, function seen(user) {
            stop();
            resolve(user);
          });
        }).then(function known(user) {
          if (!user) { return null; }
          var db = modules[2].getFirestore(app);
          return modules[2].getDoc(modules[2].doc(db, "admins", user.uid))
            .then(function found(snapshot) {
              return snapshot.exists() ? { user: user, db: db, fs: modules[2] } : null;
            });
        });
      }).catch(function none() { return null; });
    }

    /** @returns {boolean} whether the status bands should be drawn */
    function adminOn() {
      return !!(adminMode && adminCtx && window.SubjectStatus &&
        window.SubjectStatus.ready());
    }

    /**
     * The address of this hub.js's own exact release ("...@3.0.2/"), so the
     * admin files always match it and are never an older copy that a browser
     * (Safari, mostly) kept under the "@3" address. Falls back to "@3".
     * @returns {Promise<string>}
     */
    var pinnedBase = null;
    function exactBase() {
      if (pinnedBase) { return pinnedBase; }
      var exact = /^[0-9]+\.[0-9]+\.[0-9]+$/;
      var base = function base(version) { return JSDELIVR + "group-ui@" + version + "/"; };
      pinnedBase = fetch(script.src).then(function header(reply) {
        var version = reply.headers.get("x-jsd-version");
        if (exact.test(version || "")) { return base(version); }
        throw new Error("no version header");
      }).catch(function api() {
        var spec = (UI_BASE.match(/group-ui@([^/]+)\//) || [])[1];
        if (!spec) { return UI_BASE; }
        return fetch("https://data.jsdelivr.com/v1/packages/gh/eckko/group-ui/resolved?specifier=" +
          encodeURIComponent(spec)).then(function json(reply) {
          return reply.json();
        }).then(function pick(data) {
          return exact.test(data.version || "") ? base(data.version) : UI_BASE;
        });
      }).catch(function plain() { return UI_BASE; });
      return pinnedBase;
    }

    /** Load the admin module (once) and read the status documents. */
    function loadAdminUi() {
      if (window.SubjectStatus && window.SubjectStatus.ready()) {
        return window.SubjectStatus.reload();
      }
      return exactBase().then(function load(base) {
        addStyle(base + "css/status.css");
        addStyle(base + "css/addbook.css");
        /* "Add a book" is a second admin tool: the status page works even
           when it cannot load. */
        addScript(base + "js/addbook.js").then(function add() {
          return window.SubjectAddBook.init(adminCtx, adminSetup);
        }).then(draw).catch(function skip() { /* no Add book this time */ });
        return addScript(base + "js/status.js");
      }).then(function ready() {
        return window.SubjectStatus.init(adminCtx, adminSetup);
      });
    }

    /** @param {boolean} on  switch Admin mode on or off and redraw */
    function setAdminMode(on) {
      adminMode = on;
      try {
        localStorage.setItem(ADMIN_KEY, on ? "1" : "0");
      } catch (problem) {
        // not stored
      }
      adminError = "";
      if (!on) { draw(); return; }
      if (window.SubjectStatus && window.SubjectStatus.ready()) {
        /* Already loaded: show it at once, refresh quietly, and keep what
           is shown if the refresh fails (a switch must never lose the data). */
        draw();
        window.SubjectStatus.reload().then(draw).catch(function keep() { /* keep old data */ });
        return;
      }
      loadAdminUi().then(draw).catch(function failed() {
        adminMode = false;
        adminError = "Could not load the status. Try again.";
        draw();
        if (gearPanel) { gearPanel.redraw(); }
      });
    }

    /**
     * The gear's "Admin" section, only for an admin.
     * @param {HTMLElement} body  the gear panel's body
     * @param {function(): void} redraw  redraws the gear panel
     */
    function addAdminSection(body, redraw) {
      if (!adminCtx) { return; }
      body.appendChild(make("h4", null, "Admin"));
      var toggle = make("button", "admin-toggle", "Book status");
      toggle.type = "button";
      toggle.setAttribute("aria-pressed", String(adminMode));
      toggle.addEventListener("click", function flip() {
        setAdminMode(!adminMode);
        redraw();
      });
      body.appendChild(toggle);
      body.appendChild(make("p", "admin-note", adminError ? adminError : adminMode ?
        "On: each book shows its build status." :
        "Off. Turn on to see each book's build status."));

      var add = make("button", "admin-toggle", "Add a book");
      add.type = "button";
      add.addEventListener("click", function open() {
        if (!(window.SubjectAddBook && window.SubjectAddBook.ready())) {
          adminError = "Add a book is still loading. Try again in a moment.";
          redraw();
          return;
        }
        window.SubjectAddBook.open();
      });
      body.appendChild(add);
      body.appendChild(make("p", "admin-note",
        "Creates a private book repo from the template and uploads its files."));

      var clear = make("button", "admin-toggle admin-clear", "Clear cache and reload");
      clear.type = "button";
      clear.addEventListener("click", function go() {
        clear.disabled = true;
        clearCaches(function progress(text) { clear.textContent = text; });
      });
      body.appendChild(clear);
      body.appendChild(make("p", "admin-note",
        "Asks jsDelivr for fresh copies, empties this browser's saved copies, then reloads."));

      body.appendChild(make("h4", null, "Versions loaded"));
      var list = make("dl", "admin-versions");
      body.appendChild(list);
      showVersions(list, redraw);
    }

    /** @returns {string[]} every jsDelivr file this site loads, as full URLs */
    function cdnFiles() {
      var quiz = ["js/unlock.js", "css/theme-defaults.css", "css/reading-panel.css"]
        .concat(SHARED_SCRIPTS);
      var urls = [];
      var ui = JSDELIVR + "group-ui@" + siteInfo.ui + "/";
      ["js/hub.js", "js/status.js", "css/status.css", "js/addbook.js", "css/addbook.css", "css/hub.css"].forEach(function add(file) {
        urls.push(ui + file);
      });
      var tags = [QUIZ_TEMPLATE_TAG];
      if (siteInfo.template && tags.indexOf(siteInfo.template) === -1) { tags.push(siteInfo.template); }
      tags.forEach(function each(tag) {
        quiz.forEach(function add(file) {
          urls.push(JSDELIVR + "item-ui@" + tag + "/" + file);
        });
      });
      return urls;
    }

    /**
     * The newest release of this UI on GitHub that fits uiVersion ("3" or
     * "3.0" or exact). jsDelivr can lag behind a new release for a while, and
     * asking it for the exact tag once makes it fetch the release.
     * @returns {Promise<string>} the version, or "" when unknown
     */
    function newestRelease() {
      return fetch("https://api.github.com/repos/eckko/group-ui/tags?per_page=100")
        .then(function json(reply) { return reply.json(); })
        .then(function pick(tags) {
          var spec = siteInfo.ui;
          var best = "";
          var parts = function parts(v) { return v.split(".").map(Number); };
          var newer = function newer(a, b) {
            var x = parts(a);
            var y = parts(b);
            for (var i = 0; i < 3; i += 1) { if (x[i] !== y[i]) { return x[i] > y[i]; } }
            return false;
          };
          tags.forEach(function each(tag) {
            var name = tag.name;
            if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(name)) { return; }
            if (name !== spec && name.indexOf(spec + ".") !== 0) { return; }
            if (!best || newer(name, best)) { best = name; }
          });
          return best;
        }).catch(function none() { return ""; });
    }

    /**
     * Purge jsDelivr, refresh this browser's saved copy of each file, drop
     * any Cache Storage / service worker, then reload.
     * @param {function(string): void} say  shows progress on the button
     */
    function clearCaches(say) {
      var urls = cdnFiles();
      var quiet = function quiet() { return null; };
      say("Looking for the newest release…");
      newestRelease().then(function warm(version) {
        /* One request for the exact release makes jsDelivr pick it up. */
        if (!version) { return null; }
        return fetch(JSDELIVR + "group-ui@" + version + "/js/hub.js").catch(quiet);
      }).then(function purgeAll() {
        say("Asking jsDelivr…");
        return Promise.all(urls.map(function purge(url) {
          return fetch(url.replace("://cdn.", "://purge."), { mode: "no-cors" }).catch(quiet);
        }));
      }).then(function wait() {
        say("Refreshing this browser…");
        return new Promise(function later(done) { setTimeout(done, 2500); });
      }).then(function again() {
        return Promise.all(urls.map(function fresh(url) {
          return fetch(url, { cache: "reload" }).catch(quiet);
        }));
      }).then(function storage() {
        var jobs = [];
        if (window.caches && caches.keys) {
          jobs.push(caches.keys().then(function each(keys) {
            return Promise.all(keys.map(function drop(key) { return caches.delete(key); }));
          }).catch(quiet));
        }
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          jobs.push(navigator.serviceWorker.getRegistrations().then(function each(all) {
            return Promise.all(all.map(function off(one) { return one.unregister(); }));
          }).catch(quiet));
        }
        return Promise.all(jobs);
      }).then(function done() {
        say("Reloading…");
        location.reload();
      });
    }

    /**
     * Fill the "Versions loaded" list: what this page really got, and what
     * jsDelivr would serve now (a difference means a cached older copy).
     */
    function showVersions(list, redraw) {
      var rows = function rows(info) {
        list.textContent = "";
        info.forEach(function row(pair) {
          list.appendChild(make("dt", null, pair[0]));
          list.appendChild(make("dd", null, pair[1]));
        });
      };
      if (versions) { rows(versions); return; }
      rows([["Checking…", ""]]);
      var ui = siteInfo.ui;
      var hubUrl = JSDELIVR + "group-ui@" + ui + "/js/hub.js";
      var header = function header(url) {
        return fetch(url).then(function got(reply) {
          return reply.headers.get("x-jsd-version") || "unknown";
        }).catch(function none() { return "unknown"; });
      };
      var latest = function latest(repo, spec) {
        return fetch("https://data.jsdelivr.com/v1/packages/gh/eckko/" + repo +
          "/resolved?specifier=" + encodeURIComponent(spec)).then(function got(reply) {
          return reply.json();
        }).then(function pick(data) { return data.version || "unknown"; })
          .catch(function none() { return "unknown"; });
      };
      var newest = function newest(repo) {
        return fetch("https://data.jsdelivr.com/v1/packages/gh/eckko/" + repo).then(function got(reply) {
          return reply.json();
        }).then(function pick(data) {
          return (data.versions && data.versions[0] && data.versions[0].version) || "unknown";
        }).catch(function none() { return "unknown"; });
      };
      Promise.all([header(hubUrl), latest("group-ui", ui),
        header(QUIZ_CDN + "js/unlock.js"), newest("item-ui"),
        newestRelease()]).then(function both(got) {
        var note = got[0] !== "unknown" && got[1] !== "unknown" && got[0] !== got[1] ?
          " (older copy cached, use Clear cache)" : "";
        versions = [
          ["Subject UI (hub)", got[0] + note],
          ["Subject UI latest on @" + ui, got[1] + (got[4] && got[4] !== got[1] ?
            " (GitHub has " + got[4] + ", use Clear cache)" : "")],
          ["Quiz template (hub)", got[2]],
          ["Quiz template latest", got[3]],
        ];
        rows(versions);
      });
    }

    /** @param {HTMLElement} item  add the status band when Admin mode is on */
    function withStatus(item, book) {
      if (adminOn()) {
        item.classList.add("has-status");
        item.appendChild(window.SubjectStatus.band(book));
      }
      return item;
    }

    // ------------------------------------------------------ the list

    /** @returns {object[]} the books to show, filtered and sorted */
    function visibleBooks() {
      var query = ui.query.trim().toLowerCase();
      var shown = books.filter(function keep(book) {
        var pct = percent(book);
        var matches = !query || (book.title + " " + authorsText(book) + " " + (book.summary || "")).toLowerCase().indexOf(query) !== -1;
        var state = ui.filter === "all" ||
          (ui.filter === "new" && !book.answered) ||
          (ui.filter === "going" && book.answered && pct < 100) ||
          (ui.filter === "done" && pct >= 100);
        return matches && state;
      });
      var order = {
        az: function az(a, b) { return sortKey(a.title).localeCompare(sortKey(b.title)); },
        recent: function recent(a, b) {
          return b.lastTouched - a.lastTouched || order.az(a, b);
        },
        progress: function progress(a, b) { return percent(b) - percent(a) || order.az(a, b); },
        size: function size(a, b) { return (b.questions || 0) - (a.questions || 0) || order.az(a, b); },
      };
      return shown.sort(order[ui.sort]);
    }

    /** Draw the chips, the counts and the list for the current state. */
    function draw() {
      books.forEach(readProgress);
      drawChips();
      viewButtons.forEach(function mark(button) {
        button.setAttribute("aria-pressed", String(button.getAttribute("data-view") === ui.view));
      });
      var shown = visibleBooks();
      var going = books.filter(function started(book) {
        return book.answered && percent(book) < 100;
      }).length;
      count.textContent = shown.length === books.length ?
        books.length + (books.length === 1 ? " book" : " books") +
          (going ? " · " + going + " in progress" : "") :
        shown.length + " of " + books.length + " books";
      listBox.textContent = "";
      var extras = adminExtras();
      if (!shown.length && !extras.length) {
        var empty = make("div", "empty");
        empty.appendChild(make("p", null, books.length ? "No books match." : "No books yet."));
        if (books.length) {
          var clear = make("button", null, "Clear search and filters");
          clear.type = "button";
          clear.addEventListener("click", function reset() {
            ui.query = "";
            ui.filter = "all";
            queryBox.value = "";
            saveUi();
            draw();
          });
          empty.appendChild(clear);
        }
        listBox.appendChild(empty);
        return;
      }
      var list = make("ul", "books " + (ui.view === "cards" ? "grid" :
        ui.view === "list" ? "stack" : "compact"));
      var build = ui.view === "cards" ? makeCard : ui.view === "list" ? makeRow : makeCompact;
      shown.forEach(function add(book) {
        list.appendChild(build(book));
      });
      extras.forEach(function add(item) { list.appendChild(item); });
      listBox.appendChild(list);
    }

    /**
     * The admin's extra shelf items while Admin mode is on: the books being
     * built (not on the shelf yet) and the "Add book" tile.
     * @returns {HTMLElement[]}
     */
    function adminExtras() {
      var tools = window.SubjectAddBook;
      if (!(adminMode && adminCtx && tools && tools.ready())) { return []; }
      var items = tools.pending().map(tools.pendingCard);
      items.push(tools.tile());
      return items;
    }

    /** Draw the sort chips first, then (scrolling right) the filters. */
    function drawChips() {
      chipsBox.textContent = "";
      chipsBox.appendChild(make("span", "label", "Sort"));
      SORTS.forEach(function add(sort) {
        chipsBox.appendChild(makeChip(sort[1], ui.sort === sort[0], "chip sort", function pick() {
          ui.sort = sort[0];
          saveUi();
          draw();
        }));
      });
      chipsBox.appendChild(make("span", "divider"));
      chipsBox.appendChild(make("span", "label", "Show"));
      FILTERS.forEach(function add(filter) {
        chipsBox.appendChild(makeChip(filter[1], ui.filter === filter[0], "chip", function pick() {
          ui.filter = filter[0];
          saveUi();
          draw();
        }));
      });
    }

    /**
     * @param {string} label
     * @param {boolean} on
     * @param {string} className
     * @param {function(): void} onPick
     * @returns {HTMLElement}
     */
    function makeChip(label, on, className, onPick) {
      var chip = make("button", className, label);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(on));
      chip.addEventListener("click", onPick);
      return chip;
    }

    // ------------------------------------------------------------ start

    queryBox.addEventListener("input", function search() {
      ui.query = queryBox.value;
      draw();
    });
    viewButtons.forEach(function wire(button) {
      button.addEventListener("click", function pick() {
        ui.view = button.getAttribute("data-view");
        saveUi();
        draw();
      });
    });

    /** The gear: the template's reading panel, plus Sign out. */
    function setUpGear() {
      window.RecallQuizAssetBase = CDN;
      /* Start light, in the Classic theme (a reader's own choice wins). */
      window.RecallQuizBookDefaults = { theme: { id: "classic", mode: "light" } };
      return SHARED_SCRIPTS.reduce(function chain(done, file) {
        return done.then(function next() { return addScript(CDN + file); });
      }, Promise.resolve()).then(function ready() {
        window.RecallQuiz.reading.configure({ fontSize: 16, font: "theme" });
        window.RecallQuiz.reading.useBook("subject-hub");
        window.RecallQuizTheme.useBook("subject-hub");
        gearPanel = window.RecallQuiz.readingPanel.create({
          homeLabel: "Sign out",
          onHome: function signOut() { window.SubjectUnlock.reset(); },
          subjectPageAddress: null,
          addSections: addAdminSection,
          onReset: function noop() {},
        });
        showSignOut(false);
      });
    }

    /** @param {boolean} on  show or hide the gear's Sign out button */
    function showSignOut(on) {
      var buttons = document.querySelectorAll("#reading-panel button");
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].textContent === "Sign out") { buttons[i].hidden = !on; }
      }
    }

    /**
     * @param {object} subject  subject.json
     * @param {object} index    books.json
     */
    function start(subject, index) {
      if (subject.title) {
        heading.textContent = subject.title;
        document.title = subject.title;
      }
      books = (index.books || []).map(function prepare(book, number) {
        return Object.assign({
          folder: book.id,               // names the book's status record
          short: book.title.split(":")[0],
          colour: TILE_COLOURS[number % TILE_COLOURS.length],
          answered: 0, lastTouched: 0, questions: 0, ideas: 0, chapters: 0,
          summary: "", coverUrl: "",
        }, book, (subject.bookDetails || {})[book.id] || {});
      });
      siteInfo = { ui: String(subject.uiVersion || ""), template: String(subject.templateTag || "") };
      adminSetup = {
        subjectTitle: subject.title || "Books",
        workflowUrl: subject.admin && subject.admin.workflowUrl,
        onChange: function again() { draw(); },
        bookLink: bookAddress,
        /* Add a book: this site's own subject name (its repo, when the site
           is a GitHub Pages project site), the private pipeline repo, and
           whether a book is already on the shelf. */
        subjectRepo: (location.pathname.split("/")[1] || "").toLowerCase(),
        pipeline: subject.admin && subject.admin.pipeline,
        isPublished: function published(slug) {
          return books.some(function same(book) {
            return book.id === slug || (window.SubjectAddBook &&
              window.SubjectAddBook.slugOf(book.title) === slug);
          });
        },
      };
      status.hidden = true;
      shelf.hidden = false;
      document.getElementById("controls").hidden = false;
      draw();
      books.forEach(learnBook);
    }

    /* Move the template's lock box into the sign-in screen. */
    var watcher = new MutationObserver(function moveLock() {
      var box = document.getElementById("unlock");
      if (!box || box.parentNode === lockSlot) { return; }
      var wait = document.getElementById("gateWait");
      if (wait) { wait.remove(); }
      var note = box.querySelector(".note");
      if (note && /^This book is encrypted/.test(note.textContent)) {
        note.textContent = "";
        note.hidden = true;
      }
      lockSlot.appendChild(box);
    });
    watcher.observe(document.body, { childList: true });

    addStyle(CDN + "css/theme-defaults.css");
    addStyle(CDN + "css/reading-panel.css");
    /* An older site names its title in the open; a site with encrypted
       names shows only "Books" until the reader has signed in. */
    readSettings().then(function early(found) {
      if (!found.pool && found.subject.title) {
        gateTitle.textContent = found.subject.title;
        document.title = found.subject.title;
      }
    });
    /**
     * The subject and its book list, once the key is known.
     * @returns {Promise<Array>} [subject settings, {books: [...]}]
     */
    function loadSite() {
      return readSettings().then(function which(found) {
        if (!found.pool) {
          return Promise.all([loadJson("subject.json"), loadJson("books.json")]);
        }
        return fetchPlain("index.enc").then(function opened(bytes) {
          var index = JSON.parse(new TextDecoder().decode(bytes));
          if (index.format !== 2) {
            throw new Error("this site needs a newer hub UI");
          }
          return [Object.assign({}, found.subject, index.subject),
            { books: index.books }];
        });
      });
    }
    /* The gear works on the sign-in screen too; Sign out only after. */
    var gearReady = setUpGear();
    gearReady.catch(function ignore() { /* reported below */ });
    addScript(CDN + "js/unlock.js")
      .then(function unlock() { return window.SubjectUnlock.ready(); })
      .then(function signedIn(result) {
        key = result.key;
        status.textContent = "Loading your books…";
        gate.hidden = true;
        app.hidden = false;
        return Promise.all([loadSite(), gearReady]);
      })
      .then(function show(done) {
        /* Only now is the gear built, so Sign out can be shown (a saved
           sign-in can finish before the gear's scripts have loaded). */
        showSignOut(true);
        start(done[0][0], done[0][1]);
        /* Admins only: the gear gets a switch, and Admin mode (when on) adds
           the build status to every book. Everyone else is unaffected. */
        return checkAdmin().then(function known(found) {
          if (!found) { return null; }
          adminCtx = found;
          if (gearPanel) { gearPanel.redraw(); }
          return adminMode ? loadAdminUi().then(draw) : null;
        }).catch(function ignore() { /* the shelf works without it */ });
      })
      .catch(function failed(problem) {
        gate.hidden = true;
        app.hidden = false;
        status.hidden = false;
        count.textContent = "";
        status.textContent = "Could not start: " + problem.message +
          " (open this page through a web server, not from a folder).";
      });
  }

  /** Put the markup on the page, then start. */
  function boot() {
    document.body.insertAdjacentHTML("afterbegin", MARKUP);
    showHub();
  }

  /**
   * A file named in subject.json "theme", as an address next to the page.
   * Only plain relative paths of the subject's own folder are accepted: no
   * scheme, no leading slash, no "..". A first folder like ".theme" is fine
   * (the quiz template's site check skips dot-folders, so it does not count
   * as a book).
   * @param {*} path
   * @returns {string} the address, or "" when it is not allowed
   */
  function themeAddress(path) {
    if (typeof path !== "string" || path.indexOf("..") !== -1 ||
        !/^\.?[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(path)) {
      return "";
    }
    return new URL(path, document.baseURI).href;
  }

  /** @param {string} address  @returns {string} an image type, or "" */
  function iconType(address) {
    if (/\.svg$/i.test(address)) { return "image/svg+xml"; }
    if (/\.png$/i.test(address)) { return "image/png"; }
    if (/\.ico$/i.test(address)) { return "image/x-icon"; }
    return "";
  }

  /**
   * Add the favicon and the iOS home-screen icon: the subject's own
   * (theme.icon, theme.appleTouchIcon) or this repo's neutral default.
   * @param {object} theme  subject.json "theme" ({} when there is none)
   */
  function addIcons(theme) {
    var icon = themeAddress(theme.icon) || UI_BASE + "img/icon.svg";
    var touch = themeAddress(theme.appleTouchIcon) ||
      UI_BASE + "img/apple-touch-icon.png";
    [["icon", iconType(icon), "", icon],
     ["apple-touch-icon", "", "180x180", touch]
    ].forEach(function add(spec) {
      var link = document.createElement("link");
      link.rel = spec[0];
      if (spec[1]) { link.type = spec[1]; }
      if (spec[2]) { link.setAttribute("sizes", spec[2]); }
      link.href = spec[3];
      document.head.appendChild(link);
    });
  }

  /**
   * Add a stylesheet; resolves when it has loaded or failed, so a missing
   * theme file never stops the page.
   * @param {string} address
   * @returns {Promise}
   */
  function loadStyle(address) {
    return new Promise(function add(resolve) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = address;
      link.addEventListener("load", resolve);
      link.addEventListener("error", resolve);
      document.head.appendChild(link);
    });
  }

  /**
   * Read the subject's public settings: boot.json on a site whose books
   * are all encrypted (the title and the books come later, from the
   * encrypted index.enc), otherwise subject.json. The answer is read
   * once and shared.
   * @returns {Promise<{pool: boolean, subject: object}>} subject is {} when
   *   neither file can be read
   */
  function readSettings() {
    if (!settingsPromise) {
      settingsPromise = fetch("boot.json", { cache: "no-cache" })
        .then(function boot(reply) {
          if (!reply.ok) { throw new Error("no boot.json"); }
          return reply.json().then(function found(subject) {
            return { pool: true, subject: subject };
          });
        }).catch(function older() {
          return fetch("subject.json", { cache: "no-cache" })
            .then(function ok(reply) {
              return reply.ok ? reply.json() : {};
            }).then(function legacy(subject) {
              return { pool: false, subject: subject };
            });
        }).catch(function none() {
          return { pool: false, subject: {} };
        });
    }
    return settingsPromise;
  }

  /**
   * Read the public settings early, for the theme.
   * @returns {Promise<object>} the settings, or {} when they cannot be read
   */
  function readSubject() {
    return readSettings().then(function only(found) {
      return found.subject;
    });
  }

  /**
   * Load hub.css, then the subject's theme.css (so it wins), before the page
   * is drawn, so it never shows unstyled or in the wrong look.
   */
  function start() {
    readSubject().then(function themed(subject) {
      var theme = subject && typeof subject.theme === "object" && subject.theme || {};
      addIcons(theme);
      var styles = [UI_BASE + "css/hub.css"];
      var themeCss = themeAddress(theme.css);
      if (themeCss) { styles.push(themeCss); }
      return Promise.all(styles.map(loadStyle));
    }).then(boot);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
