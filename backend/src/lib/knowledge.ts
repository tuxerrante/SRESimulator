import { readFile } from "fs/promises";
import { join } from "path";

const KNOWLEDGE_BASE_DIR =
  process.env.KNOWLEDGE_BASE_DIR || join(process.cwd(), "..", "knowledge_base");

const FILES = [
  "sre-investigation-techniques.md",
  "Openshift-clusters-alerts-resolutions.md",
  "Community-reported-issues.md",
] as const;

let cachedKnowledge: string | null = null;
let cachedGuide: string | null = null;

export async function loadKnowledgeBase(): Promise<string> {
  if (cachedKnowledge) return cachedKnowledge;

  const sections: string[] = [];

  for (const file of FILES) {
    try {
      const content = await readFile(join(KNOWLEDGE_BASE_DIR, file), "utf-8");
      const label = file.replace(".md", "").replace(/-/g, " ");
      sections.push(`## ${label}\n\n${content}`);
    } catch {
      console.warn(`Could not load knowledge base file: ${file}`);
    }
  }

  cachedKnowledge = sections.join("\n\n---\n\n");
  return cachedKnowledge;
}

const GUIDE_FILE = FILES[0];

export async function loadGuideContent(): Promise<string> {
  if (cachedGuide) return cachedGuide;

  try {
    cachedGuide = await readFile(
      join(KNOWLEDGE_BASE_DIR, GUIDE_FILE),
      "utf-8"
    );
  } catch {
    console.warn(`Could not load guide file: ${GUIDE_FILE}`);
    cachedGuide = "";
  }

  return cachedGuide;
}
