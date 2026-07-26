# The Bay — Scrape Worker (Chrome extension)

A browser extension that contributes event scraping to [thebay.events](https://thebay.events)
from **your own connection**.

## Why a browser, and not a server

Eventbrite and several other sources block datacenter IPs, which is the entire reason the
catalog has historically been produced on one person's laptop. A browser extension is the
honest answer rather than a clever one: it is a real Chrome, on a real residential
connection, with a genuine Chrome User-Agent that nobody is spoofing, and — if you happen to
be logged in — your own session. Sources that refuse a server refuse it for reasons that
simply do not apply here.

## Install

```bash
npm run build:extension
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`dist/extension`.

## Use

1. **Join the network first.** Meet a member in person; their phone shows a moving code and
   your camera watches it for a second or two (`thebay.events/app/handshake`). There is no
   other way in — see below.
2. Register this browser at `thebay.events/app/contribute` → *Register this browser*. You get
   a token, shown **once**.
3. Open the extension, paste the token, press **Start working**.

Nothing runs until you press Start, and stopping is one press. Pages are opened in background
tabs (`active: false`) so your own browsing is never hijacked.

## What it actually does

Every minute a Chrome alarm wakes the service worker, which asks the coordinator for work.
The coordinator decides what, how much and how often — the extension cannot choose to crawl
something, and cannot crawl a host faster than the coordinator hands out permission. For each
job it either fetches a JSON API directly or opens the page in a background tab and reads its
embedded data (JSON-LD, `__NEXT_DATA__`, `window.__SERVER_DATA__`) with native DOM APIs.

It then submits **raw** observations. It does not normalise, fingerprint, or decide which
event anything is — the server does all of that, which is what makes it impossible for a
client to aim its data at an existing event or to lie about a hash it never computed.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Your token and the on/off switch. Nothing else is stored. |
| `alarms` | A service worker is evicted after ~30s idle; an alarm is the only durable heartbeat. |
| `tabs`, `scripting` | Open a background tab and read the page's embedded event data. |
| `host_permissions: https://*/*` | The set of sources is server-side data and changes without an extension update — that is the point of recipes-as-data. It only ever visits URLs the coordinator hands it. |

## Privacy

- Your browsing is never read. The extension only reads pages **it** opened, for a job the
  coordinator issued.
- Your IP address is never stored. The server keeps a salted hash of it plus your network's
  ASN, and only to answer one question: are two workers independent? Two accounts behind one
  connection are one observer, and letting them corroborate each other is how a fake account
  would publish whatever it liked.
- Your token reaches `/api/net/*` and nothing else. It cannot touch any admin endpoint.

## Source

The protocol client (`src/net/client.ts`) and every field mapping are shared verbatim with the
CLI worker and the server. That is deliberate: three clients with their own idea of which field
is the start time would disagree about the same page, and the network reads disagreement as
somebody lying.
