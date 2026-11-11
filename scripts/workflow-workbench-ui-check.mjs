// Local-only visual/interaction regression check. Real Angular components; API replies are fixtures
// from the repository seeds/catalogue, NOT a real backend or connector execution. No credentials.
// Build apps/api, run plugin-dev-setup, then build apps/web with --configuration development.
// CHROME_BIN=/path/to/chrome node scripts/workflow-workbench-ui-check.mjs [screenshot-directory]
import { fileURLToPath } from "node:url";
import { SEEDS } from "../apps/api/dist/workflows/demo-seed.js";
import { blockCatalogue, WF_EVENTS } from "../apps/api/dist/workflows/model.js";
import { renderLogo } from "../apps/api/dist/branding/logo.js";
import { DEFAULT_COLORS } from "../apps/api/dist/branding/theme-engine.js";
import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "apps/web/dist/web/browser");
const out = path.resolve(process.argv[2] ?? "/tmp/workflow-workbench-shots");
const seed = SEEDS.find((s) => s.id === "wf-hr-onboarding");
const fixture = {
  definition: {
    ...seed,
    active: true,
    graph: { nodes: seed.nodes, edges: seed.edges },
  },
  blocks: blockCatalogue().map((b) => ({ ...b, providerActive: true })),
  events: Object.entries(WF_EVENTS).map(([type, e]) => ({ type, ...e })),
};
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://localhost"),
    p = u.pathname;
  let data;
  if (p.endsWith(".svg") && p.includes("/branding/")) {
    res.setHeader("content-type", "image/svg+xml");
    res.end(
      renderLogo(
        DEFAULT_COLORS,
        p.includes("dark") ? "dark" : "light",
        p.endsWith("favicon.svg"),
      ),
    );
    return;
  }
  if (p.endsWith("/theme.css")) {
    res.setHeader("content-type", "text/css");
    res.end("");
    return;
  }
  if (p.startsWith("/api/")) {
    if (p.endsWith("/me/access"))
      data = {
        subject: "demo-alice",
        admin: true,
        restricted: false,
        plugins: { "workflows-iga": true, "workflow-connectors": true },
      };
    else if (p.endsWith("/workspace/personal"))
      data = { branch: "personal/demo-alice", status: "reused" };
    else if (p.endsWith("/plugins/menu"))
      data = {
        entries: [
          {
            plugin: "workflows-iga",
            id: "workflows",
            title: "Workflows",
            area: "admin",
            group: "Automation (IGA)",
            icon: "⟳",
            path: "/workflows",
            order: 10,
          },
        ],
      };
    else if (p.endsWith("/plugins"))
      data = {
        plugins: [
          { id: "workflows-iga", enabled: true },
          { id: "workflow-connectors", enabled: true },
        ],
      };
    else if (p.endsWith("/workflow-blocks")) data = { blocks: fixture.blocks };
    else if (p.endsWith("/workflows-events")) data = { events: fixture.events };
    else if (p.includes("/workflows/"))
      data = { definition: fixture.definition };
    else if (p.endsWith("/branches"))
      data = { branches: [{ name: "personal/demo-alice" }, { name: "main" }] };
    else if (p.endsWith("/workspace"))
      data = { diff: { tables: [], rows: { total: 0 } } };
    else if (p.endsWith("/signin/options"))
      data = { mode: "legacy", chains: [] };
    else data = {};
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
    return;
  }
  let f = path.join(root, p);
  if (!existsSync(f) || !path.extname(f)) f = path.join(root, "index.csr.html");
  try {
    res.setHeader(
      "content-type",
      f.endsWith(".js")
        ? "application/javascript"
        : f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".svg")
            ? "image/svg+xml"
            : "text/html",
    );
    res.end(readFileSync(f));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const dir = "/tmp/workflow-cdp-" + process.pid;
mkdirSync(dir, { recursive: true });
const chrome = spawn(
  process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
const wsurl = await new Promise((resolve, reject) => {
  chrome.stderr.on("data", (b) => {
    stderr += b;
    let m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(Error(stderr)), 15000).unref();
});
const ws = new WebSocket(wsurl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  let d = JSON.parse(e.data);
  if (d.id) {
    const x = pending.get(d.id);
    if (x) {
      pending.delete(d.id);
      d.error ? x.reject(Error(JSON.stringify(d.error))) : x.resolve(d.result);
    }
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    let id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: sid } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
const c = (m, p = {}) => send(m, p, sid);
await c("Page.enable");
await c("Runtime.enable");
let errors = [];
const prev = ws.onmessage;
ws.onmessage = (e) => {
  let d = JSON.parse(e.data);
  if (d.method === "Runtime.exceptionThrown")
    errors.push(
      d.params.exceptionDetails.exception?.description ??
        d.params.exceptionDetails.text,
    );
  prev(e);
};
const ev = async (expression) => {
  let r = await c("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(expr) {
  for (let i = 0; i < 100; i++) {
    if (await ev(expr)) return;
    await sleep(100);
  }
  console.log(
    "wait errors",
    errors,
    await ev("document.body.innerText.slice(0,800)"),
    await ev("document.documentElement.outerHTML.slice(-800)"),
  );
  throw Error("wait " + expr);
}
try {
  await c("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c("Page.navigate", { url: `http://127.0.0.1:${port}/login` });
  await wait('!!window.ng && !!document.querySelector("app-login")');
  await ev(
    `(()=>{let a=ng.getComponent(document.querySelector('app-login'));a.s.loggedIn.set(true);a.s.user.set('demo-alice');a.s.selectBranch('personal/demo-alice');a.s.workflowsEnabled.set(true);a.router.navigateByUrl('/workflows/edit/wf-hr-onboarding');})()`,
  );
  await wait('document.querySelectorAll(".wf-node").length > 4');
  await sleep(1500);
  await ev(
    `(()=>{window.editor=ng.getComponent(document.querySelector('app-workflow-edit'));let n=editor.vfNodes().find(n=>editor.state.get(n.id).type==='lyam-create-user');if(n)n.selected.set(true);})()`,
  );
  await sleep(500);
  mkdirSync(out, { recursive: true });
  for (const width of [1440, 390]) {
    await c("Emulation.setDeviceMetricsOverride", {
      width,
      height: width === 390 ? 844 : 950,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    await sleep(250);
    await ev(`editor.fitCanvas()`);
    await sleep(500);
    for (const theme of ["light", "dark"]) {
      await ev(`document.documentElement.dataset.theme='${theme}'`);
      if (width === 390) await ev(`editor.mobilePanel.set('canvas')`);
      await sleep(350);
      const name = `${width === 390 ? "mobile" : "desktop"}-${theme}`;
      let img = await c("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      writeFileSync(`${out}/${name}.png`, Buffer.from(img.data, "base64"));
      if (width === 390) {
        await ev(`editor.mobilePanel.set('settings')`);
        await sleep(200);
        img = await c("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        writeFileSync(
          `${out}/${name}-settings.png`,
          Buffer.from(img.data, "base64"),
        );
      }
      if (await ev("document.body.scrollWidth > innerWidth"))
        throw Error("Horizontal overflow");
      console.log(
        name,
        await ev(
          `JSON.stringify({body:document.body.scrollWidth,viewport:innerWidth,canvasHeight:document.querySelector('.wb-canvas').clientHeight,hasInspector:!!document.querySelector('.wb-inspector-head')})`,
        ),
      );
    }
  }

  await c("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await ev(
    `document.documentElement.dataset.theme='light';editor.mobilePanel.set('canvas')`,
  );
  const check = async (expr, label) => {
    if (!(await ev(expr))) throw Error(label);
    console.log("PASS", label);
  };
  await ev(`document.querySelector('.wb-trigger-edit').click()`);
  await sleep(100);
  await check(
    `document.querySelector('.wb-trigger-fields select')?.name==='wfTrigger'`,
    "Trigger inspector opens from UI",
  );
  await ev(
    `[...document.querySelectorAll('.wb-drawer button')].find(b=>b.textContent==='Done').click()`,
  );
  await sleep(100);
  for (const tab of ["Input", "Output", "Settings"]) {
    await ev(
      `[...document.querySelectorAll('.wb-tab')].find(b=>b.textContent==='${tab}').click()`,
    );
    await sleep(100);
    await check(
      `document.querySelector('.wb-tab.on').textContent==='${tab}'`,
      "Inspector " + tab,
    );
  }
  await ev(`document.querySelector('.wb-tools summary').click()`);
  await check(
    `document.querySelector('.wb-tools').open`,
    "Secondary toolbar opens",
  );
  await ev(
    `document.querySelector('.wb-tools summary').click();document.querySelector('.wb-test-toggle').click()`,
  );
  await sleep(100);
  await check(
    `document.querySelector('.wb-test').textContent.includes('External connectors may make real calls')`,
    "Test panel warns about external effects",
  );
  let img = await c("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(
    path.join(out, "desktop-light-test.png"),
    Buffer.from(img.data, "base64"),
  );
  await ev(
    `document.querySelector('.wb-test button').click();window.countBefore=editor.state.size;[...document.querySelectorAll('.wf-pal')].find(b=>b.textContent.includes('Merge')).click()`,
  );
  await sleep(150);
  await check(
    `editor.state.size===countBefore+1 && editor.dirty()`,
    "Palette click adds a real block and marks unsaved",
  );
  await ev(`editor.undo()`);
  await sleep(150);
  await check(
    `editor.state.size===countBefore && !editor.dirty()`,
    "Undo restores saved graph",
  );
  await c("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(200);
  await ev(`editor.mobilePanel.set('canvas');editor.fitCanvas(false)`);
  await sleep(800);
  await check(
    `(()=>{const c=document.querySelector('vflow').getBoundingClientRect();return [...document.querySelectorAll('.wf-node')].every(n=>{let r=n.getBoundingClientRect();return r.left>=c.left-2&&r.top>=c.top-2&&r.right<=c.right+2&&r.bottom<=c.bottom+2})})()`,
    "Mobile Fit contains every node",
  );
  if (errors.length) throw Error(errors.join("\n"));
  console.log("All browser assertions passed; zero runtime exceptions");
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
