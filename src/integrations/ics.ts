/**
 * iCalendar (RFC 5545) generate + parse — the core of calendar sync.
 * `generateIcs` powers the subscribable feed of your RSVPs; `parseIcs` powers
 * importing a Luma/Google/Outlook `.ics` into the platform. Both are pure.
 *
 * The parser pulls in EVERYTHING a source gives us: title, start/end, all-day,
 * description, location, geo, organizer, categories, status, recurrence, url —
 * with correct RFC-5545 line **unfolding** and TZID→UTC conversion (real
 * calendars fold long descriptions and emit local times, not UTC).
 */

export interface IcsEvent {
  id: string;
  title: string;
  startUtc: string; // ISO
  endUtc?: string | null;
  venueName?: string | null;
  url?: string | null;
}
export interface ParsedIcsEvent {
  externalId: string;
  title: string;
  startUtc: string; // ISO
  endUtc: string | null; // ISO
  allDay: boolean;
  description: string | null;
  venueName: string | null;
  lat: number | null;
  lng: number | null;
  organizer: string | null;
  categories: string[];
  status: string | null; // CONFIRMED | TENTATIVE | CANCELLED
  url: string | null;
  rrule: string | null; // raw recurrence rule
}

const esc = (s: string) =>
  String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const unesc = (s: string) =>
  s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

/** ISO → compact UTC "YYYYMMDDTHHMMSSZ". */
const compact = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

// ── date parsing (Z / all-day DATE / TZID-local) ──────────────────────────────
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - utcMs; // how far ahead the zone's wall-clock is vs UTC
}
/** Interpret a wall-clock time in `tz` as a UTC instant (DST-aware within tolerance). */
function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMs(tz, guess);
  let utc = guess - off;
  const off2 = tzOffsetMs(tz, utc);
  if (off2 !== off) { off = off2; utc = guess - off; }
  return utc;
}
/** Parse an ICS date/date-time value + its params into { iso, allDay }. */
function parseIcsDate(value: string, params: Record<string, string>): { iso: string | null; allDay: boolean } {
  const v = value.trim();
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || params.VALUE === "DATE") {
    const m = dateOnly || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return { iso: null, allDay: true };
    return { iso: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString(), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return { iso: null, allDay: false };
  const [, Y, Mo, D, H, Mi, S, Z] = m;
  if (Z) return { iso: new Date(Date.UTC(+Y!, +Mo! - 1, +D!, +H!, +Mi!, +S!)).toISOString(), allDay: false };
  if (params.TZID) {
    // zonedWallToUtc takes a 1-based month (it subtracts internally).
    try { return { iso: new Date(zonedWallToUtc(+Y!, +Mo!, +D!, +H!, +Mi!, +S!, params.TZID)).toISOString(), allDay: false }; }
    catch { /* unknown tz → fall through to floating */ }
  }
  // floating time (no Z, no TZID): best-effort treat as UTC
  return { iso: new Date(Date.UTC(+Y!, +Mo! - 1, +D!, +H!, +Mi!, +S!)).toISOString(), allDay: false };
}

export function generateIcs(events: IcsEvent[], opts: { name?: string; prodId?: string } = {}): string {
  const dtstamp = compact(new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//The Bay//${opts.prodId || "thebay.events"}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (opts.name) lines.push(`X-WR-CALNAME:${esc(opts.name)}`);
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@thebay.events`, `DTSTAMP:${dtstamp}`, `DTSTART:${compact(e.startUtc)}`);
    if (e.endUtc) lines.push(`DTEND:${compact(e.endUtc)}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.venueName) lines.push(`LOCATION:${esc(e.venueName)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** Unfold RFC-5545 folded lines: a CRLF followed by space/tab continues the prior line. */
function unfold(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

export function parseIcs(text: string): ParsedIcsEvent[] {
  const items: ParsedIcsEvent[] = [];
  let cur: (Partial<ParsedIcsEvent> & { _allDay?: boolean }) | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") cur = { categories: [] };
    else if (line === "END:VEVENT") {
      if (cur && cur.externalId && cur.startUtc) {
        items.push({
          externalId: cur.externalId,
          title: cur.title || "",
          startUtc: cur.startUtc,
          endUtc: cur.endUtc ?? null,
          allDay: !!cur.allDay,
          description: cur.description ?? null,
          venueName: cur.venueName ?? null,
          lat: cur.lat ?? null,
          lng: cur.lng ?? null,
          organizer: cur.organizer ?? null,
          categories: cur.categories ?? [],
          status: cur.status ?? null,
          url: cur.url ?? null,
          rrule: cur.rrule ?? null,
        });
      }
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const head = line.slice(0, idx);
      const val = line.slice(idx + 1);
      const [key, ...paramParts] = head.split(";");
      const params: Record<string, string> = {};
      for (const p of paramParts) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); }
      switch (key) {
        case "UID": cur.externalId = val; break;
        case "SUMMARY": cur.title = unesc(val); break;
        case "DESCRIPTION": cur.description = unesc(val); break;
        case "DTSTART": { const d = parseIcsDate(val, params); cur.startUtc = d.iso ?? undefined; cur.allDay = d.allDay; break; }
        case "DTEND": { const d = parseIcsDate(val, params); cur.endUtc = d.iso; break; }
        case "LOCATION": cur.venueName = unesc(val); break;
        case "GEO": { const [la, ln] = val.split(";").map(Number); if (Number.isFinite(la) && Number.isFinite(ln)) { cur.lat = la!; cur.lng = ln!; } break; }
        case "ORGANIZER": cur.organizer = params.CN ? unesc(params.CN) : val.replace(/^mailto:/i, ""); break;
        case "CATEGORIES": cur.categories = val.split(/(?<!\\),/).map((c) => unesc(c).trim()).filter(Boolean); break;
        case "STATUS": cur.status = val.trim().toUpperCase(); break;
        case "URL": cur.url = val; break;
        case "RRULE": cur.rrule = val; break;
      }
    }
  }
  return items;
}
