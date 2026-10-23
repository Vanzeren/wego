# Use wego with Playwright and other CDP clients

wego is a real, visible browser that you and your agents share. Any
CDP-capable automation framework can drive it — which means your existing
Playwright suites and LLM agents can use **your logged-in session on Linux**,
without exporting cookies or re-logging-in.

Two ways to drive wego:

| Approach | Best for | How |
|---|---|---|
| wego SDK (`wego-browser nodejs`) | Task spaces, handoff/takeover, site learnings, snapshot refs | Built in — see `skill-body/SKILL.md` |
| Standard CDP (this guide) | Existing Playwright code, browser-use, any CDP client | `WEGO_DEBUG_PORT` |

## 1. Enable the CDP endpoint for a session

`WEGO_DEBUG_PORT` opens a real Chromium DevTools endpoint for that wego
session (default: no endpoint exists at all).

```bash
# AppImage
WEGO_DEBUG_PORT=9222 ./wego-0.1.0-x86_64.AppImage

# from source
WEGO_DEBUG_PORT=9222 npm start
```

**Security:** this endpoint has **no authentication** and listens on
127.0.0.1. Any local process can then drive every tab (your cookies, your
sessions). Use it only on a single-user machine, and only while you need the
integration. For wego's own SDK you never need it — the SDK uses the
permission-gated Unix-socket tunnel instead.

## 2. Playwright (Node.js) — verified

```bash
npm i playwright-core   # no browser download needed — wego IS the browser
```

```js
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

// wego exposes your existing tabs — drive the logged-in session directly.
const page = browser.contexts()[0].pages()[0];

await page.goto('https://example.com');
console.log(await page.title());
await page.click('text=More information');
await page.screenshot({ path: '/tmp/wego-playwright.png' });

await browser.close(); // disconnects CDP only — wego keeps running
```

Verified on wego 0.1.0 (Electron 38 / Chromium 140): navigation, locators,
click, fill, evaluate, screenshots.

**Tips**
- `browser.contexts()[0].pages()` lists wego's tabs (including the chrome UI
  page — filter by `page.url()` when it matters).
- Prefer driving existing tabs: they carry your logged-in cookies. New raw
  targets created outside wego's space model aren't managed as task spaces.
- `browser.close()` detaches the CDP connection; it does not close wego.

## 3. Playwright (Python)

```python
from playwright.async_api import async_playwright

async with async_playwright() as p:
    browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = browser.contexts[0].pages[0]
    await page.goto("https://example.com")
    print(await page.title())
    await browser.close()
```

## 4. browser-use — fixed by upstream PR (pending merge)

browser-use's tab watchdogs assume a standard Chromium target list and
used to close wego's `file://` chrome page (fatal) and focus it (broken).
We fixed it upstream: [browser-use/browser-use#6192](https://github.com/browser-use/browser-use/pull/6192)
(verified live against wego: default security mode, navigation works).

Until that PR merges and is released, install the patched fork:

```bash
pip install "git+https://github.com/Vanzeren/browser-use@fix/electron-chrome-targets"
```

Then connect to wego's endpoint as usual:

```python
from browser_use import Agent, Browser, ChatOpenAI

browser = Browser(cdp_url="http://127.0.0.1:9222")  # default security mode works
agent = Agent(
    task="Summarize the first 3 unread emails in my inbox",
    browser=browser,
    llm=ChatOpenAI(model="gpt-4o"),  # bring your own LLM key
)
```

(Launch wego with `WEGO_DEBUG_PORT=9222` first — see section 1.)

## Which one should I pick?

- **wego SDK** when you want the space model: an agent works in its own
  space, you watch in the sidebar, take over when it's stuck, hand control
  back. Also for the snapshot/ref workflow and site learnings.
- **Playwright** when you already have automation code and just want it to
  run against your real, logged-in browser on Linux.
- **browser-use** — see the compatibility note above; currently use
  Playwright or the wego SDK instead.
