/**
 * Resume text extraction and heuristic parsing.
 * Converts uploaded files (PDF/text) into partial Profile objects.
 */

interface Experience {
  company: string;
  title: string;
  dates: string;
  bullets: string[];
  technologies: string[];
}

interface Education {
  school: string;
  degree: string;
  year: string;
}

interface SkillCategory {
  category: string;
  items: string[];
}

export interface PartialProfile {
  name?: string;
  email?: string;
  location?: string;
  phone?: string;
  urls?: string[];
  summary?: string;
  targetRoles?: string[];
  experience?: Experience[];
  education?: Education[];
  skills?: SkillCategory[];
}

/**
 * Extract text from an uploaded file buffer.
 * PDF files are parsed with pdf-parse; everything else is decoded as UTF-8.
 */
export async function extractText(buf: Buffer, filename: string): Promise<string> {
  if (filename.toLowerCase().endsWith(".pdf")) {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buf);
    return result.text;
  }
  return buf.toString("utf-8");
}

// Section header patterns
const SECTION_PATTERNS: Record<string, RegExp> = {
  experience: /^(?:experience|work\s*experience|employment|professional\s*experience|work\s*history)\s*$/i,
  education: /^(?:education|academic|academics|qualifications)\s*$/i,
  skills: /^(?:skills|technical\s*skills|core\s*competencies|technologies|tech\s*stack)\s*$/i,
  summary: /^(?:summary|objective|professional\s*summary|about|about\s*me|profile)\s*$/i,
};

/**
 * Heuristic parser: extracts what it can from raw resume text.
 * Returns a best-effort partial profile — fields it can't parse are omitted.
 */
export function parseResumeText(text: string): PartialProfile {
  if (!text || !text.trim()) return {};

  const lines = text.split(/\r?\n/);
  const profile: PartialProfile = {};

  // Extract email
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) profile.email = emailMatch[0];

  // Extract phone
  const phoneMatch = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  if (phoneMatch) profile.phone = phoneMatch[0];

  // Extract URLs
  const urlMatches = text.match(/https?:\/\/[^\s,)]+/g);
  if (urlMatches) profile.urls = [...new Set(urlMatches)];

  // Extract name: first non-empty line that isn't a section header, email, or URL
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.match(/[\w.-]+@[\w.-]+\.\w+/)) continue;
    if (trimmed.match(/^https?:\/\//)) continue;
    if (trimmed.match(/^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/)) continue;
    // Skip if it matches a section header
    let isHeader = false;
    for (const pat of Object.values(SECTION_PATTERNS)) {
      if (pat.test(trimmed)) { isHeader = true; break; }
    }
    if (isHeader) continue;
    profile.name = trimmed;
    break;
  }

  // Split into sections
  const sections: Record<string, string[]> = {};
  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let matchedSection: string | null = null;
    for (const [name, pat] of Object.entries(SECTION_PATTERNS)) {
      if (pat.test(trimmed)) {
        matchedSection = name;
        break;
      }
    }

    if (matchedSection) {
      currentSection = matchedSection;
      if (!sections[currentSection]) sections[currentSection] = [];
    } else if (currentSection) {
      sections[currentSection].push(trimmed);
    }
  }

  // Parse summary
  if (sections.summary) {
    profile.summary = sections.summary.join(" ");
  }

  // Parse experience
  if (sections.experience) {
    profile.experience = parseExperience(sections.experience);
  }

  // Parse education
  if (sections.education) {
    profile.education = parseEducation(sections.education);
  }

  // Parse skills
  if (sections.skills) {
    profile.skills = parseSkills(sections.skills);
  }

  return profile;
}

function parseExperience(lines: string[]): Experience[] {
  const experiences: Experience[] = [];
  let current: Experience | null = null;

  // Pattern: "Title at Company (dates)" or "Title, Company (dates)" or "Title - Company | dates"
  const titlePattern = /^(.+?)(?:\s+at\s+|\s*,\s*|\s+[-–—]\s+)(.+?)(?:\s*[|(]\s*(.+?)\s*[|)]?\s*)?$/;
  // Standalone date line pattern
  const datePattern = /^(?:(\w+\.?\s+\d{4}|\d{4})\s*[-–—]\s*(?:(\w+\.?\s+\d{4}|\d{4})|[Pp]resent|[Cc]urrent))$/;

  for (const line of lines) {
    const titleMatch = line.match(titlePattern);
    if (titleMatch && !line.startsWith("-") && !line.startsWith("•") && !line.startsWith("*")) {
      if (current) experiences.push(current);
      current = {
        title: titleMatch[1].trim(),
        company: titleMatch[2].trim(),
        dates: titleMatch[3]?.trim() || "",
        bullets: [],
        technologies: [],
      };
      continue;
    }

    // Check for standalone date line attached to current experience
    if (current && !current.dates) {
      const dateMatch = line.match(datePattern);
      if (dateMatch) {
        current.dates = line;
        continue;
      }
    }

    // Bullet lines
    if (current && /^[-•*]\s+/.test(line)) {
      current.bullets.push(line.replace(/^[-•*]\s+/, ""));
    }
  }

  if (current) experiences.push(current);
  return experiences;
}

function parseEducation(lines: string[]): Education[] {
  const education: Education[] = [];

  // Pattern: "Degree — School (year)" or "Degree, School, year" or "School - Degree (year)"
  const eduPattern = /^(.+?)(?:\s*[-–—,]\s*)(.+?)(?:\s*[,(]\s*(\d{4})\s*\)?\s*)?$/;

  for (const line of lines) {
    if (line.startsWith("-") || line.startsWith("•")) continue;
    const match = line.match(eduPattern);
    if (match) {
      education.push({
        degree: match[1].trim(),
        school: match[2].trim(),
        year: match[3]?.trim() || "",
      });
    }
  }

  return education;
}

function parseSkills(lines: string[]): SkillCategory[] {
  const skills: SkillCategory[] = [];

  for (const line of lines) {
    // "Category: item1, item2, item3" pattern
    const catMatch = line.match(/^(.+?):\s*(.+)$/);
    if (catMatch) {
      const items = catMatch[2].split(/[,;•|]/).map(s => s.trim()).filter(Boolean);
      skills.push({ category: catMatch[1].trim(), items });
    } else {
      // Flat list of skills — split by commas or bullets
      const items = line.split(/[,;•|]/).map(s => s.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
      if (items.length > 1) {
        skills.push({ category: "General", items });
      } else if (items.length === 1 && skills.length > 0) {
        // Append to last category
        skills[skills.length - 1].items.push(items[0]);
      } else if (items.length === 1) {
        skills.push({ category: "General", items });
      }
    }
  }

  return skills;
}
