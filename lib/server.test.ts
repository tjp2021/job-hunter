import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { handleRequest, startServer } from "./server";
import type { SuggestionsFile } from "./review";
import { parseResumeText, extractText } from "./parse-resume";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");
const BACKUP_PATH = join(DATA_DIR, "profile.backup.json");
const OUTPUT_DIR = join(DATA_DIR, "output");
const TEST_DIR = join(OUTPUT_DIR, "__test__");
const FAKE_DIR = join(OUTPUT_DIR, "__fake__");
const SRVTEST_DIR = join(OUTPUT_DIR, "srvtest");

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
      current: "Original summary text",
      suggested: "Backend engineer who reduced deploy times 80%",
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

// Duplicate fixture under non-__ dir for /api/jobs tests
const SRVTEST_SUGGESTIONS: SuggestionsFile = {
  ...TEST_SUGGESTIONS,
  jobId: "srvtest",
};

function writeSuggestionsFixture() {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "suggestions.json"), JSON.stringify(TEST_SUGGESTIONS));
  mkdirSync(SRVTEST_DIR, { recursive: true });
  writeFileSync(join(SRVTEST_DIR, "suggestions.json"), JSON.stringify(SRVTEST_SUGGESTIONS));
}

function cleanTestDirs() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(FAKE_DIR, { recursive: true, force: true });
  rmSync(SRVTEST_DIR, { recursive: true, force: true });
}

function req(path: string, init?: RequestInit): Request {
  return new Request("http://localhost" + path, init);
}

// ---- Unit tests ----

describe("route handler", () => {
  let profileSnapshot: string | null = null;
  let backupSnapshot: string | null = null;

  beforeAll(() => {
    profileSnapshot = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf-8") : null;
    backupSnapshot = existsSync(BACKUP_PATH) ? readFileSync(BACKUP_PATH, "utf-8") : null;
    writeSuggestionsFixture();
  });

  afterAll(() => {
    if (profileSnapshot !== null) writeFileSync(PROFILE_PATH, profileSnapshot);
    else if (existsSync(PROFILE_PATH)) rmSync(PROFILE_PATH);
    if (backupSnapshot !== null) writeFileSync(BACKUP_PATH, backupSnapshot);
    else if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
    cleanTestDirs();
  });

  beforeEach(() => {
    writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE, null, 2));
    if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
  });

  // --- GET /api/jobs ---
  test("GET /api/jobs returns entries with suggestions", async () => {
    const res = await handleRequest(req("/api/jobs"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toBeInstanceOf(Array);
    const ids = data.jobs.map((j: any) => j.id);
    expect(ids).toContain("srvtest");
  });

  test("GET /api/jobs excludes __test__ dirs", async () => {
    const res = await handleRequest(req("/api/jobs"));
    const data = await res.json();
    const ids = data.jobs.map((j: any) => j.id);
    expect(ids).not.toContain("__test__");
  });

  test("GET /api/jobs returns empty when no suggestions exist", async () => {
    // Clean srvtest to verify behavior without it
    rmSync(join(SRVTEST_DIR, "suggestions.json"), { force: true });
    const res = await handleRequest(req("/api/jobs"));
    const data = await res.json();
    const ids = data.jobs.map((j: any) => j.id);
    expect(ids).not.toContain("srvtest");
    // Restore
    writeFileSync(join(SRVTEST_DIR, "suggestions.json"), JSON.stringify(SRVTEST_SUGGESTIONS));
  });

  // --- GET /api/suggestions ---
  test("GET /api/suggestions returns data for __test__", async () => {
    const res = await handleRequest(req("/api/suggestions?jobId=__test__"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.suggestions).toHaveLength(4);
    expect(data.generatedAt).toBeDefined();
    expect(data.jobId).toBe("__test__");
  });

  test("GET /api/suggestions returns 404 for __fake__", async () => {
    const res = await handleRequest(req("/api/suggestions?jobId=__fake__"));
    expect(res.status).toBe(404);
  });

  test("GET /api/suggestions — all fields present", async () => {
    const res = await handleRequest(req("/api/suggestions?jobId=__test__"));
    const data = await res.json();
    const s = data.suggestions[0];
    expect(s.id).toBeDefined();
    expect(s.section).toBeDefined();
    expect(s.type).toBeDefined();
    expect(s.current).toBeDefined();
    expect(s.suggested).toBeDefined();
    expect(s.reason).toBeDefined();
    expect(s.principle).toBeDefined();
  });

  // --- POST /api/accept ---
  test("POST /api/accept applies specific IDs", async () => {
    const res = await handleRequest(req("/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1, 2], jobId: "__test__" }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toEqual([1, 2]);
    expect(data.skipped).toEqual([3, 4]);
  });

  test("POST /api/accept applies all", async () => {
    const res = await handleRequest(req("/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "all", jobId: "__test__" }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toEqual([1, 2, 3, 4]);
    expect(data.skipped).toEqual([]);
  });

  test("POST /api/accept returns 400 on missing ids", async () => {
    const res = await handleRequest(req("/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "__test__" }),
    }));
    expect(res.status).toBe(400);
  });

  test("POST /api/accept returns 400 on invalid ids", async () => {
    const res = await handleRequest(req("/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "invalid", jobId: "__test__" }),
    }));
    expect(res.status).toBe(400);
  });

  test("POST /api/accept creates backup", async () => {
    expect(existsSync(BACKUP_PATH)).toBe(false);
    await handleRequest(req("/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1], jobId: "__test__" }),
    }));
    expect(existsSync(BACKUP_PATH)).toBe(true);
  });

  // --- GET /api/profile ---
  test("GET /api/profile returns profile", async () => {
    const res = await handleRequest(req("/api/profile"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Test User");
  });

  test("GET /api/profile returns 404 when missing", async () => {
    rmSync(PROFILE_PATH, { force: true });
    const res = await handleRequest(req("/api/profile"));
    expect(res.status).toBe(404);
    // Restore for other tests
    writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE, null, 2));
  });

  // --- GET / ---
  test("GET / returns HTML content-type", async () => {
    const res = await handleRequest(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // --- Unknown routes ---
  test("unknown routes return 404 JSON", async () => {
    const res = await handleRequest(req("/api/nope"));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

// ---- E2E tests ----

describe("E2E: review UI server", () => {
  let server: ReturnType<typeof startServer>;
  let base: string;
  let profileSnapshot: string | null = null;
  let backupSnapshot: string | null = null;

  beforeAll(() => {
    profileSnapshot = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf-8") : null;
    backupSnapshot = existsSync(BACKUP_PATH) ? readFileSync(BACKUP_PATH, "utf-8") : null;
    writeSuggestionsFixture();
    server = startServer(0);
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    if (profileSnapshot !== null) writeFileSync(PROFILE_PATH, profileSnapshot);
    else if (existsSync(PROFILE_PATH)) rmSync(PROFILE_PATH);
    if (backupSnapshot !== null) writeFileSync(BACKUP_PATH, backupSnapshot);
    else if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
    cleanTestDirs();
  });

  beforeEach(() => {
    writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE, null, 2));
    if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
  });

  test("serves HTML page", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Resume Review");
  });

  test("lists available reviews (includes srvtest)", async () => {
    const res = await fetch(base + "/api/jobs");
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.jobs.map((j: any) => j.id);
    expect(ids).toContain("srvtest");
  });

  test("returns suggestions for __test__ (4 items)", async () => {
    const res = await fetch(base + "/api/suggestions?jobId=__test__");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.suggestions).toHaveLength(4);
  });

  test("404 for missing suggestions", async () => {
    const res = await fetch(base + "/api/suggestions?jobId=__fake__");
    expect(res.status).toBe(404);
  });

  test("applies specific IDs, returns correct applied/skipped", async () => {
    const res = await fetch(base + "/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1, 2], jobId: "__test__" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toEqual([1, 2]);
    expect(data.skipped).toEqual([3, 4]);
  });

  test("applies all", async () => {
    const res = await fetch(base + "/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "all", jobId: "__test__" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toEqual([1, 2, 3, 4]);
  });

  test("full flow: accept #1 then verify profile changed", async () => {
    // Accept suggestion #1 (summary rewrite)
    const acceptRes = await fetch(base + "/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1], jobId: "__test__" }),
    });
    expect(acceptRes.status).toBe(200);
    const acceptData = await acceptRes.json();
    expect(acceptData.applied).toContain(1);

    // Verify profile.summary changed
    const profileRes = await fetch(base + "/api/profile");
    expect(profileRes.status).toBe(200);
    const profile = await profileRes.json();
    expect(profile.summary).toBe("Backend engineer who reduced deploy times 80%");
  });

  test("400 for invalid body", async () => {
    const res = await fetch(base + "/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("400 for missing ids", async () => {
    const res = await fetch(base + "/api/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "__test__" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns profile", async () => {
    const res = await fetch(base + "/api/profile");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Test User");
  });

  test("404 for unknown routes", async () => {
    const res = await fetch(base + "/api/unknown");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

// ---- parse-resume unit tests ----

describe("parseResumeText", () => {
  test("extracts email from text", () => {
    const result = parseResumeText("Jane Doe\njane@example.com\nSome text");
    expect(result.email).toBe("jane@example.com");
  });

  test("extracts name (first non-empty line)", () => {
    const result = parseResumeText("Jane Doe\njane@example.com");
    expect(result.name).toBe("Jane Doe");
  });

  test("extracts URLs", () => {
    const result = parseResumeText("Jane Doe\nhttps://github.com/jane\nhttps://linkedin.com/in/jane");
    expect(result.urls).toContain("https://github.com/jane");
    expect(result.urls).toContain("https://linkedin.com/in/jane");
  });

  test("extracts phone number", () => {
    const result = parseResumeText("Jane Doe\n(555) 123-4567");
    expect(result.phone).toBe("(555) 123-4567");
  });

  test("detects experience section", () => {
    const text = `Jane Doe
jane@example.com

Experience
Senior Engineer at Acme Corp (2022 - Present)
- Built scalable APIs
- Led team of 5

Software Engineer at StartupXYZ (2019 - 2022)
- Built REST API`;
    const result = parseResumeText(text);
    expect(result.experience).toBeDefined();
    expect(result.experience!.length).toBeGreaterThanOrEqual(1);
    expect(result.experience![0].company).toContain("Acme Corp");
  });

  test("detects education section", () => {
    const text = `Jane Doe

Education
B.S. Computer Science - UC Berkeley (2019)`;
    const result = parseResumeText(text);
    expect(result.education).toBeDefined();
    expect(result.education!.length).toBeGreaterThanOrEqual(1);
  });

  test("detects skills section", () => {
    const text = `Jane Doe

Skills
Languages: Go, Python, TypeScript
Infrastructure: Kubernetes, Docker, AWS`;
    const result = parseResumeText(text);
    expect(result.skills).toBeDefined();
    expect(result.skills!.length).toBe(2);
    expect(result.skills![0].category).toBe("Languages");
    expect(result.skills![0].items).toContain("Go");
  });

  test("detects summary section", () => {
    const text = `Jane Doe

Summary
Senior engineer with 6 years of experience building scalable systems.`;
    const result = parseResumeText(text);
    expect(result.summary).toContain("Senior engineer");
  });

  test("returns empty object for empty input", () => {
    expect(parseResumeText("")).toEqual({});
    expect(parseResumeText("  ")).toEqual({});
  });
});

describe("extractText", () => {
  test("decodes UTF-8 for .txt files", async () => {
    const buf = Buffer.from("Hello World\nLine 2");
    const result = await extractText(buf, "resume.txt");
    expect(result).toBe("Hello World\nLine 2");
  });

  test("decodes UTF-8 for .md files", async () => {
    const buf = Buffer.from("# Resume\nContent here");
    const result = await extractText(buf, "resume.md");
    expect(result).toBe("# Resume\nContent here");
  });
});

// ---- POST /api/upload and PUT /api/profile route tests ----

describe("upload and profile routes", () => {
  let profileSnapshot: string | null = null;
  let backupSnapshot: string | null = null;

  beforeAll(() => {
    profileSnapshot = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf-8") : null;
    backupSnapshot = existsSync(BACKUP_PATH) ? readFileSync(BACKUP_PATH, "utf-8") : null;
  });

  afterAll(() => {
    if (profileSnapshot !== null) writeFileSync(PROFILE_PATH, profileSnapshot);
    else if (existsSync(PROFILE_PATH)) rmSync(PROFILE_PATH);
    if (backupSnapshot !== null) writeFileSync(BACKUP_PATH, backupSnapshot);
    else if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
  });

  beforeEach(() => {
    writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE, null, 2));
    if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);
  });

  // --- POST /api/upload ---
  test("POST /api/upload with JSON text returns rawText + parsed", async () => {
    const res = await handleRequest(req("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Jane Doe\njane@example.com\n\nSummary\nExperienced engineer." }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rawText).toContain("Jane Doe");
    expect(data.parsed).toBeDefined();
    expect(data.parsed.name).toBe("Jane Doe");
    expect(data.parsed.email).toBe("jane@example.com");
  });

  test("POST /api/upload with empty text returns 400", async () => {
    const res = await handleRequest(req("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    }));
    expect(res.status).toBe(400);
  });

  test("POST /api/upload with empty JSON body returns 400", async () => {
    const res = await handleRequest(req("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  test("POST /api/upload with multipart file returns parsed data", async () => {
    const text = "John Smith\njohn@test.com\n\nExperience\nEngineer at BigCo (2020 - 2024)\n- Built things";
    const file = new File([text], "resume.txt", { type: "text/plain" });
    const fd = new FormData();
    fd.append("file", file);
    const res = await handleRequest(new Request("http://localhost/api/upload", {
      method: "POST",
      body: fd,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rawText).toContain("John Smith");
    expect(data.parsed.name).toBe("John Smith");
    expect(data.parsed.email).toBe("john@test.com");
  });

  // --- PUT /api/profile ---
  test("PUT /api/profile saves profile and GET returns it", async () => {
    const newProfile = { name: "New User", email: "new@test.com", summary: "New summary" };
    const putRes = await handleRequest(req("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newProfile),
    }));
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.success).toBe(true);

    const getRes = await handleRequest(req("/api/profile"));
    const getData = await getRes.json();
    expect(getData.name).toBe("New User");
    expect(getData.email).toBe("new@test.com");
  });

  test("PUT /api/profile creates backup of existing profile", async () => {
    expect(existsSync(BACKUP_PATH)).toBe(false);
    await handleRequest(req("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    }));
    expect(existsSync(BACKUP_PATH)).toBe(true);
    const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf-8"));
    expect(backup.name).toBe("Test User"); // original profile
  });

  test("PUT /api/profile with empty body returns 400", async () => {
    const res = await handleRequest(req("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }));
    expect(res.status).toBe(400);
  });

  test("PUT /api/profile without name returns 400", async () => {
    const res = await handleRequest(req("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "no-name@test.com" }),
    }));
    expect(res.status).toBe(400);
  });
});
