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
  "version": "0.0.2",
  "browser_specific_settings": {
    "gecko": { "id": "tb-spike@jiafei.dev", "strict_min_version": "140.0" }
  },
  "permissions": ["messagesRead", "tabs", "scripting"],
  "message_display_action": { "default_popup": "popup.html" },
  "background": { "scripts": ["background.js"] }
}
```

MV3 naming (verified against the TB latest docs after the first run failed,
see Results): the MV2 `messageDisplayScripts` API and `onMessageDisplayed`
are gone. `scripting.messageDisplay.*` requires **`messagesRead` +
`scripting`** together — with either missing, the whole sub-namespace is
absent. Whether `messagesModify` is additionally required is itself a probe
question (it is high-sensitivity at ATN review; if `messagesRead` suffices,
the port avoids it).

`background.js` registers the probe script and can also inject on demand:

```js
browser.scripting.messageDisplay.registerScripts([
  { id: "tb-spike-probe", js: ["probe.js"], runAt: "document_idle" },
]);
// onMessageDisplayed is gone in MV3; the event is onMessagesDisplayed and
// its second argument is a MessageList, not a single MessageHeader.
browser.messageDisplay.onMessagesDisplayed.addListener(async (tab, list) => {
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["probe.js"] });
});
```

A declarative `message_display_scripts` manifest key also exists (TB 151+);
the spike uses the programmatic call so a permission problem surfaces as a
caught console error instead of a failed add-on load. Note: message display
script console output is known to appear twice — not a double injection.

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

## Results

### Environment (pre-probe, TB 156.0.1, MV3) — 2026-10-05

The original spike code used MV2-era API names and did not load usefully:

- `browser.messageDisplayScripts` is `undefined` under MV3 — the
  `messageDisplayScripts` API was replaced by `scripting.messageDisplay`
  (TB 128+); `background.js` crashed on line 5 before any listener attached.
- `scripting.messageDisplay.*` requires `messagesRead` **and** `scripting`;
  with only `messagesModify` granted, `scripting.messageDisplay` did not
  exist. Fixed by requesting `messagesRead`; `messagesModify` dropped to test
  whether it is needed at all (re-add if `registerScripts` names it).
- `messageDisplay.onMessageDisplayed` is removed in MV3 →
  `onMessagesDisplayed(tab, messageList)`; `getDisplayedMessage()` →
  `getDisplayedMessages()` returning a `MessageList`. **port.md's trigger
  skeleton and state-keying sections must be updated to these names.**
- `Object.keys(runtime.getManifest())` returns the schema key set, not the
  declared keys — `message_display_scripts` (TB 151+) exists in the schema.
- popup paths (`tabs.query`, `scripting.executeScript`) were correct; they
  never ran because the background died first.

### Probe results (TB 157.0.1, MV3) — 2026-10-05

Method: `background.js` registers `probe.js` with
`scripting.messageDisplay.registerScripts()`. `probe.js` runs in the displayed
document and reports back with `runtime.sendMessage`; the background prints one
flat `RESULT {...}` line. A background-side `scripting.executeScript` readback
was tried first but hangs on the 3-pane `mail` tab and on just-created
`messageDisplay` tabs (see probe 3) — the registered script must do the
reporting.

**Probe 1 — message DOM shape**

| Surface | `bodyInline` | `iframes` | body child shape |
| --- | --- | --- | --- |
| HTML newsletter (remote on) | true | 0 | `table.moz-header-part1/2`, then content |
| Plain-text mail | true | 0 | `div.moz-text-plain` (not `<pre>`) |
| Long HTML thread (5 nested blockquotes) | true | 0 | `div.moz-text-html` |
| HTML notice (Google/GitHub) | true | 0 | `div.moz-text-html` |

The body is always inline; no message used an iframe. `document.body` also
contains Thunderbird's own header chrome
(`table.moz-header-part1/2.moz-main-header`), so a port must target the message
content container rather than raw `body.children`. `extractBlocks(document.body)`
works once those header tables are skipped.

Post-port correction: this probe recorded only the *body child* shape. For
text/plain the actual text lives one level deeper, inside
`<pre wrap class="moz-quote-pre">` nested in `div.moz-text-plain`
(`mimetpla.cpp`) — which the extension's walker skips as a code block. That
became TB-1 in `bugs.md`; DOM-shape tests should have drilled one level
down.

**Probe 2 — style survival**

| Condition | `styleSurvived` |
| --- | --- |
| Remote content allowed | true |
| Remote content blocked (yellow "已屏蔽此消息中的远程内容" bar) | true |

The injected `<style>` + `.tb-spike-probe` span rendered magenta in every run
(HTML, plain text, long thread, blocked remote content). CSP does not strip
extension-injected style; `render.ts` / `addStyle.ts` can stay as-is.

**Probe 3 — scriptability of the reading surfaces**

| Surface | `tab.type` | `registerScripts` auto-inject | background `executeScript` |
| --- | --- | --- | --- |
| 3-pane preview pane | `mail` | ✅ runs and reports | ❌ hangs (promise never settles) |
| Message tab in 3-pane / window | `messageDisplay` | ✅ | ✅ when already open; hangs when just created |
| Opened `.eml` file | `messageDisplay` | ✅ | ✅ |

All three reading surfaces are scriptable **via `registerScripts`**; the
`executeScript` hang is a background-injection quirk, not a limit on the port.
`messagesRead` + `scripting` suffice — `messagesModify` is not needed. Opened
`.eml` files display as `messageDisplay` documents too (a test channel that
needs no account).

**Probe 4 — re-render interaction**

| Observation | Result |
| --- | --- |
| `onMessagesDisplayed` `tabId` stability | stable — preview pane fired repeatedly as `tabId: 1`, `tabType: "mail"` |
| Document rewritten per message | yes — the marker timestamp changes on every switch |
| Reset point | re-run the injector on each display; `registerScripts` re-applies automatically |
| JS worlds | `registerScripts` and `executeScript` run in different worlds — `window` state is not shared, so state must live in the DOM or be recomputed |

**Conclusion** — go. The body is inline, styles survive (including with remote
content blocked), and every reading surface — including the 3-pane preview
pane — is scriptable via `registerScripts`. No narrowing required; update
`port.md`'s trigger skeleton to the MV3 names already noted above.
