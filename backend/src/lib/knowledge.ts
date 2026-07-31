import { readFile } from "fs/promises";
import { join } from "path";
import {
  DEFAULT_PLATFORM_ID,
  type PlatformId,
} from "../../../shared/types/platform";
import { getRuntimePlatformProfile } from "./platform-profiles";

const KNOWLEDGE_BASE_DIR =
  process.env.KNOWLEDGE_BASE_DIR || join(process.cwd(), "..", "knowledge_base");

const SHARED_FILES = [
  "sre-investigation-techniques.md",
  "Openshift-clusters-alerts-resolutions.md",
  "Community-reported-issues.md",
] as const;

const INVESTIGATION_FILE = SHARED_FILES[0];

const cachedKnowledge = new Map<PlatformId, string>();
const cachedSections = new Map<PlatformId, KBSection[]>();
let cachedGuide: string | null = null;

export interface KBSection {
  title: string;
  content: string;
  source: string;
  keywords: string[];
}

function getKnowledgeFiles(platform: PlatformId): string[] {
  return [
    ...SHARED_FILES,
    ...getRuntimePlatformProfile(platform).knowledgeFiles,
  ];
}

export async function loadKnowledgeBase(
  platform: PlatformId = DEFAULT_PLATFORM_ID,
): Promise<string> {
  const cached = cachedKnowledge.get(platform);
  if (cached) {
    return cached;
  }

  const sections: string[] = [];

  for (const file of getKnowledgeFiles(platform)) {
    try {
      const content = await readFile(join(KNOWLEDGE_BASE_DIR, file), "utf-8");
      const label = file.replace(".md", "").replace(/-/g, " ");
      sections.push(`## ${label}\n\n${content}`);
    } catch {
      console.warn(`Could not load knowledge base file: ${file}`);
    }
  }

  const result = sections.join("\n\n---\n\n");
  cachedKnowledge.set(platform, result);
  return result;
}

const KB_TECH_TERMS: readonly string[] = [
  "etcd", "kubelet", "cri-o", "kube-apiserver", "oauth", "mco",
  "pvc", "scc", "rbac", "dns", "nsg", "hive", "pucm",
  "oomkill(?:ed)?", "crashloop(?:backoff)?", "imagepu(?:ll(?:backoff)?)?",
  "networkpolicy", "egressip", "coreDNS", "fdatasync", "webhook",
  "machine[\\s-]?config", "pull[\\s-]?secret", "cluster[\\s-]?version",
  "node[\\s-]?(?:not)?ready", "disk[\\s-]?pressure",
  "cpu[\\s-]?throttl(?:ing|e)?", "resource[\\s-]?quota", "taint(?:ed)?",
  "networking", "storage", "registry", "authentication",
  "control[\\s-]?plane", "upgrade", "install", "certificate",
  "compliance", "partition", "cosmos[\\s-]?db", "monitor", "alert",
  "operator", "deployment", "route", "ingress", "nodepool", "aks",
  "kubectl", "guest[\\s-]?cluster",
  "503", "429", "137", "410",
];

const KB_TERMS_REGEX = new RegExp(
  `\\b(?:${KB_TECH_TERMS.join("|")})\\b`,
  "gi",
);

function extractKeywords(title: string, content: string): string[] {
  const combined = `${title} ${content}`.toLowerCase();
  const techTerms = combined.match(KB_TERMS_REGEX) ?? [];
  const uniqueTerms = [...new Set(techTerms.map((term) => term.toLowerCase()))];
  return uniqueTerms;
}

function pushSection(
  sections: KBSection[],
  title: string,
  lines: string[],
  source: string,
): void {
  const body = lines.join("\n").trim();
  if (!body) return;
  sections.push({
    title,
    content: `## ${title}\n\n${body}`,
    source,
    keywords: extractKeywords(title, body),
  });
}

function parseFileIntoSections(content: string, source: string): KBSection[] {
  const lines = content.split("\n");
  const sections: KBSection[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      pushSection(sections, currentTitle || "Preamble", currentLines, source);
      currentTitle = headerMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  pushSection(sections, currentTitle || "Preamble", currentLines, source);

  return sections;
}

export async function loadKnowledgeSections(
  platform: PlatformId = DEFAULT_PLATFORM_ID,
): Promise<KBSection[]> {
  const cached = cachedSections.get(platform);
  if (cached) {
    return cached;
  }

  const allSections: KBSection[] = [];

  for (const file of getKnowledgeFiles(platform)) {
    try {
      const content = await readFile(join(KNOWLEDGE_BASE_DIR, file), "utf-8");
      allSections.push(...parseFileIntoSections(content, file));
    } catch {
      console.warn(`Could not load knowledge base file: ${file}`);
    }
  }

  cachedSections.set(platform, allSections);
  return allSections;
}

export function queryKnowledgeSections(
  sections: KBSection[],
  queryTerms: string[],
  maxChars: number = 8000,
): string {
  const queryLower = queryTerms
    .filter(Boolean)
    .map((term) => term.toLowerCase())
    .join(" ");
  const queryWords = queryLower.split(/\s+/).filter((word) => word.length > 2);

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

  scoredSections.sort((left, right) => right.score - left.score);

  const separator = "\n\n---\n\n";
  const investigationText = investigationSections
    .map((section) => section.content)
    .join("\n\n");

  if (investigationText.length >= maxChars) {
    return investigationText.slice(0, maxChars);
  }

  let remaining = maxChars - investigationText.length;
  const selectedParts: string[] = [];

  if (investigationText.length > 0) {
    selectedParts.push(investigationText);
  }

  for (const { section } of scoredSections) {
    if (remaining <= 0) break;
    const separatorCost = selectedParts.length > 0 ? separator.length : 0;
    const totalCost = section.content.length + separatorCost;
    if (totalCost <= remaining) {
      selectedParts.push(section.content);
      remaining -= totalCost;
    }
  }

  return selectedParts.join(separator);
}

const GUIDE_FILE = INVESTIGATION_FILE;

export async function loadGuideContent(): Promise<string> {
  if (cachedGuide !== null) {
    return cachedGuide;
  }

  cachedGuide = await readFile(join(KNOWLEDGE_BASE_DIR, GUIDE_FILE), "utf-8");
  return cachedGuide;
}

// ts-unused-exports:disable-next-line
export function _resetCacheForTests(): void {
  cachedKnowledge.clear();
  cachedSections.clear();
  cachedGuide = null;
}
