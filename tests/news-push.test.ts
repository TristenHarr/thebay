/**
 * The push endpoint is the only route that writes stories without a signed-in
 * human behind it, so its limits are the interesting part — not the happy path.
 */
import { describe, it, expect } from "vitest";
import { PushPayloadSchema, PUSHABLE_ORIGINS, MAX_PUSH_BATCH } from "../src/news/ingest/push";

const paper = (over: Record<string, unknown> = {}) => ({
  origin: "research",
  externalId: "W123",
  title: "A paper about lattices — Stanford",
  url: "https://doi.org/10.1000/x",
  externalUrl: null,
  points: 4,
  comments: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  author: "Researcher et al.",
  topics: ["math"],
  ...over,
});

describe("pushed stories", () => {
  it("accepts a well-formed research paper", () => {
    expect(PushPayloadSchema.safeParse({ stories: [paper()] }).success).toBe(true);
  });

  it("REFUSES to mint a story that would look like a human submission", () => {
    // `bay` is what a person's own post is. A stolen ingest token must not be
    // able to forge one — that's the whole reason origins are allowlisted.
    expect(PushPayloadSchema.safeParse({ stories: [paper({ origin: "bay" })] }).success).toBe(false);
    expect(PUSHABLE_ORIGINS).not.toContain("bay" as never);
  });

  it("refuses origins it doesn't serve, including ones we do ingest elsewhere", () => {
    for (const o of ["hn", "fda", "sec", "event", "martian"]) {
      expect(PushPayloadSchema.safeParse({ stories: [paper({ origin: o })] }).success, o).toBe(false);
    }
  });

  it("rejects a batch larger than the cap rather than truncating it", () => {
    const big = { stories: Array.from({ length: MAX_PUSH_BATCH + 1 }, (_, i) => paper({ externalId: `W${i}` })) };
    expect(PushPayloadSchema.safeParse(big).success).toBe(false);
  });

  it("rejects unparseable dates — a bad instant mis-sorts the whole feed", () => {
    expect(PushPayloadSchema.safeParse({ stories: [paper({ createdAt: "last tuesday" })] }).success).toBe(false);
  });

  it("rejects non-URL links and oversized text", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "not a url"]) {
      expect(PushPayloadSchema.safeParse({ stories: [paper({ url: bad })] }).success, bad).toBe(false);
    }
    expect(PushPayloadSchema.safeParse({ stories: [paper({ title: "x".repeat(201) })] }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ stories: [paper({ title: "ab" })] }).success).toBe(false);
  });

  it("rejects the whole batch when any single story is bad", () => {
    // Partial application is the state that's hardest to reason about later.
    const mixed = { stories: [paper(), paper({ externalId: "", title: "x".repeat(400) })] };
    expect(PushPayloadSchema.safeParse(mixed).success).toBe(false);
  });
});

describe("feeds the Worker cannot reach", () => {
  it("routes flagged feeds away from the scheduled run and to the local one", async () => {
    const { workerFeeds, localFeeds } = await import("../src/news/ingest/rss");
    const feeds = [
      { id: "normal", url: "https://a.example/feed.xml" },
      { id: "huggingface", url: "https://huggingface.co/blog/feed.xml", local: true },
      { id: "off", url: "https://b.example/feed.xml", local: true, enabled: false },
    ];
    expect(workerFeeds(feeds).map((f) => f.id)).toEqual(["normal"]);
    expect(localFeeds(feeds).map((f) => f.id)).toEqual(["huggingface"]);
  });

  it("accepts a pushed rss item but still refuses a forged human post", async () => {
    const { PushPayloadSchema } = await import("../src/news/ingest/push");
    const item = (origin: string) => ({
      stories: [{
        origin, externalId: "huggingface:1", title: "A post on the HF blog",
        url: "https://huggingface.co/blog/x", externalUrl: null, points: null,
        comments: null, createdAt: "2026-07-26T00:00:00.000Z", author: null, topics: ["software"],
      }],
    });
    expect(PushPayloadSchema.safeParse(item("rss")).success).toBe(true);
    expect(PushPayloadSchema.safeParse(item("bay")).success).toBe(false);
  });

  it("every locally-flagged feed's origin is actually pushable", async () => {
    // A feed flagged `local` that pushes as a non-allowlisted origin would be
    // harvested every run and rejected every run, silently.
    const { PUSHABLE_ORIGINS } = await import("../src/news/ingest/push");
    expect(PUSHABLE_ORIGINS).toContain("rss");
  });
});
