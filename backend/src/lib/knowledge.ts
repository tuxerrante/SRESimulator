import { readFile } from "fs/promises";
import { join } from "path";

const KNOWLEDGE_BASE_DIR =
  process.env.KNOWLEDGE_BASE_DIR || join(process.cwd(), "..", "knowledge_base");

const FILES = [
  "sre-investigation-techniques.md",
  "Openshift-clusters-alerts-resolutions.md",
  "Community-reported-issues.md",
] as const;

const INVESTIGATION_FILE = FILES[0];

let cachedKnowledge: string | null = null;
let cachedGuide: string | null = null;
let cachedSections: KBSection[] | null = null;

export interface KBSection {
  title: string;
  content: string;
  source: string;
  keywords: string[];
}

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

function extractKeywords(title: string, content: string): string[] {
  const combined = `${title} ${content}`.toLowerCase();
  const techTerms = combined.match(
    /\b(?:etcd|kubelet|cri-o|kube-apiserver|oauth|mco|pvc|scc|rbac|dns|nsg|hive|pucm|oomkill(?:ed)?|crashloop(?:backoff)?|imagepu(?:ll(?:backoff)?)?|networkpolicy|egressip|coreDNS|fdatasync|webhook|machine[\s-]?config|pull[\s-]?secret|cluster[\s-]?version|node[\s-]?(?:not)?ready|disk[\s-]?pressure|cpu[\s-]?throttl(?:ing|e)?|resource[\s-]?quota|taint(?:ed)?|networking|storage|registry|authentication|control[\s-]?plane|upgrade|install|certificate|compliance|partition|cosmos[\s-]?db|monitor|alert|operator|deployment|route|ingress|503|429|137|410)\b/gi
  ) ?? [];
  const uniqueTerms = [...new Set(techTerms.map((t) => t.toLowerCase()))];
  return uniqueTerms;
}

function parseFileIntoSections(content: string, source: string): KBSection[] {
  const lines = content.split("\n");
  const sections: KBSection[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{2,3})\s+(.+)/);
    if (headerMatch) {
      if (currentTitle && currentLines.length > 0) {
        const body = currentLines.join("\n").trim();
        sections.push({
          title: currentTitle,
          content: `## ${currentTitle}\n\n${body}`,
          source,
          keywords: extractKeywords(currentTitle, body),
        });
      }
      currentTitle = headerMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentTitle && currentLines.length > 0) {
    const body = currentLines.join("\n").trim();
    sections.push({
      title: currentTitle,
      content: `## ${currentTitle}\n\n${body}`,
      source,
      keywords: extractKeywords(currentTitle, body),
    });
  }

  return sections;
}

export async function loadKnowledgeSections(): Promise<KBSection[]> {
  if (cachedSections) return cachedSections;

  const allSections: KBSection[] = [];

  for (const file of FILES) {
    try {
      const content = await readFile(join(KNOWLEDGE_BASE_DIR, file), "utf-8");
      allSections.push(...parseFileIntoSections(content, file));
    } catch {
      console.warn(`Could not load knowledge base file: ${file}`);
    }
  }

  cachedSections = allSections;
  return cachedSections;
}

/**
 * Score and select KB sections relevant to the given query terms.
 * Always includes the investigation methodology file sections.
 * Returns concatenated markdown capped at maxChars.
 */
export function queryKnowledgeSections(
  sections: KBSection[],
  queryTerms: string[],
  maxChars: number = 8000,
): string {
  const queryLower = queryTerms
    .filter(Boolean)
    .map((t) => t.toLowerCase())
    .join(" ");
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  const investigationSections: KBSection[] = [];
  const scoredSections: Array<{ section: KBSection; score: number }> = [];

  for (const section of sections) {
    if (section.source === INVESTIGATION_FILE) {
      investigationSections.push(section);
      continue;
    }

    let score = 0;
    const titleLower = section.title.toLowerCase();

    for (const word of queryWords) {
      if (titleLower.includes(word)) score += 3;
    }
    for (const keyword of section.keywords) {
      if (queryLower.includes(keyword)) score += 2;
    }

    if (score > 0) {
      scoredSections.push({ section, score });
    }
  }

  scoredSections.sort((a, b) => b.score - a.score);

  const investigationText = investigationSections
    .map((s) => s.content)
    .join("\n\n");

  let remaining = maxChars - investigationText.length;
  const selectedParts = [investigationText];

  for (const { section } of scoredSections) {
    if (remaining <= 0) break;
    if (section.content.length <= remaining) {
      selectedParts.push(section.content);
      remaining -= section.content.length;
    }
  }

  return selectedParts.join("\n\n---\n\n");
}

const GUIDE_FILE = INVESTIGATION_FILE;

export async function loadGuideContent(): Promise<string> {
  if (cachedGuide !== null) return cachedGuide;

  cachedGuide = await readFile(
    join(KNOWLEDGE_BASE_DIR, GUIDE_FILE),
    "utf-8"
  );

  return cachedGuide;
}

// ts-unused-exports:disable-next-line
export function _resetCacheForTests(): void {
  cachedKnowledge = null;
  cachedGuide = null;
  cachedSections = null;
}
