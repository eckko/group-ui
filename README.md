# Subject site template

The **UI** of a subject site's hub page (the shelf): sign-in screen, book
covers, search, sort, filters, cards / list / compact views, the gear and the
app icons. It is **code only**: no books, no keys.

Subject sites hold
**encrypted data files only**. Their `index.html` is a tiny fixed loader that
reads the UI version from the subject's own `subject.json` and loads this UI
from jsDelivr. **Every change to the subject UI is made here**, then released
as a new tag. Subject sites follow a **major version** (`"uiVersion": "1"` =
the newest `1.x.x`), so minor and patch releases reach them without any change
in the subject repo; a new major version is adopted by hand, by editing
`subject.json`.

```
css/hub.css               all styles of the hub (neutral default look)
js/hub.js                 the hub: markup, sign-in screen, shelf, gear, icons
js/status.js              admin only: the book status band and page (loaded on demand)
css/status.css            styles of the admin status band and page
firestore/status.rules    the Firestore rules the admin status needs
img/icon.svg              neutral default favicon
img/apple-touch-icon.png  neutral default 180x180 home-screen icon for iOS
```

The template holds **no subject's own look**. Since 2.0.0 the sign-in screen
and the icons of a subject live in that subject's repo
(see "Theme a subject" below).

## Use it in a subject repo

`subject.json` names the UI version:

```json
{ "title": "Example", "templateTag": "1.0.0", "uiVersion": "1",
  "theme": { "css": ".theme/gate.css", "icon": ".theme/icon.svg",
             "appleTouchIcon": ".theme/apple-touch-icon.png" },
  "bookDetails": { "<book id>": { "authors": ["Name"], "edition": "2nd", "year": 2018 } } }
```

- `title`: the heading. `templateTag`: the exact `item-ui` tag whose
  tools check the site and from which the hub loads its sign-in, gear and
  themes (on a site with a `.itemrc` file, that file's tag is used; with
  neither, the hub falls back to `QUIZ_TEMPLATE_TAG` in `js/hub.js`). `bookDetails`: optional (authors, edition, year).
- `theme`: optional, see below.
- `uiVersion`: `"2"` (newest 2.x.x), `"2.1"` (newest 2.1.x) or `"2.0.0"`
  (exactly that release). Use the major normally; pin an exact one to stop
  updates.

### Encrypted index (sites that name no book)

A subject site can keep even its title and its book list encrypted. Its
repo then holds only `index.html` (the loader below), `boot.json`,
`index.enc`, `r.html`, `q.html`, the sign-in theme and a flat pool of
`xx/<id>.bin` files; nothing in it says what the subject or the books are.
The item UI's `tools/site/build_pool.py` writes it (see that repo).

`boot.json` replaces `subject.json` and holds only what the page needs
before anyone has signed in, the sign-in theme:

```json
{ "theme": { "css": ".theme/gate.css", "icon": ".theme/icon.svg" } }
```

The two versions are one-line files next to it: `.grouprc` (this UI:
`3` = newest 3.x.x, `3.1` or an exact `3.1.0`) and `.itemrc` (the exact
`item-ui` tag; its tools check the site). They replace `uiVersion` and
`templateTag`; the older loader (it reads `uiVersion` from `boot.json`) and a site that still has those in `boot.json` or `subject.json`
keeps working, and the files win when both exist.

When `boot.json` exists the hub shows the sign-in screen with the neutral
title "Books", and only after sign-in decrypts `index.enc` with the subject
key: the title, `bookDetails`, and each book's id, repo name, title, views,
cover and file map. The `id` is random (20 hex characters, made once when the
book is first published); `repo` is the book's own name, which still names its
saved progress and its status record. A book opens as `r.html#b=<id>` (reader)
or `q.html#b=<id>` (quiz). The id sits after the `#`, which a browser never
sends, so no id or name reaches a server log. The page keeps it for the tab and
removes it from the address; older `?b=<id>` links still work. Without `boot.json` the hub reads `subject.json` and `books.json`
as before, so an older site keeps working unchanged.

The shell's `index.html` (it never changes) has this loader at the end of
`<body>`; it adds the favicon and iOS icon itself through `js/hub.js`:

```html
<script>
(function () {
  "use strict";
  function fail(text) {
    var p = document.createElement("p"); p.textContent = text;
    document.body.appendChild(p);
  }
  fetch(".grouprc", { cache: "no-cache" }).then(function (r) {
    if (!r.ok) { throw new Error(".grouprc: HTTP " + r.status); }
    return r.text();
  }).then(function (text) {
    var v = text.split("\n")[0].trim();
    if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(v)) {
      throw new Error('.grouprc needs a version such as "3"');
    }
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/gh/eckko/group-ui@" + v +
      "/js/hub.js";
    s.onerror = function () { fail("Could not load the hub UI (" + v + ")."); };
    document.body.appendChild(s);
  }).catch(function (e) { fail("Could not start: " + e.message); });
})();
</script>
```

`hub.js` loads `css/hub.css` (and, unless the theme names its own, the default
icons) from the same version, then reads `subject.json` and `books.json` next to
the page. `books.json` is written by the quiz template's
`tools/site/build_hub.py`.

## Theme a subject

A subject gives its sign-in screen and icons their own look from **its own
repo**; nothing about it is released here. All keys of `theme` are optional,
and each is a plain relative path inside the subject's folder (no scheme, no
leading `/`, no `..`; anything else is ignored). Keep them in a dot-folder such
as `.theme/`: the site check of the quiz template (`build_hub.py --check`)
counts every other top-level folder as a book and fails without a `book.json`:

| key | what it is |
|---|---|
| `css` | a stylesheet loaded **after** `css/hub.css`, so it wins |
| `icon` | browser favicon (`.svg`, `.png` or `.ico`) |
| `appleTouchIcon` | iOS home-screen icon, a plain square 180x180 PNG |

Without `theme`, a subject gets the neutral default look and icons. A missing
or broken theme file never stops the page.

A theme stylesheet usually only sets variables on `:root` and gives the empty
art area a picture (a `url()` in the stylesheet is relative to that stylesheet,
so keep the picture next to it):

```css
:root {
  --gate-bg: #f6efe2;            /* page behind the sign-in screen */
  --gate-fg: #23303a;            /* title, text, outlines, focus ring */
  --gate-muted: #4d5a62;         /* the short lines of text */
  --gate-button-bg: #23303a;     /* the main (Sign in) button */
  --gate-button-fg: #f6efe2;
  --gate-heading-font: "Fraunces", Georgia, serif;
  --gate-focus: #d9654f;         /* optional, default = --gate-fg */
}
#gate .gate-art { background: url("contours.svg") center / cover no-repeat; }
```

Web fonts: put an `@import url("https://fonts.googleapis.com/...")` first in
the theme stylesheet. Keep the text readable: `--gate-fg` and `--gate-muted`
on `--gate-bg`, and `--gate-button-fg` on `--gate-button-bg`, need strong
contrast. Themes hold no book content.

## Other templates this UI uses

`js/hub.js` loads sign-in (`js/unlock.js`), the gear (reading panel, themes)
and fonts from
[`eckko/item-ui`](https://github.com/eckko/item-ui)
at `QUIZ_TEMPLATE_TAG` (top of `js/hub.js`). The hub starts in the Classic
theme, light, at 16px; a reader's own gear choices win.

## Release a version

1. Change files here, open a PR, merge to `main`.
2. Create a release tag `MAJOR.MINOR.PATCH` (for example `1.1.0`: no `v`, never
   a branch). Subject sites load `@1`, so they get it without any change.
   Use the **Create release** workflow (`.github/workflows/release.yml`):
   Actions > "Create release" > Run workflow, pick the branch (default `main`)
   and `patch`, `minor` or `major`, or from a script
   `gh workflow run release.yml -f branch=main -f release_type=minor`. It
   works out the next tag from the newest `x.y.z` tag, tags the tip of the
   branch and publishes a release with generated notes. It stops without
   creating anything if no `x.y.z` tag exists, the branch has no commits since
   the newest tag, or the new tag already exists.
3. Subject sites on `"uiVersion": "1"` may take minutes to hours to see it: jsDelivr caches a
   version range. To refresh at once, open
   `https://purge.jsdelivr.net/gh/eckko/group-ui@1/js/hub.js`
   (and the same for `css/hub.css`).

**Versioning rules** (subject sites follow `@1`, so these matter):

- patch (`1.0.1`): a fix. Minor (`1.1.0`): a new feature. Both **must stay
  backward compatible**: a subject repo's `index.html`, `subject.json`,
  `books.json` and book folders keep working unchanged.
- major (`2.0.0`): anything that breaks them (a renamed `subject.json` key, a
  new required file, a changed book folder format, a changed default look).
  Subject repos move to it by hand: set `"uiVersion": "2"` in their
  `subject.json`.
- **2.0.0** (breaking): the template no longer ships one subject's sign-in
  screen and icons. The default sign-in screen is neutral, and a subject gives
  itself its look with `theme` in `subject.json`. A subject that moves to
  `"2"` without a theme gets the neutral look, so such a subject adds its theme
  first (its old look is in its own repo).
- A tag is immutable. A bad release is fixed with a newer patch tag, never by
  moving a tag.

## Try it locally

Serve a subject repo with this folder standing in for the CDN (the test
setup routes `cdn.jsdelivr.net/gh/eckko/group-ui@<tag>/` to this
folder); sign in with the subject key. There is no build step.

## Checks

`.github/workflows/check.yml` runs `node --check js/hub.js` and verifies the
tags and files described above.

## Admin book status (3.0.0)

An admin sees how far each book is: files, structure, notes and quiz, each with
an **Auto-checked** part (the actions "Check books" workflow) and a
**You verified** part (your own sign-off in the reader). It is hidden from every
other reader: nothing extra is downloaded for them.

- **Turn it on:** sign in as an admin, open the gear, and switch on **Admin >
  Book status**. Each book gets a footer band (a status dot in the compact
  list). **Status >** opens the full page: stages that are finished, not started or only waiting for your check are
  collapsed; a stage with a problem is open and has one
  compact line per format: **Open**, a green **✓** (verified) and a red **✗**
  (error). An error stays red until the file changes or you tap ✓.
- **Clear cache and reload:** in the same gear section. It asks jsDelivr to
  purge every file this site loads (the UI at `uiVersion` and the quiz
  template tags), re-fetches them with `cache: "reload"` so this browser's
  saved copy is replaced, drops any Cache Storage or service worker, and
  reloads. A browser that still has a hub.js from before this button existed
  (for example Safari) must clear its website data once by hand.
- **Versions loaded:** shows the hub UI version this browser actually received
  (jsDelivr's `x-jsd-version` header), what `@uiVersion` resolves to now (a
  difference means an older cached copy), and the quiz template version the hub
  loaded and the newest release. All come from jsDelivr, never from `subject.json`.
- **Who is an admin:** a user with a document `admins/<uid>` in Firestore (made
  by hand in the Firebase console). Everyone else never sees the switch.
- **Where the data is:** Firestore `bookStatus/<book folder>` with `auto`
  (written by the pipeline) and `signoffs` (written by the page, latest only).
  Nothing is stored as "stale": a sign-off whose hash differs from the current
  file's hash, or whose structure hash differs, is stale when read.
- **Rules:** merge `firestore/status.rules` into the project's rules.
- **Pipeline:** `eckko/actions`, workflow "Check books" (nightly, and by
  hand). It needs the secret `FIREBASE_SERVICE_ACCOUNT`.
- **Re-run checks** opens that workflow in GitHub; set `"admin": {"workflowUrl":
  "..."}` in `subject.json` to point it somewhere else.
- The Firebase SDK version in `hub.js` must equal `FIREBASE_VERSION` in the quiz
  template's `js/unlock.js` (they share one Firebase app; if they differ the
  admin switch simply does not appear).

This is a **major** release because the hub now depends on Firestore rules and
the pipeline workflow. A subject site adopts it by editing `uiVersion` to `"3"`.
Run the logic tests with `node --test tests/status.test.js`.

## Add a book (3.1.0, admin only)

Admins see a dashed **Add a book** tile on the shelf (and in the gear menu).
It takes a book name, a subject and EPUB, PDF or DOCX files, then:

1. checks that no repo of that name exists (the repo name is made the same way
   the pipeline makes it, tested against its shell code);
2. starts the **Create book** workflow in the private pipeline repo with the
   book name and subject, so the new repo gets exactly the properties that
   workflow gives it (private, topics, key, settings);
3. waits for that run to succeed, then uploads the files one by one to
   `references/<slug>.<ext>` with the Contents API. The first file of each type
   is named after the book; no file ever passes through a public repo or action.

Setup, once, by the owner:

- **Token.** A fine-grained GitHub token for your repos with Administration,
  Contents, Actions (read and write) and Metadata (read). The admin pastes it in
  the dialog; it is stored in Firestore at `adminSecrets/<uid>`, readable only
  by that admin. Merge `firestore/status.rules` (it has the new `adminSecrets`
  rule).
- **Pipeline repo.** Defaults to `<owner>/actions`; set
  `"admin": {"pipeline": "owner/name"}` in `subject.json`/`boot.json` for another.
  Keep it **private**: workflow inputs (the book name) show in its runs.
- **Subjects.** The chips come from repos with topic `subject`. The workflow's
  own subject list is fixed, so a subject missing from it is refused.

Books being built are kept in the same Firestore document and shown as
"Not published yet" cards for the admin only until the book appears on the
shelf. There is no undo. Backward compatible with 3.0.x: sites that are not in
admin mode never load the new files. Tests: `node --test tests/addbook.test.js`.

## Update a book (admin only)

With Admin mode on, every card has the lavender status panel (the whole panel
opens the build status) and, under it, a thin arrow bar. The bar opens the
Manage drawer: **Update this book** and **Open repo on GitHub**. The code is
`js/updatebook.js`, loaded after `js/addbook.js`, which it borrows the dialog,
the GitHub call and the pipeline runner from. It needs the same GitHub token
as Add a book.

Update this book can:

- change the **book name** (the repo description), and with "Also rename the
  repo" the repo name too (checked free first);
- **replace the EPUB and/or PDF**: a file of the same type replaces the one in
  `references/`, otherwise it is added;
- **copy the shell repo's actions again**, shown as how many files differ from
  `eckko/item-template` (book data is never compared);
- **set the repo properties** Create book sets, in a collapsible panel: topics,
  pull request settings, the two secrets and the variable. Secrets show only
  "set" or "missing"; reading them needs admin access to the repo.

Syncing the actions and setting the properties both run through the pipeline's
`update-book.yml`, because secrets cannot be written from a browser. One click
runs them together; there is no dry run here. Files and the rename are done
first, so the pipeline gets the new repo name. The shelf title and the status
record follow the repo only after the book publishes again, and renaming a repo
leaves its old `bookStatus/<repo>` record behind. `tests/updatebook.test.js`
checks the logic with a fake GitHub.
