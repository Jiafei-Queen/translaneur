# Spike: the go/no-go experiment

Four unknowns in the Thunderbird port have no documented answer, and all four
concern the same thing: whether a **message display page** behaves like a
content page for our injection and rendering. This spike answers them with a
~30-line probe script before any port work is invested. Half a day, one
afternoon.

Build a minimal extension (manifest below), load it via
Tools → Add-ons → "Debug Add-ons" → Load Temporary Add-On, and run the probes.

## Manifest

```jsonc
{
  "manifest_version": 3,
  "name": "tb-spike",
  "version": "0.0.1",
  "browser_specific_settings": {
    "gecko": { "id": "tb-spike@jiafei.dev", "strict_min_version": "140.0" }
  },
  "permissions": ["messagesModify", "tabs", "scripting"],
  "message_display_action": { "default_popup": "popup.html" },
  "background": { "scripts": ["background.js"] }
}
```

`background.js` registers the probe script and can also inject on demand:

```js
browser.messageDisplayScripts.register({
  js: [{ file: "probe.js" }],
  runAt: "document_idle",
});
// on-demand, for already-open messages:
browser.messageDisplay.onMessageDisplayed.addListener(async (tab, message) => {
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["probe.js"] });
});
```

`probe.js` writes its findings where you can read them: `console.log` (visible
with the extension's debugging console) and/or `document.title = ...` for
quick eyeballing.

## The four probes

### 1. Message DOM shape — can the walker reach the body?

```js
console.log("readyState", document.readyState);
console.log("iframes", document.querySelectorAll("iframe, frame").length);
console.log(
  "body children",
  [...(document.body?.children ?? [])].map((c) => `${c.tagName}.${c.className}`).slice(0, 10),
);
console.log("body text sample", document.body?.innerText?.slice(0, 200));
```

Question: is rendered message HTML inline in `document.body`, or confined to an
iframe? If inline, `extractBlocks(document.body)` in `lib/dom.ts` works as-is.
If framed, extraction targets `iframe.contentDocument` — an adapter in
`inject.js`.

Run against: an HTML newsletter with remote images, a plain-text email, and a
long multi-part thread. (For plain text, the body is a `<pre>` — the walker
yields one big block, which is a product decision, not a blocker.)

### 2. Style injection — does the renderer's stylesheet survive?

`lib/render.ts` inserts translations as styled blocks; `lib/addStyle.ts`
injects a `<style>` element.

```js
const s = document.createElement("style");
s.textContent = ".tb-spike-probe { background: magenta !important; }";
document.head.appendChild(s);
const p = document.createElement("span");
p.className = "tb-spike-probe";
p.textContent = "translated";
document.body.appendChild(p);
```

Is the span visibly magenta? If CSP strips the `<style>`, a port must inline
styles per element (a contained change to `render.ts`) — a yes here keeps
`render.ts` unchanged.

Also verify Thunderbird's remote-content blocking: with remote content
*blocked*, do appended nodes and styles still render? (`addStyle` content is
extension-generated, not network-loaded, so a yes is expected — but sanitizing
pipelines have surprised people with passive CSP on the display document.)

### 3. Scriptability of the surfaces where mail is actually read

Run the manual-injection path (`scripting.executeScript` from a
followup-header button, or the add-on console) against:

1. **A message tab in the 3-pane window** (click a message in the main window)
2. **A stand-alone message window** (double-click a message)
3. **The 3-pane preview pane itself** — no tab of its own; test
   `messageDisplayScripts.register()` and see where it lands

Keyed by `tab.type`:

```js
const tabs = await browser.tabs.query({});
console.table(tabs.map((t) => ({ id: t.id, type: t.type, title: t.title })));
```

Question: which reading surfaces are addressable? Message tabs and stand-alone
windows are documented as scriptable; the **3-pane preview pane is the open
risk** — it is the default reading surface for many users. If it is not
scriptable, the port still ships but its everyday surface is narrowed (see
[port.md](port.md) tier 3).

### 4. Interaction with mail-specific handlers

After injecting, click links and buttons inside the displayed message, scroll,
and switch to the next message with keyboard navigation:

- do appended translation blocks survive a re-render (Junk / mark-as-read /
  next-message)? Does Thunderbird rewrite the display document per message?
- does `click` capture inside the injected script break mail UI handlers
  (the browser build already uses passive/capture listeners, same pattern)?
- when does the injected script see it torn down —
  `messageDisplay.onMessageDisplayed` is the natural reset point; confirm it
  fires with a stable `tabId` so `storage.session` state keys stay valid.

## Success criteria

All four logged. At minimum, if (1) shows the body is inline and (2) shows
styles survive in a message tab and a stand-alone window, the port is a go; a
no on probe 3's preview pane is a narrowing, not a stop.

Record results in this file — a results table at the bottom — so the decision
is traceable.
