import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendDir = path.join(repoRoot, "frontend");
const outputGif = path.join(repoRoot, "img", "readme-gameplay-hero.gif");
const frontendRequire = createRequire(path.join(frontendDir, "package.json"));

const FRONTEND_URL = "http://127.0.0.1:3100";
const VIEWPORT = { width: 1440, height: 900 };

await assertPlaywrightInstalled();
const { chromium } = frontendRequire("playwright");

const runtimeDir = await mkdtemp(path.join(tmpdir(), "sre-readme-hero-"));
const framesDir = path.join(runtimeDir, "frames");
await mkdir(framesDir, { recursive: true });

const children = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertFile(filePath, message) {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

async function assertPlaywrightInstalled() {
  try {
    frontendRequire.resolve("playwright");
  } catch {
    throw new Error("Playwright is missing. Run `make install` and ensure frontend dependencies are installed.");
  }
}

function startProcess(name, command, args, cwd, extraEnv = {}) {
  const logPath = path.join(runtimeDir, `${name}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const handle = {
    name,
    child,
    logPath,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform !== "win32") {
        process.kill(-child.pid, "SIGINT");
      } else {
        child.kill("SIGINT");
      }
      await waitForExit(child, 15_000);
    },
  };

  children.push(handle);
  return handle;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Process did not exit within ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function waitForHttp(url, validate, timeoutMs, label, logPath) {
  const started = Date.now();
  let lastError = "unknown error";

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (await validate(response)) {
        return;
      }
      lastError = `${label} returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  const logs = await tailLog(logPath);
  throw new Error(`${label} did not become ready: ${lastError}\n\nRecent logs:\n${logs}`);
}

async function tailLog(logPath) {
  try {
    const content = await readFile(logPath, "utf8");
    return content.split("\n").slice(-25).join("\n");
  } catch {
    return "(log unavailable)";
  }
}

async function capture(page, frames, name, holdMs) {
  const framePath = path.join(framesDir, `${String(frames.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: framePath, animations: "disabled" });
  frames.push({ path: framePath, holdMs });
}

function pythonAssemblerScript() {
  return `
import json
import sys
from pathlib import Path
from PIL import Image

manifest_path = Path(sys.argv[1])
gif_path = Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())

width = manifest["width"]
scene_infos = manifest["frames"]

base_frames = []
for info in scene_infos:
    image = Image.open(info["path"]).convert("RGBA")
    height = int(round(image.height * (width / image.width)))
    image = image.resize((width, height), Image.Resampling.LANCZOS)
    base_frames.append((image, int(info["holdMs"])))

gif_frames = []
durations = []
previous = None
for image, hold_ms in base_frames:
    if previous is not None:
        for alpha in (0.25, 0.5, 0.75):
            blend = Image.blend(previous, image, alpha)
            gif_frames.append(blend.convert("P", palette=Image.Palette.ADAPTIVE, colors=96))
            durations.append(90)
    gif_frames.append(image.convert("P", palette=Image.Palette.ADAPTIVE, colors=96))
    durations.append(hold_ms)
    previous = image

gif_frames[0].save(
    gif_path,
    save_all=True,
    append_images=gif_frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)
`;
}

async function assembleGif(frames) {
  const manifestPath = path.join(runtimeDir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        width: 920,
        frames,
      },
      null,
      2
    )
  );

  await assertPythonPillow();
  await runCommand("python3", ["-c", pythonAssemblerScript(), manifestPath, outputGif], repoRoot);
}

async function assertPythonPillow() {
  try {
    await runCommand("python3", ["-c", "import PIL"], repoRoot);
  } catch {
    throw new Error(
      "Pillow is required to build the README hero GIF. Install it with `python3 -m pip install Pillow` and rerun `make capture-readme-hero`."
    );
  }
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", () => {});

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`));
    });
  });
}

async function cleanup() {
  for (const handle of [...children].reverse()) {
    try {
      await handle.stop();
    } catch (error) {
      console.warn(`[cleanup] failed to stop ${handle.name}:`, error);
    }
  }

  await rm(runtimeDir, { recursive: true, force: true });
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function main() {
  const frontend = startProcess("frontend", "make", ["dev"], repoRoot, {
    PORT: "3100",
  });

  await waitForHttp(
    FRONTEND_URL,
    async (response) => response.ok,
    60_000,
    "frontend",
    frontend.logPath
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });

  const page = await context.newPage();
  const frames = [];

  try {
    await page.goto(FRONTEND_URL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "SRE Simulator" }).waitFor();
    await capture(page, frames, "landing", 800);

    await page.goto(`${FRONTEND_URL}/readme-demo/overview`, { waitUntil: "networkidle" });
    await page.getByText("Mock incident for easy difficulty").waitFor();
    await sleep(300);
    await capture(page, frames, "overview", 850);

    await page.goto(`${FRONTEND_URL}/readme-demo/dashboard`, { waitUntil: "networkidle" });
    await page.getByText("Cluster Overview").waitFor();
    await sleep(300);
    await capture(page, frames, "dashboard", 900);

    await page.goto(`${FRONTEND_URL}/readme-demo/guide`, { waitUntil: "networkidle" });
    await page.getByText("SRE Investigation Guide").waitFor();
    await sleep(300);
    await capture(page, frames, "guide", 900);

    await page.goto(`${FRONTEND_URL}/readme-demo/chat`, { waitUntil: "networkidle" });
    await page.getByText("Begin with context gathering.").waitFor();
    await sleep(300);
    await capture(page, frames, "chat", 950);

    await page.goto(`${FRONTEND_URL}/readme-demo/score`, { waitUntil: "networkidle" });
    await page.getByText("Investigation Complete").waitFor();
    await sleep(300);
    await capture(page, frames, "score", 1200);

    await assembleGif(frames);
  } finally {
    await browser.close();
  }

  const stats = await readFile(outputGif);
  console.log(`Generated ${path.relative(repoRoot, outputGif)} (${Math.round(stats.byteLength / 1024)} KiB)`);
}

try {
  await main();
} finally {
  await cleanup();
}
