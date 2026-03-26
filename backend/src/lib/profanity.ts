// Short/ambiguous words that appear as substrings in innocent words
// (e.g. "ass" in "classy", "hell" in "hello", "anal" in "analysis").
// Only flagged when the entire normalized nickname matches exactly.
const EXACT_ONLY: ReadonlySet<string> = new Set([
  "ass", "anal", "cock", "coon", "crap", "cum", "damn", "dick",
  "dyke", "fag", "hell", "homo", "piss", "poon", "rape", "scum", "wop",
]);

const BLOCKLIST: ReadonlySet<string> = new Set([
  "ass", "asshole", "bastard", "bitch", "blowjob", "bollocks", "bullshit",
  "cock", "coon", "crap", "cum", "cunt", "damn", "dick", "dildo", "douche",
  "dyke", "fag", "faggot", "fuck", "fucker", "fucking", "goddamn", "handjob",
  "hell", "homo", "jackass", "jerkoff", "kike", "motherfucker", "nazi",
  "nigga", "nigger", "piss", "prick", "pussy", "rape", "rapist", "retard",
  "scum", "shit", "shithead", "slut", "spic", "twat", "wanker", "whore",
  "anal", "anus", "arsehole", "biatch", "bollock", "boner", "boob", "bugger",
  "buttplug", "cameltoe", "chink", "circlejerk", "clitoris", "cocksuck",
  "cornhole", "cracker", "dago", "deepthroat", "degenerate", "dumbass",
  "ejaculate", "felch", "feltch", "fingerfuck", "fistfuck", "fleshlight",
  "foreskin", "gangbang", "goatse", "gook", "gringo", "grope", "hardon",
  "heeb", "hentai", "honkey", "hooker", "humping", "incest", "jigaboo",
  "kinky", "lesbo", "lmfao", "masturbat", "milf", "mofo", "molest",
  "muffdiv", "neonazi", "nigg", "nympho", "orgasm", "pedo", "pedobear",
  "pedophil", "pegging", "penis", "pimp", "pissoff", "poon", "porn",
  "pube", "queef", "queer", "raghead", "rimjob", "sadist", "scrotum",
  "semen", "sexist", "shemale", "skank", "smegma", "sodomiz", "spunk",
  "strapon", "stripclub", "taint", "testicl", "tits", "titties", "tranny",
  "tubgirl", "turd", "upskirt", "urethra", "vagina", "vibrator", "voyeur",
  "vulva", "wetback", "wop", "xxx",
]);

const LEET_MAP: Record<string, string> = {
  "@": "a",
  "4": "a",
  "8": "b",
  "3": "e",
  "1": "i",
  "!": "i",
  "0": "o",
  "5": "s",
  "$": "s",
  "7": "t",
  "+": "t",
};

function normalizeLeet(input: string): string {
  let result = "";
  for (const ch of input) {
    result += LEET_MAP[ch] ?? ch;
  }
  return result;
}

function normalize(input: string): string {
  return normalizeLeet(input.toLowerCase().replace(/[^a-z0-9@$!+]/g, ""));
}

export interface NicknameCheck {
  clean: boolean;
  reason?: string;
}

export function isCleanNickname(name: string): NicknameCheck {
  const normalized = normalize(name);

  for (const word of BLOCKLIST) {
    if (EXACT_ONLY.has(word)) {
      if (normalized === word) {
        return { clean: false, reason: "Nickname contains inappropriate language" };
      }
    } else if (normalized.includes(word)) {
      return { clean: false, reason: "Nickname contains inappropriate language" };
    }
  }

  return { clean: true };
}
