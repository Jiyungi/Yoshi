# Optional: Rover for feed actions

The filter doesn't need Rover. Add Rover only if you want the agent to take
real site actions (unfollow/mute via LinkedIn's own UI) instead of just hiding
posts on your screen.

Per `EXTENSION_USERS.md`, package the runtime and inject the boot bridge from
`background.js` in the MAIN world. Sketch:

```bash
mkdir -p vendor
curl -L https://rover.rtrvr.ai/embed.js -o vendor/rover-embed.js
curl -L https://rover.rtrvr.ai/worker/worker.js -o vendor/worker.js
```

Add to `manifest.json`:

```json
"web_accessible_resources": [
  { "resources": ["vendor/worker.js"], "matches": ["https://www.linkedin.com/*"] }
]
```

Then, on a user gesture in `background.js`:

```js
const config = {
  siteId: "your_site_id",
  publicKey: "pk_site_...",
  siteKeyId: "key_...",
  apiBase: "https://agent.rtrvr.ai",
  allowedDomains: ["linkedin.com"],
  domainScopeMode: "registrable_domain",
  openOnInit: true,
  allowActions: true,
  workerUrl: chrome.runtime.getURL("vendor/worker.js")
};

await chrome.scripting.executeScript({
  target: { tabId, allFrames: false },
  world: "MAIN",
  injectImmediately: true,
  func: (cfg) => {
    const rover = (window.rover = window.rover || function () {
      (rover.q = rover.q || []).push(arguments);
    });
    rover("boot", cfg);
  },
  args: [config]
});

await chrome.scripting.executeScript({
  target: { tabId, allFrames: false },
  world: "MAIN",
  injectImmediately: true,
  files: ["vendor/rover-embed.js"]
});
```

Get the config values from https://rtrvr.ai/rover/workspace (add `linkedin.com`
to the site policy). Keep `publicKey` only — never ship private keys.

Then drive an action with a prompt like:
"Unfollow the author of the currently focused post."

Keep all classification/UI in the isolated content script (as today); use the
MAIN world only for the Rover boot bridge.
