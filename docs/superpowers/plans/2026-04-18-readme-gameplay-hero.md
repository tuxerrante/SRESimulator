# README Gameplay Hero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a short real gameplay hero animation from the local app in mock mode and replace the static README landing image with that animated asset.

**Architecture:** Run the existing frontend and backend locally with the frontend BFF proxy pointed at the mock-mode backend. Use a small automation script to drive the real UI through a deterministic demo path, capture frames, assemble them into a compact animated asset, and wire that asset into the top of the README.

**Tech Stack:** Next.js, Express backend in mock mode, Node.js automation, Python/Pillow GIF assembly, Markdown/HTML README embedding

---

## Task 1: Prepare local capture environment

**Files:**

- Modify: `frontend/src/app/api/[...path]/route.ts`
- Test: `backend/src/integration/game-flow.test.ts`

- [ ] **Step 1: Verify the local proxy and mock flow assumptions**

```ts
function getBackendBaseUrl(): string {
  const base = process.env.BACKEND_INTERNAL_BASE_URL || "http://127.0.0.1:8080";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}
```

- [ ] **Step 2: Install dependencies in the isolated worktree**

Run: `make install`
Expected: frontend and backend dependencies install successfully in the worktree.

- [ ] **Step 3: Run focused baseline verification for the existing backend game flow**

Run: `cd backend && AI_MOCK_MODE=true npm run test:integration -- src/integration/game-flow.test.ts`
Expected: integration flow passes against the mock backend.

## Task 2: Add deterministic capture automation

**Files:**

- Create: `scripts/capture-readme-hero.mjs`
- Create: `img/readme-gameplay-hero.gif`
- Create: `img/readme-gameplay-hero-poster.png`
- Test: `scripts/capture-readme-hero.mjs`

- [ ] **Step 1: Write the capture script skeleton**

```js
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

async function main() {
  const workspaceRoot = process.cwd();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "sre-readme-hero-"));
  console.log(`capture workspace: ${tempRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Start backend and frontend subprocesses in the script**

```js
const backendEnv = {
  ...process.env,
  PORT: "8080",
  AI_MOCK_MODE: "true",
  AI_STRICT_STARTUP: "true",
};

const frontendEnv = {
  ...process.env,
  PORT: "3000",
  BACKEND_INTERNAL_BASE_URL: "http://127.0.0.1:8080",
};
```

- [ ] **Step 3: Drive a deterministic demo path in the real UI**

```js
const demoSteps = [
  { type: "fill", selector: 'input[aria-label="Callsign"]', value: "Echo-7" },
  { type: "click", selector: 'button:has-text("The Junior SRE")' },
  { type: "waitFor", selector: '[data-tour="incident-ticket"]' },
  { type: "dismissOptionalTour" },
  { type: "fill", selector: 'textarea, input[placeholder*="investigation"], textarea[placeholder*="investigation"]', value: "I see API pods offline and nodes not ready. What should I check first?" },
  { type: "submitChat" },
  { type: "waitFor", selector: 'text=/oc get|check the cluster/i' },
];
```

- [ ] **Step 4: Capture frames and assemble an animated GIF**

```js
const captureMoments = [
  { name: "landing", delayMs: 300 },
  { name: "difficulty", delayMs: 500 },
  { name: "ticket", delayMs: 700 },
  { name: "chat", delayMs: 900 },
  { name: "terminal", delayMs: 700 },
];
```

- [ ] **Step 5: Emit final assets into `img/`**

Run: `node scripts/capture-readme-hero.mjs`
Expected: `img/readme-gameplay-hero.gif` and `img/readme-gameplay-hero-poster.png` are created.

## Task 3: Replace the README hero

**Files:**

- Modify: `README.md`
- Test: `README.md`

- [ ] **Step 1: Replace the static landing image block with the animated hero**

```md
<p align="center">
  <img src="img/readme-gameplay-hero.gif" alt="Gameplay demo of SRE Simulator" width="100%">
</p>
```

- [ ] **Step 2: Keep the README top section clean and centered**

Run: `npx markdownlint-cli README.md`
Expected: markdown remains valid and the image block lints cleanly.

## Task 4: Verify final output

**Files:**

- Modify: `README.md`
- Modify: `img/readme-gameplay-hero.gif`
- Modify: `img/readme-gameplay-hero-poster.png`

- [ ] **Step 1: Re-run the capture script from a clean state**

Run: `node scripts/capture-readme-hero.mjs`
Expected: script exits 0 and regenerates the hero assets.

- [ ] **Step 2: Run focused markdown and lint verification**

Run: `make lint-md`
Expected: markdown checks pass.

- [ ] **Step 3: Run a focused visual sanity check**

Run: `python3 - <<'PY'
from PIL import Image
img = Image.open("img/readme-gameplay-hero.gif")
print(img.size, getattr(img, "n_frames", 1))
PY`
Expected: prints a reasonable frame size and multiple frames.
