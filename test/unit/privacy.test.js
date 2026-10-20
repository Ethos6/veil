import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTrackingParams, httpsUpgrade, isLocalHost, siteOf, isThirdParty, farbleSeed } from "../../src/main/privacy.js";

test("tracking parameters are removed, everything else is kept byte for byte", () => {
  assert.equal(stripTrackingParams("https://a.com/p?id=5&utm_source=x&fbclid=y"), "https://a.com/p?id=5");
  assert.equal(stripTrackingParams("https://a.com/p?utm_medium=a&UTM_Campaign=b"), "https://a.com/p");
  assert.equal(stripTrackingParams("https://a.com/p?q=a%20b+c&gclid=1#frag"), "https://a.com/p?q=a%20b+c#frag");
  assert.equal(stripTrackingParams("https://a.com/p?q=1"), null, "nothing to remove");
  assert.equal(stripTrackingParams("https://a.com/p"), null);
  assert.equal(stripTrackingParams("ftp://a.com/?utm_source=1"), null);
  assert.equal(stripTrackingParams("not a url"), null);
  assert.equal(stripTrackingParams("https://a.com/?mc_eid=1&mc_cid=2&_hsenc=3&__hssc=4&msclkid=5&igshid=6"), "https://a.com/");
  // keeps repeated and empty params in place
  assert.equal(stripTrackingParams("https://a.com/?a=1&a=2&b=&fbclid=z"), "https://a.com/?a=1&a=2&b=");
  // Matomo uses pk_ for itself
  assert.equal(stripTrackingParams("https://demo.matomo.cloud/?pk_vid=1"), null);
  assert.equal(stripTrackingParams("https://a.com/?pk_campaign=1"), "https://a.com/");
});

test("HTTPS upgrades skip local, onion and custom-port hosts and user exceptions", () => {
  assert.equal(httpsUpgrade("http://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(httpsUpgrade("http://example.com:80/"), "https://example.com/");
  assert.equal(httpsUpgrade("https://example.com/"), null);
  assert.equal(httpsUpgrade("http://localhost:3000/"), null);
  assert.equal(httpsUpgrade("http://192.168.1.1/"), null);
  assert.equal(httpsUpgrade("http://10.0.0.8/"), null);
  assert.equal(httpsUpgrade("http://printer.local/"), null);
  assert.equal(httpsUpgrade("http://router/"), null);
  assert.equal(httpsUpgrade("http://[::1]/"), null);
  assert.equal(httpsUpgrade("http://abc.onion/"), null);
  assert.equal(httpsUpgrade("http://example.com:8080/"), null);
  assert.equal(httpsUpgrade("http://example.com/", new Set(["example.com"])), null);
  assert.equal(httpsUpgrade("http://8.8.8.8/"), "https://8.8.8.8/");
});

test("local hosts", () => {
  for (const h of ["localhost", "app.localhost", "127.0.0.1", "172.16.4.2", "169.254.1.1", "100.64.0.1", "::1", "[fd00::1]", "nas.home.arpa"]) assert.equal(isLocalHost(h), true, h);
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "fcbarcelona.com"]) assert.equal(isLocalHost(h), false, h);
});

test("sites are registrable domains, using the public suffix list", () => {
  assert.equal(siteOf("https://news.bbc.co.uk/x"), "bbc.co.uk");
  assert.equal(siteOf("https://a.b.example.com"), "example.com");
  assert.equal(siteOf("user.github.io"), "user.github.io", "private suffixes count");
  assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1");
  assert.equal(siteOf("http://localhost/"), "localhost");
  assert.equal(siteOf(""), "");
  assert.equal(isThirdParty("https://cdn.example.com/x.js", "https://www.example.com/"), false);
  assert.equal(isThirdParty("https://tracker.net/x.js", "https://www.example.com/"), true);
  assert.equal(isThirdParty("https://a.github.io/", "https://b.github.io/"), true);
  assert.equal(isThirdParty("https://x.com/", "veil://newtab/"), false);
});

test("fingerprint seeds: same site and session agree, anything else differs", () => {
  const a = farbleSeed("k1", "example.com");
  assert.equal(a, farbleSeed("k1", "example.com"));
  assert.notEqual(a, farbleSeed("k1", "other.com"));
  assert.notEqual(a, farbleSeed("k2", "example.com"));
  assert.match(a, /^[0-9a-f]{16}$/);
});
