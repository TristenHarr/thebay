import { describe, it, expect } from "vitest";
import { KeywordTagger } from "../src/ai/keyword-tagger";
import { loadCategories } from "../src/config/load";

const tagger = new KeywordTagger(loadCategories());
async function tag(title: string, description: string | null = null, organizer: string | null = null) {
  const [r] = await tagger.tag([{ id: "x", title, description, organizer }]);
  return r!;
}

describe("keyword tagger — good tags (word-boundary matches, not substrings)", () => {
  it("does NOT false-match short keywords inside longer words", async () => {
    // "ai" lives inside email/chair/retail/available — none of these are software events
    for (const title of ["Email Marketing Workshop", "Chair Yoga in the Park", "Retail Networking Mixer", "Cocktails & Available Seats"]) {
      const r = await tag(title);
      expect(r.categories).not.toContain("software");
      expect(r.categories).not.toContain("hardware");
    }
    // "vc" inside "service", "lp" inside "help", "ml" inside "html"… must not tag vc/software
    expect((await tag("Customer Service Excellence")).categories).not.toContain("vc");
  });

  it("tags the interest categories correctly when the keyword is a real word", async () => {
    expect((await tag("AI Founders Dinner")).categories).toContain("software"); // 'ai' as a word
    expect((await tag("Hardware Hackathon: Robotics & FPGA")).categories).toContain("hardware");
    expect((await tag("Venture Capital 101 for Founders")).categories).toContain("vc");
    expect((await tag("Number Theory & Topology Seminar")).categories).toContain("math");
    expect((await tag("Deep dive into Kubernetes and Docker")).categories).toContain("software");
    expect((await tag("Meet local angel investors")).categories).toContain("vc");
  });

  it("scores interest events higher than generic ones, and never leaves an event untagged", async () => {
    const interesting = await tag("Robotics & Semiconductor Startup Night", "hardware founders and VC investors");
    const generic = await tag("Morning Coffee Meetup");
    expect(interesting.interestScore).toBeGreaterThan(generic.interestScore);
    expect(generic.categories.length).toBeGreaterThan(0); // catch-all 'tech', never empty
    expect(generic.categories).toEqual(["tech"]);
  });

  it("matches multi-word keyword phrases", async () => {
    expect((await tag("A talk on Venture Capital and fundraising")).categories).toContain("vc");
    expect((await tag("Category Theory for Programmers")).categories).toContain("math");
  });

  it("reads description and organizer, not just the title", async () => {
    const r = await tag("Founder Fireside", "An evening about robotics and PCB design", "Hardware Club");
    expect(r.categories).toContain("hardware");
  });
});
