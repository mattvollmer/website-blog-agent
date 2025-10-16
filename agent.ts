import { convertToModelMessages, streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";
import * as webSearch from "@blink-sdk/web-search";

// Helper functions for Algolia tools
type SitemapEntry = {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
};

async function fetchXml(url: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch XML: ${url} (${res.status})`);
  return await res.text();
}

async function parseSitemap(
  url: string,
  seen = new Set<string>()
): Promise<SitemapEntry[]> {
  if (seen.has(url)) return [] as SitemapEntry[];
  seen.add(url);

  const parser = new XMLParser({ ignoreAttributes: false });
  const xml = await fetchXml(url);
  const doc = parser.parse(xml);

  if (doc.sitemapindex?.sitemap) {
    const items = Array.isArray(doc.sitemapindex.sitemap)
      ? doc.sitemapindex.sitemap
      : [doc.sitemapindex.sitemap];
    const nested = await Promise.all(
      items.map((s: any) => parseSitemap(s.loc, seen))
    );
    return nested.flat();
  }

  if (doc.urlset?.url) {
    const urls = Array.isArray(doc.urlset.url)
      ? doc.urlset.url
      : [doc.urlset.url];
    return urls.map((u: any) => ({
      loc: u.loc,
      lastmod: u.lastmod,
      changefreq: u.changefreq,
      priority: u.priority ? Number(u.priority) : undefined,
    }));
  }

  return [] as SitemapEntry[];
}

function isBlogUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "coder.com" || u.hostname.endsWith(".coder.com")) &&
      (u.pathname === "/blog" || u.pathname.startsWith("/blog/"))
    );
  } catch {
    return false;
  }
}

function isDocsUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "coder.com" || u.hostname.endsWith(".coder.com")) &&
      (u.pathname === "/docs" || u.pathname.startsWith("/docs/"))
    );
  } catch {
    return false;
  }
}

function stripHtml(input: string | undefined, max = 220): string | undefined {
  if (!input) return undefined;
  const s = input
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function hierarchyTitle(h: any): string | undefined {
  if (!h) return undefined;
  const levels = ["lvl1", "lvl2", "lvl0", "lvl3", "lvl4", "lvl5", "lvl6"];
  for (const k of levels) if (h[k]) return String(h[k]);
  return undefined;
}

const agent = blink.agent();

agent.on("chat", async ({ messages }) => {
  const tools = {
    ...webSearch.tools,
    search_docs: tool({
      description:
        "Search Coder's documentation via Algolia. Use this to find docs pages, guides, and technical reference material. Mode 'light' (default) returns url/title/snippet only; 'full' returns additional hierarchy/content - only use 'full' if you need deep content analysis, not for basic searches.",
      inputSchema: z.object({
        query: z.string(),
        page: z.number().int().min(0).optional(),
        hitsPerPage: z.number().int().min(1).max(10).optional(),
        facetFilters: z
          .array(z.union([z.string(), z.array(z.string())]))
          .optional(),
        filters: z.string().optional(),
        mode: z.enum(["light", "full"]).optional(),
      }),
      execute: async (input: {
        query: string;
        page?: number;
        hitsPerPage?: number;
        facetFilters?: (string | string[])[];
        filters?: string;
        mode?: "light" | "full";
      }) => {
        const appId = process.env.ALGOLIA_APP_ID as string | undefined;
        const apiKey = process.env.ALGOLIA_SEARCH_KEY as string | undefined;
        const indexName = "docs";
        if (!appId || !apiKey) {
          return {
            available: false as const,
            reason:
              "Missing Algolia env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY",
          };
        }
        const mode = input.mode ?? "light";
        const hitsPerPage = Math.min(input.hitsPerPage ?? 3, 5);

        // Ensure we only search v2-tagged docs by default
        const baseFacetFilters: (string | string[])[] = [];
        if (input.facetFilters && Array.isArray(input.facetFilters)) {
          for (const ff of input.facetFilters) baseFacetFilters.push(ff);
        }
        // Add an AND filter for tags:v2 if not already present
        const hasV2 = baseFacetFilters.some((ff) => {
          if (typeof ff === "string") return ff === "tags:v2";
          return ff.includes("tags:v2");
        });
        if (!hasV2) baseFacetFilters.push("tags:v2");
        // Add an AND filter for version:main if not already present
        const hasMain = baseFacetFilters.some((ff) => {
          if (typeof ff === "string") return ff === "version:main";
          return ff.includes("version:main");
        });
        if (!hasMain) baseFacetFilters.push("version:main");

        const body: any = {
          query: input.query,
          page: input.page ?? 0,
          hitsPerPage,
          attributesToRetrieve:
            mode === "light"
              ? ["url", "hierarchy", "type"]
              : ["url", "hierarchy", "content", "type"],
          facetFilters: baseFacetFilters,
          filters: input.filters,
        };
        if (mode === "full") body.attributesToSnippet = ["content:40"];

        const res = await fetch(
          `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(
            indexName
          )}/query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Algolia-Application-Id": appId,
              "X-Algolia-API-Key": apiKey,
            },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) throw new Error(`Algolia error ${res.status}`);
        const data: any = await res.json();
        const rawHits = (data.hits ?? []) as any[];
        const filtered = rawHits.filter(
          (h) => typeof h.url === "string" && isDocsUrl(h.url)
        );

        const hits =
          mode === "light"
            ? filtered.map((h: any) => {
                const title = hierarchyTitle(h.hierarchy) ?? "(No title)";
                return {
                  url: h.url as string,
                  title,
                  snippet: stripHtml(
                    h._snippetResult?.content?.value as string | undefined,
                    200
                  ),
                  objectID: h.objectID as string,
                };
              })
            : filtered.map((h: any) => {
                const title = hierarchyTitle(h.hierarchy) ?? "(No title)";
                return {
                  url: h.url as string,
                  title,
                  hierarchy: h.hierarchy,
                  content: h.content as string | undefined,
                  snippet: stripHtml(
                    h._snippetResult?.content?.value as string | undefined,
                    300
                  ),
                  type: h.type as string | undefined,
                  objectID: h.objectID as string,
                };
              });

        return {
          available: true as const,
          hits,
          page: data.page as number,
          nbPages: data.nbPages as number,
          nbHits: data.nbHits as number,
        };
      },
    }),
    search_blog: tool({
      description:
        "Search Coder's blog posts via Algolia. Use this to find blog articles and announcements. Mode 'light' (default) returns url/title/snippet/author/date; 'full' returns additional hierarchy/content - only use 'full' if you need deep content analysis, not for basic searches.",
      inputSchema: z.object({
        query: z.string(),
        page: z.number().int().min(0).optional(),
        hitsPerPage: z.number().int().min(1).max(10).optional(),
        facetFilters: z
          .array(z.union([z.string(), z.array(z.string())]))
          .optional(),
        filters: z.string().optional(),
        mode: z.enum(["light", "full"]).optional(),
      }),
      execute: async (input: {
        query: string;
        page?: number;
        hitsPerPage?: number;
        facetFilters?: (string | string[])[];
        filters?: string;
        mode?: "light" | "full";
      }) => {
        const appId = process.env.ALGOLIA_APP_ID as string | undefined;
        const apiKey = process.env.ALGOLIA_SEARCH_KEY as string | undefined;
        const indexName =
          (process.env.ALGOLIA_INDEX_NAME as string | undefined) ??
          "website blog";
        if (!appId || !apiKey || !indexName) {
          return {
            available: false as const,
            reason:
              "Missing Algolia env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, ALGOLIA_INDEX_NAME",
          };
        }
        const mode = input.mode ?? "light";
        const hitsPerPage = Math.min(input.hitsPerPage ?? 5, 10);

        const baseFacetFilters: (string | string[])[] = [];
        if (input.facetFilters && Array.isArray(input.facetFilters)) {
          for (const ff of input.facetFilters) baseFacetFilters.push(ff);
        }

        const body: any = {
          query: input.query,
          page: input.page ?? 0,
          hitsPerPage,
          attributesToRetrieve:
            mode === "light"
              ? ["url", "slug", "hierarchy", "type", "title", "description", "author", "date", "publishedDate"]
              : ["url", "slug", "hierarchy", "content", "type", "title", "description", "author", "date", "publishedDate"],
          facetFilters: baseFacetFilters,
          filters: input.filters,
        };
        if (mode === "full") body.attributesToSnippet = ["content:40"];

        const res = await fetch(
          `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(
            indexName
          )}/query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Algolia-Application-Id": appId,
              "X-Algolia-API-Key": apiKey,
            },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) throw new Error(`Algolia error ${res.status}`);
        const data: any = await res.json();
        const rawHits = (data.hits ?? []) as any[];
        // Blog posts may use 'url', 'slug', or 'objectID'
        const filtered = rawHits.filter((h) => {
          // Accept hits that have url, slug, objectID, or hierarchy information
          return h.url || h.slug || h.objectID || h.hierarchy;
        });

        const hits =
          mode === "light"
            ? filtered.map((h: any) => {
                // Try multiple sources for title
                const title = h.title ?? hierarchyTitle(h.hierarchy) ?? "(No title)";
                // Try multiple sources for description/snippet
                const snippet = h.description ?? stripHtml(
                  h._snippetResult?.content?.value as string | undefined,
                  200
                );
                // Construct URL from available data
                const url = h.url ?? (h.slug ? `https://coder.com/blog/${h.slug}` : h.objectID);
                return {
                  url,
                  title,
                  snippet,
                  author: h.author as string | undefined,
                  date: h.date ?? h.publishedDate as string | undefined,
                  objectID: h.objectID as string,
                };
              })
            : filtered.map((h: any) => {
                const title = h.title ?? hierarchyTitle(h.hierarchy) ?? "(No title)";
                const snippet = h.description ?? stripHtml(
                  h._snippetResult?.content?.value as string | undefined,
                  300
                );
                const url = h.url ?? (h.slug ? `https://coder.com/blog/${h.slug}` : h.objectID);
                return {
                  url,
                  title,
                  hierarchy: h.hierarchy,
                  content: h.content as string | undefined,
                  snippet,
                  author: h.author as string | undefined,
                  date: h.date ?? h.publishedDate as string | undefined,
                  type: h.type as string | undefined,
                  objectID: h.objectID as string,
                };
              });

        return {
          available: true as const,
          hits,
          page: data.page as number,
          nbPages: data.nbPages as number,
          nbHits: data.nbHits as number,
        };
      },
    }),
    sitemap_list: tool({
      description:
        "Fetch and flatten sitemap URLs (default https://coder.com/sitemap.xml) from the entire coder.com domain. Use this to get a list of URLs, including blog posts, case studies, docs, etc.",
      inputSchema: z.object({
        sitemapUrl: z.string().url().optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(10000).optional(),
      }),
      execute: async (input: {
        sitemapUrl?: string;
        include?: string[];
        exclude?: string[];
        limit?: number;
      }) => {
        const sitemapUrl = input.sitemapUrl ?? "https://coder.com/sitemap.xml";
        let entries: SitemapEntry[] = await parseSitemap(sitemapUrl);
        if (input.include?.length) {
          entries = entries.filter((e: SitemapEntry) =>
            input.include!.some((p: string) => e.loc.includes(p))
          );
        }
        if (input.exclude?.length) {
          entries = entries.filter(
            (e: SitemapEntry) =>
              !input.exclude!.some((p: string) => e.loc.includes(p))
          );
        }
        if (input.limit) entries = entries.slice(0, input.limit);
        return { count: entries.length, entries };
      },
    }),
    page_outline: tool({
      description:
        "Fetch a blog page and return title and outline (h1–h3 + anchors + internal links). Use this to understand blog post structure without reading full content.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }: { url: string }) => {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok)
          throw new Error(`Failed to fetch page: ${url} (${res.status})`);
        const html = await res.text();
        const root = parse(html);

        const title = root.querySelector("title")?.text?.trim() ?? null;

        const headings: Array<{
          level: number;
          id: string | null;
          text: string;
        }> = [];
        for (const level of [1, 2, 3]) {
          root.querySelectorAll(`h${level}`).forEach((h) => {
            const id =
              h.getAttribute("id") ??
              h.querySelector("a[id]")?.getAttribute("id") ??
              null;
            const text = h.text.trim();
            headings.push({ level, id, text });
          });
        }

        const anchors = root
          .querySelectorAll('a[href^="#"]')
          .map((a) => a.getAttribute("href"))
          .filter((href): href is string => typeof href === "string");

        const internalLinks = root
          .querySelectorAll('a[href^="/"]')
          .map((a) => a.getAttribute("href"))
          .filter((u): u is string => !!u)
          .filter((u) => {
            try {
              const full = new URL(u, url).toString();
              return isBlogUrl(full);
            } catch {
              return false;
            }
          });

        return { url, title, headings, anchors, internalLinks };
      },
    }),
    fetch_url: tool({
      description:
        "Fetch and parse any web page and extract full text content. Use this when you need to read the actual detailed content of any web page. Do NOT use this for coder.com/blog posts - use page_section or search_blog instead.",
      inputSchema: z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(100).max(50000).optional(),
      }),
      execute: async ({
        url,
        maxChars,
      }: {
        url: string;
        maxChars?: number;
      }) => {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok)
          throw new Error(`Failed to fetch page: ${url} (${res.status})`);

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
          return {
            success: false as const,
            reason: `Content type ${contentType} is not HTML`,
          };
        }

        const html = await res.text();
        const root = parse(html);

        const title = root.querySelector("title")?.text?.trim() ?? null;
        const metaDescription =
          root
            .querySelector('meta[name="description"]')
            ?.getAttribute("content")
            ?.trim() ??
          root
            .querySelector('meta[property="og:description"]')
            ?.getAttribute("content")
            ?.trim() ??
          null;

        // Remove script, style, nav, footer, header elements
        root
          .querySelectorAll("script, style, nav, footer, header")
          .forEach((el) => el.remove());

        // Try to find main content area
        const mainContent =
          root.querySelector("main") ??
          root.querySelector("article") ??
          root.querySelector('[role="main"]') ??
          root.querySelector("body");

        const textContent = mainContent?.text?.trim() ?? "";
        const maxLen = maxChars ?? 10000;
        const truncatedText =
          textContent.length > maxLen
            ? textContent.slice(0, maxLen) + "... (truncated)"
            : textContent;

        // Extract all links with their text
        const links = (mainContent ?? root)
          .querySelectorAll("a[href]")
          .map((a) => {
            const href = a.getAttribute("href");
            const text = a.text.trim();
            if (!href) return null;
            try {
              const absoluteUrl = new URL(href, url).toString();
              return { url: absoluteUrl, text };
            } catch {
              return null;
            }
          })
          .filter(
            (link): link is { url: string; text: string } => link !== null
          )
          .slice(0, 50); // Limit to 50 links

        // Extract headings for structure
        const headings: Array<{ level: number; text: string }> = [];
        for (const level of [1, 2, 3]) {
          (mainContent ?? root).querySelectorAll(`h${level}`).forEach((h) => {
            const text = h.text.trim();
            if (text) headings.push({ level, text });
          });
        }

        return {
          success: true as const,
          url,
          title,
          metaDescription,
          text: truncatedText,
          headings,
          links,
        };
      },
    }),
    page_section: tool({
      description:
        "Fetch and return the full content of a specific blog page section. Use this when you need to read the actual detailed content of a blog section to answer questions or provide summaries. If user just wants an overview, use page_outline instead.",
      inputSchema: z.object({
        url: z.string().url(),
        anchorId: z.string().optional(),
        headingText: z.string().optional(),
        maxChars: z.number().int().min(100).max(20000).optional(),
      }),
      execute: async ({
        url,
        anchorId,
        headingText,
        maxChars,
      }: {
        url: string;
        anchorId?: string;
        headingText?: string;
        maxChars?: number;
      }) => {
        if (!isBlogUrl(url)) {
          throw new Error("Only coder.com/blog URLs are supported");
        }
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok)
          throw new Error(`Failed to fetch page: ${url} (${res.status})`);
        const html = await res.text();
        const root = parse(html);

        const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");

        const levelOf = (tagName: string | undefined): number => {
          const safeTagName = tagName ?? "";
          const m = safeTagName.match(/^h([1-6])$/i);
          return m && m[1] ? parseInt(m[1], 10) : 6;
        };

        let targetIndex = -1;
        let targetLevel = 6;

        for (let i = 0; i < headings.length; i++) {
          const h = headings[i];
          if (!h) continue;
          const id =
            h.getAttribute("id") ??
            h.querySelector("a[id]")?.getAttribute("id") ??
            null;
          const txt = h.text.trim();
          if (
            (anchorId && id === anchorId) ||
            (headingText && txt.toLowerCase() === headingText.toLowerCase())
          ) {
            targetIndex = i;
            const tagName = h.tagName?.toLowerCase();
            targetLevel = levelOf(tagName);
            break;
          }
        }

        if (targetIndex < 0) {
          return {
            found: false as const,
            reason: "Section not found by anchorId or headingText.",
          };
        }

        const start = headings[targetIndex];
        if (!start) {
          return {
            found: false as const,
            reason: "Section heading not found in array.",
          };
        }
        let htmlOut = "";
        const codeBlocks: string[] = [];
        const textChunks: string[] = [];

        let node: any = (start as any).nextElementSibling;
        const maxLen = maxChars ?? 5000;

        while (node) {
          const tag = node.tagName?.toLowerCase?.();
          if (typeof tag === "string" && tag.match(/^h[1-6]$/)) {
            const nextLevel = levelOf(tag);
            if (nextLevel <= targetLevel) break;
          }

          const snippet = node.toString();
          if (htmlOut.length + snippet.length > maxLen) break;
          htmlOut += snippet;

          if (tag === "pre" || tag === "code") {
            codeBlocks.push(node.text.trim());
          }
          const maybeText = node.text?.trim?.();
          if (maybeText) textChunks.push(maybeText);

          node = node.nextElementSibling;
        }

        return {
          found: true as const,
          url,
          anchorId:
            anchorId ??
            start.getAttribute("id") ??
            start.querySelector("a[id]")?.getAttribute("id") ??
            null,
          heading: start.text.trim(),
          html: htmlOut,
          text: textChunks.join("\n\n"),
          codeBlocks,
        };
      },
    }),
  };

  return streamText({
    model: blink.model("anthropic/claude-sonnet-4.5"),
    system: `You are a reading assistant for Coder, optimized for content search and summarization.

## About This Agent
You were built using Blink, an open-source agent development engine created by Coder. Blink enables developers to build and deploy AI agents anywhere. If users ask about how you were built or want to create their own agents:
- Website: https://blink.so
- GitHub: https://github.com/coder/blink
- Documentation: https://docs.blink.so

## PRIMARY PURPOSE: Content Discovery & Summarization
Your main job is to help users find and understand content from Coder's blog and documentation. You can search both sources and provide summaries.

## Available Tools:
- search_docs: Search Coder documentation
- search_blog: Search Coder blog posts
- sitemap_list: Lists all website URLs
- page_outline: Gets blog structure (headings, links)
- fetch_url: Fetches full page content (any URL)
- page_section: Fetches specific blog section content
- web_search: Search the web for general information outside of Coder content

Use the appropriate tool based on what information you need to answer the user's question.

## Workflow for Content Discovery:

**For documentation queries:**
1. Use search_docs (mode: light) to find relevant docs
2. Present results with titles/URLs
3. If you need more details to answer the question, use the appropriate tool to fetch full content

**For blog summaries:**
1. Use search_blog (mode: light) to find the post
2. Use page_outline to see structure
3. If you need the full content to provide a complete answer, use page_section

**For general questions:**
1. Determine if the query is about docs (technical how-to, configuration, setup) or blog (announcements, use cases, stories)
2. Use search_docs for technical questions, search_blog for announcements/content
3. You can search both if unclear which is more relevant

**For related content:**
1. Use search_docs and/or search_blog to find relevant content
2. Present titles/URLs from search results
3. If you need more details to answer the question, fetch full content as needed

## CRITICAL: URL Formatting Rules
- ONLY use URLs that are explicitly returned in tool results
- NEVER construct, guess, or infer URLs
- If a tool returns a title without a URL, present it as plain text without a link
- When formatting links, use the EXACT url field from the tool result: [title](url)
- Do NOT use objectID as a URL - it is only an internal identifier

## Non-Support Agent
You are NOT a support agent. For technical support:
- Coder customers: Contact your Coder account team
- Open-source users: Discord at https://discord.com/invite/coder
- Sales: https://coder.com/contact/sales
- Docs: https://coder.com/docs

## Response Length Guidelines:
**When summarizing content:**
- Keep your INITIAL response to 100 words or less
- Provide a concise summary with the most important points
- After your summary, ALWAYS ask: "Would you like more details?"
- Only provide extended analysis if the user requests it

## Formatting Rules:
- NO tables - use bullet points, numbered lists, or prose
- ALWAYS format links as [text](URL) using exact URLs from tool results
- Match user's communication style (formal/informal)
- Be concise: 3-5 key points for summaries
- Use clear, accessible language
- Include technical details when appropriate`,
    messages: convertToModelMessages(messages, {
      ignoreIncompleteToolCalls: true,
    }),
    tools,
  });
});

agent.serve();
