/**
 * Parse a LinkedIn "Connections.csv" export into importable items.
 *
 * LinkedIn's export begins with a few human-readable "Notes:" preamble lines,
 * then a header row (First Name, Last Name, URL, Email Address, Company,
 * Position, Connected On), then one row per connection. Fields may be quoted.
 */
export interface LinkedInConnection {
  externalId: string;
  kind: "connection";
  payload: { name: string; firstName: string; lastName: string; company: string; position: string; url: string; email: string; connectedOn: string };
}

export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
      else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseLinkedInCsv(text: string): LinkedInConnection[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /First Name/i.test(l) && /Last Name/i.test(l));
  if (headerIdx < 0) return [];
  const cols = splitCsv(lines[headerIdx] ?? "");
  const col = (name: string) => cols.findIndex((c) => c.trim().toLowerCase() === name);
  const fi = col("first name"), li = col("last name"), ci = col("company"), pi = col("position"), ui = col("url");
  const ei = col("email address"), di = col("connected on");
  const at = (f: string[], i: number) => (i >= 0 ? (f[i] ?? "").trim() : "");
  const items: LinkedInConnection[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const f = splitCsv(line);
    const firstName = at(f, fi), lastName = at(f, li);
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!name) continue;
    const url = at(f, ui);
    items.push({
      externalId: url || name,
      kind: "connection",
      payload: { name, firstName, lastName, company: at(f, ci), position: at(f, pi), url, email: at(f, ei), connectedOn: at(f, di) },
    });
  }
  return items;
}
