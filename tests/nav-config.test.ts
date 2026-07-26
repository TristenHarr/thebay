import { describe, it, expect } from "vitest";
import { SECTIONS, sectionFor, activeItem, visibleItems, allDestinations } from "../web/src/app/nav";

/**
 * The nav config is the only thing that decides where a screen lives, and the
 * header, mobile bar, tab strips and command palette all derive from it. So the
 * resolver is load-bearing: get `sectionFor` wrong and the wrong tab strip renders
 * on a URL, which reads as the app losing your place.
 */
describe("nav config", () => {
  it("gives every section at least one tab and a reachable entry point", () => {
    for (const s of SECTIONS) {
      expect(s.items.length).toBeGreaterThan(0);
      // The section link must point at one of its own tabs, or the strip renders
      // with nothing active.
      expect(s.items.some((i) => i.to === s.to)).toBe(true);
    }
  });

  it("has no duplicate destinations across sections — one home per screen", () => {
    const all = allDestinations().map((d) => d.to);
    expect(new Set(all).size).toBe(all.length);
  });

  it("has unique section ids", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("sectionFor", () => {
    it.each([
      ["/", "discover"],
      ["/discover", "discover"],
      ["/map", "discover"],
      ["/itinerary", "discover"],
      ["/host", "discover"],
      ["/city", "city"],
      ["/nav", "city"],
      ["/friends", "people"],
      ["/groups", "people"],
      ["/intros", "people"],
      ["/communities", "people"],
      ["/impact", "signal"],
      ["/companies", "signal"],
      ["/leaderboard", "signal"],
      ["/me", "me"],
      ["/goals", "me"],
      ["/agent", "me"],
    ])("puts %s in %s", (path, expected) => {
      expect(sectionFor(path)?.id).toBe(expected);
    });

    it("keeps detail routes inside their section", () => {
      // A detail page that dropped its tab strip would look like a different app.
      expect(sectionFor("/event/01ABC")?.id).toBe("discover");
      expect(sectionFor("/event/01ABC/vibe")?.id).toBe("discover");
      expect(sectionFor("/group/01ABC")?.id).toBe("people");
      expect(sectionFor("/community/01ABC")?.id).toBe("people");
      expect(sectionFor("/u/ann")?.id).toBe("people");
      expect(sectionFor("/company/acme-robotics")?.id).toBe("signal");
    });

    it("resolves /network-graph to Signal, not People, despite the /network prefix", () => {
      // Longest-match, so this can't be decided by array order.
      expect(sectionFor("/network-graph")?.id).toBe("signal");
      expect(sectionFor("/network")?.id).toBe("people");
    });

    it("does not let '/' swallow every unknown path", () => {
      expect(sectionFor("/")?.id).toBe("discover");
      expect(sectionFor("/signin")).toBeNull();
      expect(sectionFor("/totally-unknown")).toBeNull();
    });

    it("is not fooled by a prefix that isn't a path segment", () => {
      // "/mapyard" must not match "/map".
      expect(sectionFor("/mapyard")).toBeNull();
      expect(sectionFor("/cityscape")).toBeNull();
    });
  });

  describe("activeItem", () => {
    it("highlights the tab whose route is showing", () => {
      const people = SECTIONS.find((s) => s.id === "people")!;
      expect(activeItem(people, "/intros")?.label).toBe("Intros");
    });

    it("highlights the list tab on a singular detail route", () => {
      // /group/:id, /community/:id and /company/:slug are the singular of their
      // list route — a strip with nothing active reads as a lost position.
      const people = SECTIONS.find((s) => s.id === "people")!;
      const signal = SECTIONS.find((s) => s.id === "signal")!;
      expect(activeItem(people, "/group/01ABC")?.label).toBe("Groups");
      expect(activeItem(people, "/community/01ABC")?.label).toBe("Communities");
      expect(activeItem(people, "/u/ann")?.label).toBe("Friends");
      expect(activeItem(signal, "/company/acme-robotics")?.label).toBe("Companies");
    });

    it("returns null when a section route has no matching tab", () => {
      const discover = SECTIONS.find((s) => s.id === "discover")!;
      expect(activeItem(discover, "/event/01ABC")).toBeNull();
    });
  });

  describe("visibleItems", () => {
    it("hides auth-only tabs from signed-out visitors", () => {
      const people = SECTIONS.find((s) => s.id === "people")!;
      // Every People tab needs an account, so a signed-out visitor gets no strip
      // rather than six doors that all lead to a sign-in prompt.
      expect(visibleItems(people, false)).toHaveLength(0);
      expect(visibleItems(people, true).length).toBeGreaterThan(0);
    });

    it("keeps public tabs visible when signed out", () => {
      const discover = SECTIONS.find((s) => s.id === "discover")!;
      const labels = visibleItems(discover, false).map((i) => i.label);
      expect(labels).toContain("Feed");
      expect(labels).toContain("Map");
      expect(labels).not.toContain("Host");
    });

    it("shows Signal's public boards to signed-out visitors", () => {
      const signal = SECTIONS.find((s) => s.id === "signal")!;
      const labels = visibleItems(signal, false).map((i) => i.label);
      // Public-by-default attribution is the product decision; the boards are
      // readable without an account.
      expect(labels).toEqual(["Impact", "Companies", "Rankings"]);
    });
  });
});
