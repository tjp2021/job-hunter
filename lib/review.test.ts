import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { applySuggestion, formatSuggestionsList, applyByIds, loadSuggestions } from "./review";
import type { Suggestion, SuggestionsFile } from "./review";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");
const BACKUP_PATH = join(DATA_DIR, "profile.backup.json");
const TEST_DIR = join(DATA_DIR, "output", "__test__");
const FAKE_DIR = join(DATA_DIR, "output", "__fake__");
const SKILL_DIR = join(import.meta.dir, "..");

// -- Shared fixtures --

const TEST_PROFILE = {
  name: "Test User",
  email: "test@example.com",
  summary: "Original summary text",
  experience: [
    {
      company: "Company A",
      title: "Engineer",
      dates: "2020 - 2024",
      bullets: ["First bullet", "Old bullet", "Third bullet"],
    },
    {
      company: "Company B",
      title: "Junior Dev",
      dates: "2018 - 2020",
      bullets: ["Remove me", "Keep me"],
    },
  ],
  skills: [
    { category: "Languages", items: ["Go", "Python", "TypeScript", "SQL"] },
  ],
};

const TEST_SUGGESTIONS: SuggestionsFile = {
  generatedAt: "2026-01-01T00:00:00Z",
  jobId: "__test__",
  suggestions: [
    {
      id: 1,
      section: "summary",
      type: "rewrite",
      current:
        "Senior software engineer with 6 years of experience building scalable backend systems and data pipelines",
      suggested:
        "Backend-focused engineer who reduced deploy times 80% and built pipelines processing 2M events/day",
      reason: "More specific and measurable",
      principle: "6-second scan",
    },
    {
      id: 2,
      section: "experience[0].bullets[1]",
      type: "rewrite",
      current: "Old bullet",
      suggested: "New XYZ bullet with metrics",
      reason: "Use XYZ formula",
      principle: "XYZ formula",
    },
    {
      id: 3,
      section: "experience[1].bullets[0]",
      type: "remove",
      current: "Remove me",
      suggested: "",
      reason: "Weak bullet without impact",
      principle: "relevance",
    },
    {
      id: 4,
      section: "skills[0].items[2]",
      type: "rewrite",
      current: "TypeScript",
      suggested: "TypeScript/JavaScript",
      reason: "More complete listing",
      principle: "keyword match",
    },
  ],
};

// -- Helpers --

function writeSuggestionsFixture() {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "suggestions.json"), JSON.stringify(TEST_SUGGESTIONS));
}

function cleanTestDirs() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(FAKE_DIR, { recursive: true, force: true });
}

function makeSuggestion(
  overrides: Partial<Suggestion> & Pick<Suggestion, "section" | "type">,
): Suggestion {
  return { id: 99, current: "", suggested: "", reason: "test", principle: "test", ...overrides };
}

async function runCLI(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", join(SKILL_DIR, "job-hunt.ts"), ...args], {
    cwd: SKILL_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// -- Tests --

describe("applySuggestion", () => {
  test("rewrites top-level field", () => {
    const profile = structuredClone(TEST_PROFILE);
    const result = applySuggestion(
      makeSuggestion({ section: "summary", type: "rewrite", suggested: "New summary" }),
      profile,
    );
    expect(result.summary).toBe("New summary");
  });

  test("rewrites nested array element", () => {
    const profile = structuredClone(TEST_PROFILE);
    const result = applySuggestion(
      makeSuggestion({
        section: "experience[0].bullets[1]",
        type: "rewrite",
        suggested: "Improved bullet",
      }),
      profile,
    );
    expect(result.experience[0].bullets[1]).toBe("Improved bullet");
    expect(result.experience[0].bullets[0]).toBe("First bullet");
    expect(result.experience[0].bullets[2]).toBe("Third bullet");
  });

  test("removes from array (splices, length decreases)", () => {
    const profile = structuredClone(TEST_PROFILE);
    const before = profile.experience[1].bullets.length;
    const result = applySuggestion(
      makeSuggestion({ section: "experience[1].bullets[0]", type: "remove" }),
      profile,
    );
    expect(result.experience[1].bullets.length).toBe(before - 1);
    expect(result.experience[1].bullets[0]).toBe("Keep me");
  });

  test("removes top-level field (deletes key)", () => {
    const profile = structuredClone(TEST_PROFILE);
    const result = applySuggestion(
      makeSuggestion({ section: "summary", type: "remove" }),
      profile,
    );
    expect(result.summary).toBeUndefined();
    expect("summary" in result).toBe(false);
  });

  test("nonexistent path returns profile unchanged", () => {
    const profile = structuredClone(TEST_PROFILE);
    const before = JSON.stringify(profile);
    const result = applySuggestion(
      makeSuggestion({ section: "nonexistent[99].deep.path", type: "rewrite", suggested: "x" }),
      profile,
    );
    expect(JSON.stringify(result)).toBe(before);
  });

  test("rewrites deep nested path (skills[0].items[2])", () => {
    const profile = structuredClone(TEST_PROFILE);
    const result = applySuggestion(
      makeSuggestion({ section: "skills[0].items[2]", type: "rewrite", suggested: "TypeScript/JS" }),
      profile,
    );
    expect(result.skills[0].items[2]).toBe("TypeScript/JS");
    expect(result.skills[0].items[0]).toBe("Go");
    expect(result.skills[0].items[1]).toBe("Python");
  });
});

describe("formatSuggestionsList", () => {
  beforeAll(() => writeSuggestionsFixture());
  afterAll(() => cleanTestDirs());

  test("header shows count and jobId context", () => {
    const output = formatSuggestionsList("__test__");
    expect(output).toContain("4 suggestions");
    expect(output).toContain("__test__");
  });

  test("each suggestion shows id, section, type, principle", () => {
    const output = formatSuggestionsList("__test__");
    expect(output).toContain("#1");
    expect(output).toContain("summary");
    expect(output).toContain("rewrite");
    expect(output).toContain("[6-second scan]");
    expect(output).toContain("#3");
    expect(output).toContain("remove");
    expect(output).toContain("[relevance]");
  });

  test("truncates text > 55 chars with ...", () => {
    const output = formatSuggestionsList("__test__");
    expect(output).toContain("...");
    // Full 103-char current text should NOT appear
    expect(output).not.toContain("scalable backend systems and data pipelines");
  });

  test("summary line counts by type", () => {
    const output = formatSuggestionsList("__test__");
    expect(output).toContain("3 rewrites");
    expect(output).toContain("1 remove");
  });

  test('returns "No suggestions found" for nonexistent jobId', () => {
    const output = formatSuggestionsList("__fake__");
    expect(output).toContain("No suggestions found");
  });
});

describe("applyByIds", () => {
  let profileSnapshot: string | null = null;
  let backupSnapshot: string | null = null;

  beforeAll(() => {
    profileSnapshot = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf-8") : null;
    backupSnapshot = existsSync(BACKUP_PATH) ? readFileSync(BACKUP_PATH, "utf-8") : null;
    writeSuggestionsFixture();
  });

  afterAll(() => {
    if (profileSnapshot !== null) writeFileSync(PROFILE_PATH, profileSnapshot);
    if (backupSnapshot !== null) {
      writeFileSync(BACKUP_PATH, backupSnapshot);
    } else if (existsSync(BACKUP_PATH)) {
      rmSync(BACKUP_PATH);
    }
    cleanTestDirs();
  });

  beforeEach(() => {
    writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE, null, 2));
    if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
    const cl = join(TEST_DIR, "changelog.md");
    if (existsSync(cl)) rmSync(cl);
  });

  test("applies specific IDs, skips others", () => {
    const result = applyByIds([1, 3], "__test__");
    expect(result.applied).toEqual([1, 3]);
    expect(result.skipped).toEqual([2, 4]);
  });

  test('"all" applies everything', () => {
    const result = applyByIds("all", "__test__");
    expect(result.applied).toEqual([1, 2, 3, 4]);
    expect(result.skipped).toEqual([]);
  });

  test("persists changes to profile.json on disk", () => {
    applyByIds([1], "__test__");
    const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
    expect(profile.summary).toBe(TEST_SUGGESTIONS.suggestions[0].suggested);
  });

  test("creates backup when suggestions match", () => {
    expect(existsSync(BACKUP_PATH)).toBe(false);
    const result = applyByIds([1], "__test__");
    expect(result.backupCreated).toBe(true);
    expect(existsSync(BACKUP_PATH)).toBe(true);
  });

  test("no backup when nothing matches (id 999)", () => {
    const result = applyByIds([999], "__test__");
    expect(result.backupCreated).toBe(false);
    expect(result.applied).toEqual([]);
    expect(existsSync(BACKUP_PATH)).toBe(false);
  });

  test("writes changelog entries", () => {
    applyByIds([1, 2], "__test__");
    const changelog = readFileSync(join(TEST_DIR, "changelog.md"), "utf-8");
    expect(changelog).toContain("approved");
    expect(changelog).toContain("summary");
    expect(changelog).toContain("experience[0].bullets[1]");
  });
});

describe("review CLI", () => {
  let profileSnapshot: string | null = null;
  let backupSnapshot: string | null = null;

  beforeAll(() => {
    profileSnapshot = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf-8") : null;
    backupSnapshot = existsSync(BACKUP_PATH) ? readFileSync(BACKUP_PATH, "utf-8") : null;
    writeSuggestionsFixture();
  });

  afterAll(() => {
    if (profileSnapshot !== null) writeFileSync(PROFILE_PATH, profileSnapshot);
    if (backupSnapshot !== null) {
      writeFileSync(BACKUP_PATH, backupSnapshot);
    } else if (existsSync(BACKUP_PATH)) {
      rmSync(BACKUP_PATH);
    }
    cleanTestDirs();
  });

  beforeEach(() => {
    writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE, null, 2));
    if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
  });

  test("review list __test__ — formatted text, exit 0", async () => {
    const { stdout, exitCode } = await runCLI("review", "list", "__test__");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("4 suggestions");
    expect(stdout).toContain("__test__");
  });

  test("review list __test__ --json — valid JSON with 4 suggestions", async () => {
    const { stdout, exitCode } = await runCLI("review", "list", "__test__", "--json");
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.suggestions).toHaveLength(4);
  });

  test("review accept 1,2 __test__ — shows Applied and Skipped", async () => {
    const { stdout, exitCode } = await runCLI("review", "accept", "1,2", "__test__");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Applied #1");
    expect(stdout).toContain("Applied #2");
    expect(stdout).toContain("Skipped");
  });

  test("review accept all __test__ — 4 applied, 0 skipped", async () => {
    const { stdout, exitCode } = await runCLI("review", "accept", "all", "__test__");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("4 applied, 0 skipped");
  });

  test("review list __fake__ — No suggestions found", async () => {
    const { stdout, exitCode } = await runCLI("review", "list", "__fake__");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No suggestions found");
  });
});
