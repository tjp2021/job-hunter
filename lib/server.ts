/**
 * Local HTTP server for the resume review UI.
 * Zero dependencies — uses Bun's built-in HTTP server.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import * as review from "./review";
import * as tracker from "./tracker";
import { extractText, parseResumeText } from "./parse-resume";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PROFILE_PATH = join(DATA_DIR, "profile.json");
const OUTPUT_DIR = join(DATA_DIR, "output");
const UI_PATH = join(import.meta.dir, "ui.html");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // GET / — serve UI
  if (req.method === "GET" && path === "/") {
    const html = readFileSync(UI_PATH, "utf-8");
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // GET /api/jobs — list jobs with suggestions
  if (req.method === "GET" && path === "/api/jobs") {
    const jobs: { id: string; label: string; hasSuggestions: boolean }[] = [];
    if (existsSync(OUTPUT_DIR)) {
      const entries = readdirSync(OUTPUT_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith("__")) continue;
        const sugPath = join(OUTPUT_DIR, entry.name, "suggestions.json");
        const hasSuggestions = existsSync(sugPath);
        if (!hasSuggestions) continue;
        const job = tracker.get(entry.name);
        const label = job ? `${job.title} @ ${job.company}` : entry.name;
        jobs.push({ id: entry.name, label, hasSuggestions });
      }
    }
    return json({ jobs });
  }

  // GET /api/suggestions?jobId=x
  if (req.method === "GET" && path === "/api/suggestions") {
    const jobId = url.searchParams.get("jobId");
    if (!jobId) {
      return json({ error: "Missing jobId parameter" }, 400);
    }
    const resolvedId = jobId === "review" ? undefined : jobId;
    const data = review.loadSuggestions(resolvedId);
    if (!data) {
      return json({ error: "No suggestions found" }, 404);
    }
    return json(data);
  }

  // POST /api/accept — apply suggestions
  if (req.method === "POST" && path === "/api/accept") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { ids, jobId } = body;
    if (ids === undefined || ids === null) {
      return json({ error: "Missing ids field" }, 400);
    }
    if (ids !== "all" && !Array.isArray(ids)) {
      return json({ error: 'ids must be an array of numbers or "all"' }, 400);
    }
    if (Array.isArray(ids) && ids.length === 0) {
      return json({ error: "ids array is empty" }, 400);
    }

    try {
      const resolvedId = jobId === "review" ? undefined : jobId;
      const result = review.applyByIds(ids, resolvedId);
      return json(result);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // GET /api/profile
  if (req.method === "GET" && path === "/api/profile") {
    if (!existsSync(PROFILE_PATH)) {
      return json({ error: "No profile found" }, 404);
    }
    try {
      const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
      return json(profile);
    } catch {
      return json({ error: "Invalid profile JSON" }, 500);
    }
  }

  // POST /api/upload — extract text from uploaded file or pasted text, parse into profile fields
  if (req.method === "POST" && path === "/api/upload") {
    const contentType = req.headers.get("content-type") || "";

    let rawText: string;

    if (contentType.includes("multipart/form-data")) {
      let formData: FormData;
      try {
        formData = await req.formData();
      } catch {
        return json({ error: "Invalid form data" }, 400);
      }
      const file = formData.get("file");
      if (!file || !(file instanceof File) || file.size === 0) {
        return json({ error: "Missing or empty file" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      try {
        rawText = await extractText(buf, file.name);
      } catch (e: any) {
        return json({ error: "Failed to extract text: " + e.message }, 400);
      }
    } else if (contentType.includes("application/json")) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
        return json({ error: "Missing or empty text field" }, 400);
      }
      rawText = body.text;
    } else {
      return json({ error: "Unsupported content type. Use multipart/form-data or application/json" }, 400);
    }

    const parsed = parseResumeText(rawText);
    return json({ rawText, parsed });
  }

  // PUT /api/profile — save profile JSON
  if (req.method === "PUT" && path === "/api/profile") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || !body.name || typeof body.name !== "string" || !body.name.trim()) {
      return json({ error: "name is required" }, 400);
    }

    // Backup existing profile if present
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(PROFILE_PATH)) {
      copyFileSync(PROFILE_PATH, PROFILE_PATH.replace(".json", ".backup.json"));
    }

    writeFileSync(PROFILE_PATH, JSON.stringify(body, null, 2));
    return json({ success: true });
  }

  // Fallback 404
  return json({ error: "Not found" }, 404);
}

export function startServer(port: number) {
  const server = Bun.serve({
    port,
    fetch: handleRequest,
  });
  console.log(`Review UI running at http://localhost:${server.port}`);
  return server;
}
