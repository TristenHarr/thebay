import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { generateIcs, parseIcs } from "../src/integrations/ics";
import { parseLinkedInCsv } from "../src/integrations/linkedin";
import { IntegrationsRepo } from "../src/storage/d1/integrations-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

describe("ICS generate/parse (calendar sync)", () => {
  const events = [
    { id: "e1", title: "Founders, Dinner; & Demos", startUtc: "2026-08-15T18:00:00Z", endUtc: "2026-08-15T20:00:00Z", venueName: "Shack15", url: "https://thebay.events/app/event/e1" },
    { id: "e2", title: "AI Infra Meetup", startUtc: "2026-08-20T17:30:00Z" },
  ];

  it("emits a valid VCALENDAR with one VEVENT per event, CRLF, escaped text", () => {
    const ics = generateIcs(events, { name: "The Bay — Ann" });
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(2);
    expect(ics.includes("\r\n")).toBe(true);
    expect(ics).toMatch(/DTSTART:20260815T180000Z/);
    expect(ics).toMatch(/SUMMARY:Founders\\, Dinner\\; & Demos/); // commas + semicolons escaped
    expect(ics).toMatch(/UID:e1@thebay\.events/);
  });

  it("round-trips through parseIcs", () => {
    const parsed = parseIcs(generateIcs(events));
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toMatchObject({ externalId: "e1@thebay.events", title: "Founders, Dinner; & Demos", startUtc: "2026-08-15T18:00:00.000Z" });
    expect(parsed[1]?.title).toBe("AI Infra Meetup");
  });

  it("parses a foreign .ics (import path)", () => {
    const foreign = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:luma-abc", "SUMMARY:Luma Party", "DTSTART:20260901T010000Z", "LOCATION:SF", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const items = parseIcs(foreign);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "luma-abc", title: "Luma Party", startUtc: "2026-09-01T01:00:00.000Z", venueName: "SF", url: null });
  });

  it("pulls in ALL the data: description, end, geo, organizer, categories, status, rrule", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:full-1",
      "SUMMARY:Founder Dinner",
      "DESCRIPTION:Line one\\nLine two with a \\, comma",
      "DTSTART:20260901T010000Z",
      "DTEND:20260901T030000Z",
      "LOCATION:Shack15\\, SF",
      "GEO:37.7955;-122.3937",
      "ORGANIZER;CN=Chris P:mailto:chris@x.com",
      "CATEGORIES:AI,Infra,Founders",
      "STATUS:CONFIRMED",
      "URL:https://lu.ma/x",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [e] = parseIcs(ics);
    expect(e).toMatchObject({
      externalId: "full-1",
      title: "Founder Dinner",
      description: "Line one\nLine two with a , comma",
      startUtc: "2026-09-01T01:00:00.000Z",
      endUtc: "2026-09-01T03:00:00.000Z",
      venueName: "Shack15, SF",
      lat: 37.7955, lng: -122.3937,
      organizer: "Chris P",
      categories: ["AI", "Infra", "Founders"],
      status: "CONFIRMED",
      url: "https://lu.ma/x",
      rrule: "FREQ=WEEKLY;COUNT=4",
      allDay: false,
    });
  });

  it("unfolds RFC-5545 folded lines (real calendars fold long descriptions)", () => {
    // Fold a real property line the way a serializer does: split into ≤N-byte
    // chunks joined by CRLF + a single space. Unfolding must reproduce it exactly.
    const fold = (prop: string, n = 40) => {
      let out = prop.slice(0, n);
      for (let i = n; i < prop.length; i += n - 1) out += "\r\n " + prop.slice(i, i + n - 1);
      return out;
    };
    const desc = "This is a very long description that a real calendar would fold across multiple physical lines to stay under 75 octets.";
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:fold-1", "SUMMARY:Folded", "DTSTART:20260901T010000Z",
      fold("DESCRIPTION:" + desc), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const [e] = parseIcs(ics);
    expect(e!.description).toBe(desc);
  });

  it("converts a TZID-local time to the correct UTC instant (not treated as UTC)", () => {
    // 6pm Los Angeles on 2026-09-01 is PDT (UTC-7) → 2026-09-02T01:00Z.
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:tz-1", "SUMMARY:LA Dinner",
      "DTSTART;TZID=America/Los_Angeles:20260901T180000", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const [e] = parseIcs(ics);
    expect(e!.startUtc).toBe("2026-09-02T01:00:00.000Z");
  });

  it("marks all-day events (VALUE=DATE / bare date)", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ad-1", "SUMMARY:All Day", "DTSTART;VALUE=DATE:20260901", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const [e] = parseIcs(ics);
    expect(e!.allDay).toBe(true);
    expect(e!.startUtc).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("LinkedIn Connections.csv import", () => {
  const csv = [
    "Notes:",
    "\"When exporting your connection data, you may notice...\"",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Founder,01 Jan 2026",
    "Grace,Hopper,https://linkedin.com/in/grace,grace@navy.mil,US Navy,Rear Admiral,02 Feb 2026",
    "\"Quoted, Name\",Person,https://linkedin.com/in/qp,,\"Big, Corp\",CEO,03 Mar 2026",
    "",
  ].join("\n");

  it("skips the preamble, parses quoted fields, and captures every column", () => {
    const items = parseLinkedInCsv(csv);
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({
      externalId: "https://linkedin.com/in/ada",
      kind: "connection",
      payload: { name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", company: "Analytical Engines", position: "Founder", url: "https://linkedin.com/in/ada", email: "", connectedOn: "01 Jan 2026" },
    });
    expect(items[1]!.payload.email).toBe("grace@navy.mil"); // email column captured
    expect(items[2]!.payload.name).toBe("Quoted, Name Person"); // quoted comma preserved
    expect(items[2]!.payload.company).toBe("Big, Corp");
  });

  it("returns nothing when there's no header row", () => {
    expect(parseLinkedInCsv("just,some,random\n1,2,3")).toEqual([]);
  });
});

describe("IntegrationsRepo (accounts + dedup import)", () => {
  let d1: any, raw: Database.Database, repo: IntegrationsRepo, social: SocialRepo;
  beforeEach(() => {
    ({ d1, raw } = makeTestDb());
    repo = new IntegrationsRepo(d1);
    social = new SocialRepo(d1);
  });

  it("connects an account and imports items idempotently", async () => {
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    await repo.connectAccount(u.id, "luma", { token: "t" });
    expect((await repo.listAccounts(u.id)).map((a) => a.provider)).toContain("luma");

    const items = [
      { externalId: "L1", kind: "event", payload: { title: "One" } },
      { externalId: "L2", kind: "event", payload: { title: "Two" } },
    ];
    expect(await repo.importItems(u.id, "luma", items)).toBe(2);
    expect(await repo.importItems(u.id, "luma", items)).toBe(0); // re-import dedups
    expect((await repo.listImported(u.id, "luma")).length).toBe(2);
  });
});

describe("import parser edge cases (real-world exports)", () => {
  it("parseIcs strips DTSTART;TZID params and skips a VEVENT with no UID", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:has-uid", "SUMMARY:With TZID", "DTSTART;TZID=America/Los_Angeles:20260901T180000", "END:VEVENT",
      "BEGIN:VEVENT", "SUMMARY:No UID here", "DTSTART:20260902T180000Z", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const items = parseIcs(ics);
    expect(items.map((i) => i.externalId)).toEqual(["has-uid"]); // UID-less event skipped
    expect(items[0]!.startUtc).toBeTruthy();
  });

  it("parseLinkedInCsv handles CRLF and a header missing the URL column", () => {
    const csv = ["Notes:", "", "First Name,Last Name,Company,Position,Connected On", "Ada,Lovelace,Analytical,Founder,01 Jan 2026", ""].join("\r\n");
    const items = parseLinkedInCsv(csv);
    expect(items.length).toBe(1);
    expect(items[0]!.externalId).toBe("Ada Lovelace"); // no URL column → falls back to name
    expect(items[0]!.payload.url).toBe("");
  });
});
