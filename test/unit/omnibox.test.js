import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInput, searchUrl, suggest } from "../../src/main/omnibox.js";

test("addresses open, words search", () => {
  const go = (t) => resolveInput(t).url;
  assert.equal(go("example.com"), "https://example.com/");
  assert.equal(go("example.com/path?q=1"), "https://example.com/path?q=1");
  assert.equal(go("http://example.com"), "http://example.com/");
  assert.equal(go("localhost:3000"), "http://localhost:3000/");
  assert.equal(go("localhost"), "http://localhost/");
  assert.equal(go("192.168.0.1"), "http://192.168.0.1/");
  assert.equal(go("8.8.8.8"), "https://8.8.8.8/");
  assert.equal(go("myserver:8080/x"), "http://myserver:8080/x");
  assert.equal(go("veil://settings"), "veil://settings");
  assert.equal(go("  "), "veil://newtab/");
  assert.equal(go("about:blank"), "about:blank");
  assert.equal(go("how to bake bread"), "https://duckduckgo.com/?q=how+to+bake+bread");
  assert.equal(resolveInput("node.js").kind, "search", ".js isn't a top-level domain");
  assert.equal(resolveInput("index.html").kind, "search");
  assert.equal(go("nodejs.org"), "https://nodejs.org/");
  assert.equal(go("bücher.de"), "https://xn--bcher-kva.de/", "international domain names");
  assert.equal(go("example.com."), "https://example.com/", "trailing dot");
  assert.equal(go("user.github.io/repo"), "https://user.github.io/repo");
  assert.equal(go("intranet.corp/wiki"), "https://intranet.corp/wiki", "a path makes an unknown suffix an address");
  assert.equal(go("nas.local"), "http://nas.local/");
  assert.equal(go("site.test"), "https://site.test/");
  assert.equal(go("http://example.com/a b"), "http://example.com/a%20b", "pasted URLs with spaces aren't sent to the search engine");
  assert.equal(go("example.com/a b"), "https://example.com/a%20b");
  assert.equal(go("example.com what is it"), "https://duckduckgo.com/?q=example.com+what+is+it");
  assert.equal(go("view-source:https://example.com"), "view-source:https://example.com/");
  assert.equal(resolveInput("view-source:javascript:alert(1)").kind, "search");
  assert.equal(go("https:example.com"), "https://duckduckgo.com/?q=https%3Aexample.com");
  assert.equal(go("hello"), "https://duckduckgo.com/?q=hello");
  assert.equal(resolveInput("hello").kind, "search");
});

test("dangerous schemes are searched, never opened", () => {
  for (const t of ["javascript:alert(1)", "data:text/html,<b>x</b>", "chrome://settings", "file2:x"]) {
    assert.equal(resolveInput(t).kind, "search", t);
  }
});

test("search URLs encode the query", () => {
  assert.equal(searchUrl("a&b=c #1", "duckduckgo"), "https://duckduckgo.com/?q=a%26b%3Dc+%231");
  assert.equal(searchUrl("x", "brave"), "https://search.brave.com/search?q=x");
  assert.equal(searchUrl("x", "nope"), "https://duckduckgo.com/?q=x");
});

test("suggestions rank bookmarks and frequent prefix matches first", () => {
  const now = Date.now();
  const history = [
    { url: "https://news.example.com/", title: "Example News", visits: 2, last: now },
    { url: "https://github.com/Ethos6/veil", title: "Veil", visits: 30, last: now },
    { url: "https://gist.github.com/", title: "Gists", visits: 1, last: now - 30 * 86400000 },
  ];
  const bookmarks = [{ url: "https://git-scm.com/", title: "Git" }];
  const r = suggest("gi", history, bookmarks);
  assert.deepEqual(new Set(r.slice(0, 2).map((x) => x.url)), new Set(["https://github.com/Ethos6/veil", "https://git-scm.com/"]), "a bookmark and a frequent site beat a stale visit");
  assert.equal(r[2].url, "https://gist.github.com/");
  assert.ok(r.find((x) => x.url === "https://git-scm.com/").bookmark);
  assert.deepEqual(suggest("", history, bookmarks), []);
  assert.deepEqual(suggest("example news", history, []).map((x) => x.url), ["https://news.example.com/"]);
  assert.equal(suggest("zzz", history, bookmarks).length, 0);
});
