/**
 * Multi-source job search: ts-jobspy + Greenhouse + Lever public APIs.
 * Normalizes results into a common format and deduplicates.
 */

import { scrapeJobs } from "ts-jobspy";
import * as cache from "./cache";
import { formatSalary } from "./format";
import type { JobResult } from "./format";

export interface SearchOptions {
  site?: string;
  location?: string;
  remote?: boolean;
  results?: number;
  jobType?: string;
  hoursOld?: number;
  greenhouseBoards?: string[];
  leverSites?: string[];
}

const STOPWORDS = new Set(["a", "an", "the", "in", "at", "for", "and", "or", "of", "with", "to", "on", "is"]);

/**
 * Score how well a job matches the query. Returns 0 for no match.
 * All meaningful query words must appear somewhere in title + extraText.
 * Title matches are weighted 2x higher than description-only matches.
 */
function matchesQuery(query: string, title: string, extraText: string = ""): number {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
  if (words.length === 0) return 1;

  const titleLower = title.toLowerCase();
  const fullText = `${titleLower} ${extraText.toLowerCase()}`;

  const titleMatches = words.filter(w => titleLower.includes(w)).length;
  const fullMatches = words.filter(w => fullText.includes(w)).length;

  if (fullMatches < words.length) return 0;

  return titleMatches * 2 + (fullMatches - titleMatches);
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Search via ts-jobspy (LinkedIn + Indeed).
 */
async function searchJobSpy(query: string, opts: SearchOptions): Promise<JobResult[]> {
  const siteMap: Record<string, "linkedin" | "indeed"> = {
    linkedin: "linkedin",
    indeed: "indeed",
  };

  let siteName: ("linkedin" | "indeed")[] | ("linkedin" | "indeed") | undefined;
  if (opts.site && siteMap[opts.site]) {
    siteName = siteMap[opts.site];
  } else {
    siteName = ["linkedin", "indeed"];
  }

  const results = await scrapeJobs({
    siteName,
    searchTerm: query,
    location: opts.location,
    isRemote: opts.remote,
    resultsWanted: opts.results || 15,
    jobType: opts.jobType,
    hoursOld: opts.hoursOld,
    descriptionFormat: "markdown",
    linkedinFetchDescription: true,
  });

  return results.map((r) => ({
    title: r.title || "Untitled",
    company: r.company || "Unknown",
    location: r.location || "Unknown",
    isRemote: r.isRemote || false,
    jobUrl: r.jobUrl,
    source: r.site || "jobspy",
    datePosted: r.datePosted || null,
    salary: formatSalary(r.minAmount, r.maxAmount, r.interval, r.currency),
    description: r.description || "",
  }));
}

/**
 * Search Greenhouse public job board API.
 */
async function searchGreenhouse(
  query: string,
  boards: string[]
): Promise<JobResult[]> {
  const results: JobResult[] = [];

  for (const board of boards) {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`
      );
      if (!res.ok) continue;
      const data = await res.json();

      const scored = (data.jobs || [])
        .map((j: any) => {
          const extra = `${j.location?.name || ""} ${j.content || ""}`;
          return { job: j, score: matchesQuery(query, j.title, extra) };
        })
        .filter((s: any) => s.score > 0)
        .sort((a: any, b: any) => b.score - a.score);

      for (const { job: j } of scored) {
        results.push({
          title: j.title,
          company: board,
          location: j.location?.name || "Unknown",
          isRemote: /remote/i.test(j.location?.name || ""),
          jobUrl: j.absolute_url,
          source: "greenhouse",
          datePosted: j.updated_at || null,
          salary: null,
          description: j.content || "",
        });
      }
    } catch {
      console.error(`(greenhouse: failed to fetch ${board})`);
    }
  }

  return results;
}

/**
 * Search Lever public postings API.
 */
async function searchLever(
  query: string,
  sites: string[]
): Promise<JobResult[]> {
  const results: JobResult[] = [];

  for (const site of sites) {
    try {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${site}?mode=json`
      );
      if (!res.ok) continue;
      const postings = await res.json();

      const scored = postings
        .map((p: any) => {
          const extra = `${p.categories?.location || ""} ${p.categories?.team || ""} ${p.descriptionPlain || p.description || ""}`;
          return { posting: p, score: matchesQuery(query, p.text, extra) };
        })
        .filter((s: any) => s.score > 0)
        .sort((a: any, b: any) => b.score - a.score);

      for (const { posting: p } of scored) {
        const location = p.categories?.location || "Unknown";
        results.push({
          title: p.text,
          company: site,
          location,
          isRemote: /remote/i.test(location),
          jobUrl: p.hostedUrl || p.applyUrl,
          source: "lever",
          datePosted: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          salary: null,
          description: p.descriptionPlain || p.description || "",
        });
      }
    } catch {
      console.error(`(lever: failed to fetch ${site})`);
    }
  }

  return results;
}

/**
 * Deduplicate by job URL (normalized).
 */
function dedupe(jobs: JobResult[]): JobResult[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    const key = j.jobUrl.replace(/\?.*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Main search: combines all sources, caches results.
 */
export async function search(
  query: string,
  opts: SearchOptions = {}
): Promise<JobResult[]> {
  const cacheParams = JSON.stringify(opts);
  const cached = cache.get<JobResult[]>(query, cacheParams, CACHE_TTL_MS);
  if (cached) {
    console.error(`(cached — ${cached.length} results)`);
    return cached;
  }

  const promises: Promise<JobResult[]>[] = [];

  // Only skip jobspy if the site is explicitly greenhouse or lever
  if (!opts.site || ["linkedin", "indeed"].includes(opts.site)) {
    promises.push(
      searchJobSpy(query, opts).catch((e) => {
        console.error(`(jobspy error: ${e.message})`);
        return [];
      })
    );
  }

  if (opts.greenhouseBoards && opts.greenhouseBoards.length > 0) {
    promises.push(searchGreenhouse(query, opts.greenhouseBoards));
  }

  if (opts.leverSites && opts.leverSites.length > 0) {
    promises.push(searchLever(query, opts.leverSites));
  }

  const allResults = (await Promise.all(promises)).flat();
  const deduped = dedupe(allResults);

  cache.set(query, cacheParams, deduped);
  return deduped;
}
