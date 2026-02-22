/**
 * Resume review engine.
 * Builds analysis prompts against a knowledge base, manages suggestions,
 * and runs an interactive terminal loop for approving/editing changes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "fs";
import { join } from "path";
import * as tracker from "./tracker";
import * as research from "./research";
import { formatDescriptionForPrompt } from "./format";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");
const KNOWLEDGE_BASE_PATH = join(DATA_DIR, "references", "resume-knowledge-base.md");
const REVIEW_OUTPUT_DIR = join(DATA_DIR, "output", "review");
const BACKUP_PATH = join(DATA_DIR, "profile.backup.json");

// --- Types ---

export interface Suggestion {
  id: number;
  section: string;
  type: "rewrite" | "restructure" | "add" | "remove";
  current: string;
  suggested: string;
  reason: string;
  principle: string;
}

export interface SuggestionsFile {
  generatedAt: string;
  jobId: string | null;
  suggestions: Suggestion[];
}

// --- Helpers ---

function loadProfile(): any | null {
  if (!existsSync(PROFILE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function loadKnowledgeBase(): string | null {
  if (!existsSync(KNOWLEDGE_BASE_PATH)) return null;
  return readFileSync(KNOWLEDGE_BASE_PATH, "utf-8");
}

function formatExperience(exp: any[]): string {
  if (!exp || exp.length === 0) return "No experience listed.";
  return exp
    .map(
      (e) =>
        `**${e.title}** @ ${e.company} (${e.dates})\n${(e.bullets || []).map((b: string) => `- ${b}`).join("\n")}${e.technologies ? `\nTech: ${e.technologies.join(", ")}` : ""}`
    )
    .join("\n\n");
}

function formatSkills(skills: any[]): string {
  if (!skills || skills.length === 0) return "No skills listed.";
  return skills.map((s) => `**${s.category}:** ${s.items.join(", ")}`).join("\n");
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

// --- Exports ---

/**
 * Directory for suggestions output.
 */
export function suggestionsDir(jobId?: string): string {
  const dir = jobId ? join(DATA_DIR, "output", jobId) : REVIEW_OUTPUT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Check if suggestions file exists.
 */
export function hasSuggestions(jobId?: string): boolean {
  return existsSync(join(suggestionsDir(jobId), "suggestions.json"));
}

/**
 * Load suggestions from JSON file.
 */
export function loadSuggestions(jobId?: string): SuggestionsFile | null {
  const path = join(suggestionsDir(jobId), "suggestions.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Format a plain-text summary of all suggestions.
 */
export function formatSuggestionsList(jobId?: string): string {
  const data = loadSuggestions(jobId);
  if (!data || data.suggestions.length === 0) {
    return "No suggestions found. Run `review" + (jobId ? ` ${jobId}` : "") + "` first to generate them.";
  }

  const suggestions = data.suggestions;
  const total = suggestions.length;
  const lines: string[] = [];

  // Header
  let context = "general";
  if (data.jobId) {
    const job = tracker.get(data.jobId);
    context = job ? `${job.title} @ ${job.company}` : data.jobId;
  }
  lines.push(`Resume Review — ${total} suggestion${total === 1 ? "" : "s"} (${context})`);
  lines.push("");

  // Each suggestion
  for (const s of suggestions) {
    const idStr = `#${s.id}`.padStart(3);
    lines.push(` ${idStr}  ${s.section.padEnd(28)} ${s.type.padEnd(12)} [${s.principle}]`);
    lines.push(`      Current:  ${truncate(s.current, 55)}`);
    if (s.type !== "remove") {
      lines.push(`      Suggest:  ${truncate(s.suggested, 55)}`);
    }
    lines.push("");
  }

  // Summary by type
  const typeCounts: Record<string, number> = {};
  for (const s of suggestions) {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  }
  const parts = Object.entries(typeCounts).map(
    ([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`
  );
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}

/**
 * Build the analysis prompt that tells Claude to evaluate the resume
 * against the knowledge base and write suggestions.json.
 */
export function buildAnalysisPrompt(jobId?: string): string {
  const profile = loadProfile();
  if (!profile) {
    throw new Error(
      "No profile found. Run `profile init` to create one, then fill in your details."
    );
  }

  const kb = loadKnowledgeBase();
  if (!kb) {
    throw new Error(
      "Knowledge base not found at data/references/resume-knowledge-base.md.\n" +
        "Pull transcripts first using the youtube-transcript MCP server."
    );
  }

  // Job-specific context
  let jobSection = "";
  if (jobId) {
    const job = tracker.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found. Run \`jobs\` to see tracked jobs.`);

    const researchBrief = research.readOutput(jobId);
    const researchSection = researchBrief
      ? `### Company Research Brief\n${researchBrief.slice(0, 2000)}`
      : "";

    const descSnippet = formatDescriptionForPrompt(job.description, 2500);

    jobSection = `
### Target Job

**${job.title}** at **${job.company}**
${job.location}${job.isRemote ? " (remote)" : ""}

### Job Description
${descSnippet}

${researchSection}

When evaluating the resume, also consider how well it targets this specific role.
Suggest changes that would better align the resume with this job description.
`;
  }

  const outDir = suggestionsDir(jobId);

  return `## Resume Review Task

Evaluate the following resume against the knowledge base principles below.
Generate specific, actionable suggestions for improvement.

### Knowledge Base

${kb}

### Candidate Profile (Resume)

**Name:** ${profile.name}
**Email:** ${profile.email || "N/A"}
**Location:** ${profile.location || "N/A"}
**URLs:** ${(profile.urls || []).join(", ") || "N/A"}
**Summary:** ${profile.summary || "N/A"}
**Target Roles:** ${(profile.targetRoles || []).join(", ") || "N/A"}

### Experience
${formatExperience(profile.experience)}

### Education
${(profile.education || []).map((e: any) => `- ${e.degree} — ${e.school} (${e.year})`).join("\n") || "N/A"}

### Skills
${formatSkills(profile.skills)}
${jobSection}

### Instructions

Analyze each section of the resume against the knowledge base principles. Generate structured suggestions.

For each suggestion, provide:
- **section**: The profile.json path (e.g., "summary", "experience[0].bullets[1]", "skills")
- **type**: "rewrite" (change text), "restructure" (reorganize), "add" (new content), or "remove" (delete)
- **current**: The current text/content being changed
- **suggested**: The improved version
- **reason**: Why this change improves the resume, citing a specific knowledge base principle
- **principle**: The short name of the principle (e.g., "6-second scan rule", "XYZ formula")

Focus on:
1. Summary/headline — Does it pass the 6-second scan?
2. Experience bullets — Do they use the XYZ formula? Are outcomes quantified?
3. Skills section — Should skills be embedded in experience instead?
4. Overall formatting — Is anything too cluttered or generic?
5. Missing elements — Are there gaps the knowledge base says to address?
${jobId ? "6. Job alignment — Does the resume target this specific role effectively?" : ""}

Write the output as JSON to: \`${outDir}/suggestions.json\`

Use this exact format:
\`\`\`json
{
  "generatedAt": "${new Date().toISOString().split(".")[0]}Z",
  "jobId": ${jobId ? `"${jobId}"` : "null"},
  "suggestions": [
    {
      "id": 1,
      "section": "summary",
      "type": "rewrite",
      "current": "...",
      "suggested": "...",
      "reason": "...",
      "principle": "..."
    }
  ]
}
\`\`\`

Aim for 5-10 high-impact suggestions. Prioritize changes that would make the biggest difference.

After writing the file, confirm by running:
\`\`\`bash
cd ~/.claude/skills/job-hunter && bun run job-hunt.ts review apply${jobId ? ` ${jobId}` : ""}
\`\`\``;
}

/**
 * Resolve a section path like "experience[0].bullets[1]" to get/set values in profile.
 */
function resolvePath(obj: any, path: string): { parent: any; key: string | number } | null {
  const parts: (string | number)[] = [];
  const regex = /([^[.\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = regex.exec(path)) !== null) {
    if (match[1] !== undefined) parts.push(match[1]);
    else if (match[2] !== undefined) parts.push(parseInt(match[2]));
  }

  if (parts.length === 0) return null;

  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null) return null;
    current = current[parts[i]];
  }

  if (current == null) return null;
  return { parent: current, key: parts[parts.length - 1] };
}

/**
 * Apply a single suggestion to the profile object.
 * Returns the modified profile.
 */
export function applySuggestion(suggestion: Suggestion, profile: any): any {
  const section = suggestion.section;

  // Handle bullet rewrites: experience[0].bullets[1]
  const resolved = resolvePath(profile, section);
  if (resolved) {
    const { parent, key } = resolved;
    if (suggestion.type === "remove") {
      if (Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 1);
      } else {
        delete parent[key];
      }
    } else {
      parent[key] = suggestion.suggested;
    }
  }

  return profile;
}

/**
 * Batch-apply suggestions by ID (non-interactive).
 * Creates a backup, applies matching suggestions, logs to changelog.
 */
export function applyByIds(
  ids: number[] | "all",
  jobId?: string
): { applied: number[]; skipped: number[]; backupCreated: boolean } {
  const data = loadSuggestions(jobId);
  if (!data || data.suggestions.length === 0) {
    return { applied: [], skipped: [], backupCreated: false };
  }

  const profile = loadProfile();
  if (!profile) {
    throw new Error("No profile found. Run `profile init` to create one.");
  }

  const toApply: Suggestion[] = [];
  const skipped: number[] = [];

  for (const s of data.suggestions) {
    if (ids === "all" || ids.includes(s.id)) {
      toApply.push(s);
    } else {
      skipped.push(s.id);
    }
  }

  let backupCreated = false;
  if (toApply.length > 0 && existsSync(PROFILE_PATH)) {
    copyFileSync(PROFILE_PATH, BACKUP_PATH);
    backupCreated = true;
  }

  for (const s of toApply) {
    applySuggestion(s, profile);
    logChange(s, "approved", jobId);
  }

  if (toApply.length > 0) {
    writeProfileAtomic(profile);
  }

  return {
    applied: toApply.map((s) => s.id),
    skipped,
    backupCreated,
  };
}

/**
 * Read a line from stdin (Bun-compatible).
 */
async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const buf: number[] = [];
  const stdin = process.stdin;

  // Put stdin into raw-ish mode for reading
  if (typeof (stdin as any).setRawMode === "function") {
    (stdin as any).setRawMode(false);
  }

  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      if (str.includes("\n")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        const line = Buffer.from(buf).toString() + str.split("\n")[0];
        resolve(line.trim());
      } else {
        for (const b of chunk) buf.push(b);
      }
    };

    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Read a single character from stdin.
 */
async function readChar(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (typeof (stdin as any).setRawMode === "function") {
      (stdin as any).setRawMode(true);
    }
    stdin.resume();

    const onData = (chunk: Buffer) => {
      stdin.removeListener("data", onData);
      if (typeof (stdin as any).setRawMode === "function") {
        (stdin as any).setRawMode(false);
      }
      stdin.pause();
      const ch = chunk.toString()[0];
      process.stdout.write(ch + "\n");
      resolve(ch);
    };

    stdin.on("data", onData);
  });
}

/**
 * Log a change to the changelog.
 */
function logChange(suggestion: Suggestion, action: string, jobId?: string) {
  const dir = suggestionsDir(jobId);
  const logPath = join(dir, "changelog.md");
  const timestamp = new Date().toISOString();
  const entry = `- [${timestamp}] **${action}** — ${suggestion.section} (${suggestion.principle}): ${suggestion.type}\n`;

  let existing = "";
  if (existsSync(logPath)) {
    existing = readFileSync(logPath, "utf-8");
  } else {
    existing = "# Review Changelog\n\n";
  }
  writeFileSync(logPath, existing + entry);
}

/**
 * Run the interactive review loop.
 * Presents each suggestion and lets the user approve, skip, edit, or add their own.
 */
export async function runInteractiveReview(jobId?: string): Promise<void> {
  const data = loadSuggestions(jobId);
  if (!data || data.suggestions.length === 0) {
    console.log("No suggestions found. Run `review" + (jobId ? ` ${jobId}` : "") + "` first to generate them.");
    return;
  }

  const suggestions = data.suggestions;
  const total = suggestions.length;

  // Header
  console.log("");
  console.log("+" + "-".repeat(54) + "+");
  console.log("|  Resume Review — " + total + " suggestion" + (total === 1 ? "" : "s") + " ".repeat(Math.max(0, 35 - String(total).length)) + "|");
  if (data.jobId) {
    const job = tracker.get(data.jobId);
    const label = job ? `${job.title} @ ${job.company}` : data.jobId;
    const trimmed = label.length > 48 ? label.slice(0, 45) + "..." : label;
    console.log("|  " + trimmed + " ".repeat(Math.max(0, 52 - trimmed.length)) + "|");
  }
  const hint = "Interactive — press a/s/e/m/q for each";
  console.log("|  " + hint + " ".repeat(Math.max(0, 52 - hint.length)) + "|");
  console.log("+" + "-".repeat(54) + "+");
  console.log("");

  // Back up profile before first change
  let backupCreated = false;
  let changesApplied = 0;
  const actions: { id: number; section: string; action: string }[] = [];

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const sectionLabel = s.section.toUpperCase().replace(/\[(\d+)\]/g, " #$1").replace(/\./g, " > ");

    console.log(`[${i + 1}/${total}] ${sectionLabel} — ${s.type}`);
    console.log("");

    // Current
    console.log("  Current:");
    for (const line of s.current.split("\n")) {
      console.log("  > " + line);
    }
    console.log("");

    // Suggested
    if (s.type !== "remove") {
      console.log("  Suggested:");
      for (const line of s.suggested.split("\n")) {
        console.log("  > " + line);
      }
      console.log("");
    }

    // Reason
    const wrappedReason = wordWrap(s.reason, 60);
    console.log("  Why: " + wrappedReason[0]);
    for (let r = 1; r < wrappedReason.length; r++) {
      console.log("  " + wrappedReason[r]);
    }
    console.log("  (" + s.principle + ")");
    console.log("");

    // Action prompt
    const ch = await readChar("  [a]pprove  [s]kip  [e]dit  [m]anual add  [q]uit > ");
    console.log("");

    if (ch === "q") {
      break;
    }

    if (ch === "a") {
      // Create backup before first change
      if (!backupCreated) {
        if (existsSync(PROFILE_PATH)) {
          copyFileSync(PROFILE_PATH, BACKUP_PATH);
          backupCreated = true;
          console.log("  Backup saved to data/profile.backup.json");
        }
      }

      // Apply
      const profile = loadProfile();
      if (profile) {
        applySuggestion(s, profile);
        writeProfileAtomic(profile);
        logChange(s, "approved", jobId);
        changesApplied++;
        actions.push({ id: s.id, section: s.section, action: "approved" });
        console.log("  Applied.");
      } else {
        console.log("  Error: could not load profile.");
      }
    } else if (ch === "e") {
      // Edit: let user modify the suggested text
      console.log("  Enter your version (press Enter when done):");
      const edited = await readLine("  > ");
      if (edited) {
        if (!backupCreated) {
          if (existsSync(PROFILE_PATH)) {
            copyFileSync(PROFILE_PATH, BACKUP_PATH);
            backupCreated = true;
            console.log("  Backup saved to data/profile.backup.json");
          }
        }

        const profile = loadProfile();
        if (profile) {
          const editedSuggestion = { ...s, suggested: edited };
          applySuggestion(editedSuggestion, profile);
          writeProfileAtomic(profile);
          logChange(editedSuggestion, "edited", jobId);
          changesApplied++;
          actions.push({ id: s.id, section: s.section, action: "edited" });
          console.log("  Applied (edited).");
        }
      } else {
        actions.push({ id: s.id, section: s.section, action: "skipped" });
        console.log("  Skipped (empty input).");
      }
    } else if (ch === "m") {
      // Manual add: user writes their own improvement
      console.log("  Which section? (e.g., summary, experience[0].bullets[2]):");
      const section = await readLine("  section > ");
      console.log("  Enter your text:");
      const text = await readLine("  text > ");
      if (section && text) {
        if (!backupCreated) {
          if (existsSync(PROFILE_PATH)) {
            copyFileSync(PROFILE_PATH, BACKUP_PATH);
            backupCreated = true;
            console.log("  Backup saved to data/profile.backup.json");
          }
        }

        const profile = loadProfile();
        if (profile) {
          const manualSuggestion: Suggestion = {
            id: 9000 + i,
            section,
            type: "rewrite",
            current: "(manual)",
            suggested: text,
            reason: "Manual user addition",
            principle: "user",
          };
          applySuggestion(manualSuggestion, profile);
          writeProfileAtomic(profile);
          logChange(manualSuggestion, "manual", jobId);
          changesApplied++;
          actions.push({ id: manualSuggestion.id, section, action: "manual" });
          console.log("  Applied (manual).");
        }
      } else {
        actions.push({ id: s.id, section: s.section, action: "skipped" });
        console.log("  Skipped (empty input).");
      }
    } else {
      // Skip (or any other key)
      logChange(s, "skipped", jobId);
      actions.push({ id: s.id, section: s.section, action: "skipped" });
      console.log("  Skipped.");
    }

    console.log("");
  }

  // Summary of all actions
  console.log("Done! " + changesApplied + " change(s) applied out of " + total + " suggestions.");
  const approved = actions.filter((a) => a.action === "approved");
  const edited = actions.filter((a) => a.action === "edited");
  const manual = actions.filter((a) => a.action === "manual");
  const skippedActions = actions.filter((a) => a.action === "skipped");
  if (approved.length > 0) {
    console.log("  Approved: " + approved.map((a) => `#${a.id} ${a.section}`).join(", "));
  }
  if (edited.length > 0) {
    console.log("  Edited:   " + edited.map((a) => `#${a.id} ${a.section}`).join(", "));
  }
  if (manual.length > 0) {
    console.log("  Manual:   " + manual.map((a) => `#${a.id} ${a.section}`).join(", "));
  }
  if (skippedActions.length > 0) {
    console.log("  Skipped:  " + skippedActions.map((a) => `#${a.id}`).join(", "));
  }
  if (changesApplied > 0) {
    console.log("");
    console.log("Re-run the review to generate fresh suggestions:");
    console.log(`  bun run job-hunt.ts review${jobId ? ` ${jobId}` : ""}`);
  }
}

/**
 * Write profile atomically (write to temp, then rename).
 */
function writeProfileAtomic(profile: any): void {
  const tmp = PROFILE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(profile, null, 2) + "\n");
  renameSync(tmp, PROFILE_PATH);
}

/**
 * Word-wrap text to a given width.
 */
function wordWrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}
