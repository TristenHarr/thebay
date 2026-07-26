/**
 * Normalization for the funding graph — pure string work, no I/O.
 *
 * Two companies with the same name and different punctuation must converge on
 * one row, and "Ann Lee" on a Form D must be comparable to "Dr. Ann Lee, Jr." in
 * a profile. Everything here is deliberately conservative: it lowercases, strips
 * decoration, and stops. It never guesses that two different names are the same
 * person — that judgement belongs to the person, not to a normalizer.
 */

/** Legal-entity suffixes that carry no identity. */
const COMPANY_SUFFIXES =
  /\b(inc|incorporated|llc|l\.?l\.?c|ltd|limited|corp|corporation|co|company|lp|l\.?p|llp|plc|gmbh|sa|nv|bv|pbc|holdings|group)\b/g;

const NAME_TITLES = /^(mr|mrs|ms|miss|dr|prof|sir|rev)\b\.?\s+/;
const NAME_SUFFIXES = /\b(jr|sr|ii|iii|iv|v|phd|md|esq|cpa)\b\.?/g;

const strip = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, ""); // drop combining accents left by NFKD

/** Comparable form of a person's name: "Dr. Ann Lee, Jr." → "ann lee". */
export function normalizePersonName(name: unknown): string {
  let s = strip(name).replace(/[.,]/g, " ");
  s = s.replace(NAME_TITLES, " ");
  s = ` ${s} `.replace(NAME_SUFFIXES, " ");
  return s
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Comparable form of a company name: "Acme Robotics & Co, Inc." → "acme robotics". */
export function normalizeCompanyName(name: unknown): string {
  const s = strip(name)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ` ${s} `
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** URL-safe company identity: /company/<slug>. Uniqueness is the DB's job. */
export function companySlug(name: unknown): string {
  return normalizeCompanyName(name).replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

/**
 * Mailbox providers. A shared free-mail domain says nothing about employment, so
 * a domain match against one of these is not a signal — treating it as one would
 * make every gmail user a candidate for every company.
 */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "fastmail.com", "hey.com", "zoho.com", "gmx.com", "mail.com", "duck.com", "yandex.com", "qq.com",
]);

export function isFreeEmailDomain(domain: unknown): boolean {
  return FREE_EMAIL_DOMAINS.has(String(domain ?? "").toLowerCase().trim());
}

/** Bare lowercased domain from an email address, or null. */
export function emailDomain(email: unknown): string | null {
  const m = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(String(email ?? "").trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Bare lowercased host from a URL, `www.` removed, or null. */
export function domainFromUrl(url: unknown): string | null {
  try {
    const h = new URL(String(url ?? "")).hostname.toLowerCase();
    return h.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
