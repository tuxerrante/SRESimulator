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
