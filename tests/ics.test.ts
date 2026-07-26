import { describe, it, expect } from "vitest";
import { parseIcs, generateIcs } from "../src/integrations/ics";

const cal = (...vevents: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN", ...vevents, "END:VCALENDAR"].join("\r\n");
const vevent = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("parseIcs — RFC-5545 import backbone (Luma / Meetup / Calendar)", () => {
  it("parses a complete VEVENT into normalized fields", () => {
    const ics = cal(vevent([
      "UID:evt-1@luma",
      "SUMMARY:AI Founders Dinner",
      "DESCRIPTION:An evening for founders",
      "DTSTART:20260801T180000Z",
      "DTEND:20260801T210000Z",
      "LOCATION:DNA Lounge",
      "URL:https://lu.ma/e/1",
    ]));
    const [e] = parseIcs(ics);
    expect(e).toMatchObject({
      externalId: "evt-1@luma",
      title: "AI Founders Dinner",
      description: "An evening for founders",
      startUtc: "2026-08-01T18:00:00.000Z",
      endUtc: "2026-08-01T21:00:00.000Z",
      venueName: "DNA Lounge",
      url: "https://lu.ma/e/1",
      allDay: false,
    });
  });

  it("converts a TZID wall-clock time to the correct UTC instant (DST-aware)", () => {
    // 18:00 in America/Los_Angeles on Aug 1 = PDT (UTC-7) = 01:00 UTC next day
    const [e] = parseIcs(cal(vevent(["UID:z", "SUMMARY:X", "DTSTART;TZID=America/New_York:20260801T120000"])));
    expect(e!.startUtc).toBe("2026-08-01T16:00:00.000Z"); // EDT = UTC-4
  });

  it("handles all-day events (VALUE=DATE and bare YYYYMMDD)", () => {
    const [a] = parseIcs(cal(vevent(["UID:a", "SUMMARY:All Day", "DTSTART;VALUE=DATE:20260801"])));
    expect(a).toMatchObject({ allDay: true, startUtc: "2026-08-01T00:00:00.000Z" });
    const [b] = parseIcs(cal(vevent(["UID:b", "SUMMARY:Bare", "DTSTART:20260801"])));
    expect(b!.allDay).toBe(true);
  });

  it("unfolds RFC-5545 folded lines (a leading space continues the prior line)", () => {
    const ics = cal(vevent([
      "UID:fold",
      "SUMMARY:A very long title that the calendar",
      "  wrapped across two physical lines",
      "DTSTART:20260801T180000Z",
    ]).replace("A very long title that the calendar\r\n  wrapped", "A very long title that the calendar\r\n  wrapped"));
    const [e] = parseIcs(ics);
    expect(e!.title).toContain("wrapped across two physical lines");
  });

  it("unescapes ICS text escapes (\\, \\; \\n)", () => {
    const [e] = parseIcs(cal(vevent(["UID:esc", "SUMMARY:Rock\\, Paper\\; Scissors\\nRound 2", "DTSTART:20260801T180000Z"])));
    expect(e!.title).toBe("Rock, Paper; Scissors\nRound 2");
  });

  it("captures RRULE and parses several events in one calendar", () => {
    const ics = cal(
      vevent(["UID:1", "SUMMARY:One", "DTSTART:20260801T180000Z", "RRULE:FREQ=WEEKLY"]),
      vevent(["UID:2", "SUMMARY:Two", "DTSTART:20260808T180000Z"]),
    );
    const evs = parseIcs(ics);
    expect(evs.length).toBe(2);
    expect(evs[0]!.rrule).toBe("FREQ=WEEKLY");
  });

  it("skips VEVENTs missing the essentials (UID or DTSTART)", () => {
    const ics = cal(
      vevent(["SUMMARY:No UID", "DTSTART:20260801T180000Z"]),
      vevent(["UID:noDate", "SUMMARY:No Date"]),
      vevent(["UID:ok", "SUMMARY:Good", "DTSTART:20260801T180000Z"]),
    );
    const evs = parseIcs(ics);
    expect(evs.map((e) => e.externalId)).toEqual(["ok"]);
  });

  it("round-trips through generateIcs → parseIcs", () => {
    const out = generateIcs([{ id: "x1", title: "My Event; Special", startUtc: "2026-08-01T18:00:00Z", endUtc: "2026-08-01T20:00:00Z", venueName: "The Hall", url: "https://ex/e" }], { name: "Mine" });
    expect(out).toContain("BEGIN:VCALENDAR");
    const [e] = parseIcs(out);
    expect(e).toMatchObject({ title: "My Event; Special", venueName: "The Hall", url: "https://ex/e", startUtc: "2026-08-01T18:00:00.000Z" });
  });
});
