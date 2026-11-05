This repo is the only place the subject hub UI lives: `js/hub.js`,
`css/hub.css` and `img/`. Subject repos hold encrypted data and a tiny `index.html` that
loads this UI from jsDelivr at the version named by `uiVersion` in its
`subject.json` (`"2"` = newest 2.x.x). Each subject's own look (sign-in
colours and art, icons) lives in that subject's repo, named by `theme` in its
`subject.json`; never put one subject's look here, the default stays neutral.
`js/status.js` and `css/status.css` are the admin-only status view, loaded on demand by `js/hub.js`; `node --test tests/status.test.js` checks its logic. Never put a book, a key,
a cover or any readable book text here. Keep `js/hub.js` plain ES5-style
browser code (no build step, no modules); keep `QUIZ_TEMPLATE_TAG` an exact
tag of eckko/item-ui (no `v`, never a branch). A released
tag is immutable: fix with a new tag. Minor and patch releases reach every
subject site at once, so they must stay backward compatible; anything breaking
is a new major (2.0.0). See README.md.
