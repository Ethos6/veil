"use strict";
(() => {
  const { h, call } = window.V;
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const type = q.get("type") || "net";
  const url = q.get("url") || "";
  const host = q.get("host") || url;
  const desc = q.get("desc") || "";
  const code = q.get("code") || "";
  const extra = q.get("extra") || "";

  const ICON_WARN = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>';
  const ICON_SHIELD = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>';
  const ICON_PLUG = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/></svg>';

  const btn = (label, fn, primary) => h("button", { class: `btn${primary ? " primary" : ""}`, onclick: fn }, label);
  const back = btn("Go back", () => call("goBack"), true);
  const hostEl = () => h("b", { class: "host" }, host);
  let icon = ICON_PLUG;
  let warn = false;
  const actions = [];

  const NET = {
    "ERR_NAME_NOT_RESOLVED": "The address couldn't be found. Check it for typos, or the site may be down.",
    "ERR_INTERNET_DISCONNECTED": "You're offline. Check your network connection.",
    "ERR_CONNECTION_REFUSED": "The site refused the connection.",
    "ERR_CONNECTION_TIMED_OUT": "The site took too long to respond.",
    "ERR_TIMED_OUT": "The site took too long to respond.",
    "ERR_CONNECTION_RESET": "The connection was reset.",
    "ERR_ADDRESS_UNREACHABLE": "The address is unreachable.",
    "ERR_TOO_MANY_REDIRECTS": "The page redirects in a loop.",
    "ERR_SSL_PROTOCOL_ERROR": "The site sent a response Veil couldn't use for a secure connection.",
    "ERR_BLOCKED_BY_RESPONSE": "The site doesn't allow itself to be shown here.",
    "ERR_FILE_NOT_FOUND": "The file couldn't be found.",
    "ERR_ABORTED": "The page didn't load.",
    "ERR_TUNNEL_CONNECTION_FAILED": "Your proxy couldn't connect to this site.",
    "ERR_PROXY_CONNECTION_FAILED": "Veil couldn't reach your proxy server.",
    "ERR_CERT_AUTHORITY_INVALID": "The site's certificate isn't trusted.",
    "ERR_BLOCKED_BY_CLIENT": "Shields blocked this page.",
  };

  if (type === "https") {
    document.title = "Site doesn't support HTTPS";
    $("title").textContent = "This site doesn't support a secure connection";
    $("desc").replaceChildren("Veil tried to open ", hostEl(), " over HTTPS, but the site didn't respond securely.");
    $("detail").textContent = "If you continue, the page loads over plain HTTP: anyone on your network (public Wi-Fi, your provider) can see and change what you send and receive. Avoid entering passwords or payment details.";
    warn = true; icon = ICON_WARN;
    actions.push(back, btn("Continue to HTTP site", () => call("allowHttp", url)));
  } else if (type === "cert") {
    document.title = "Connection not private";
    $("title").textContent = "Your connection to this site isn't private";
    $("desc").replaceChildren("The security certificate of ", hostEl(), " couldn't be verified. Someone may be trying to intercept your connection, or the site is misconfigured.");
    $("detail").textContent = "Veil won't open this page. If it's your own server or device, install a valid certificate for it.";
    warn = true; icon = ICON_WARN;
    actions.push(back);
  } else if (type === "blocked") {
    document.title = "Page blocked";
    $("title").textContent = "Veil blocked this page";
    $("desc").replaceChildren("Shields stopped ", hostEl(), " from loading because a filter list marks it as a tracker, ad server or known scam or malware site.");
    $("detail").replaceChildren("Matching rule: ", h("code", {}, extra || "unknown"));
    icon = ICON_SHIELD;
    actions.push(back, btn("Proceed anyway", () => call("allowDocument", url)));
  } else if (type === "crash") {
    document.title = "Page crashed";
    $("title").textContent = "This page stopped working";
    $("desc").textContent = "Its process ended unexpectedly (" + (desc || "unknown reason") + "). Your other tabs are fine.";
    warn = true; icon = ICON_WARN;
    actions.push(btn("Reload", () => call("retry"), true));
  } else {
    document.title = host || "Error";
    $("title").textContent = "This page can't be reached";
    $("desc").replaceChildren(hostEl(), document.createTextNode(""));
    $("detail").textContent = NET[desc] || "Something went wrong while loading the page.";
    actions.push(btn("Try again", () => call("retry"), true), btn("Go back", () => call("goBack")));
  }
  $("icon").innerHTML = icon;
  $("icon").classList.toggle("warn", warn);
  $("actions").replaceChildren(...actions);
  $("code").textContent = [desc, code && code !== "0" ? `(${code})` : "", url].filter(Boolean).join(" ");
})();
