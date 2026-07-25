/**
 * "Is this address clearly NOT in our region?" — a high-precision noise filter.
 *
 * The wide-net scrapers (esp. Eventbrite's location search) leak in events from
 * other states and countries. Those aren't "good events" for a Bay-Area app, so
 * we drop the ones we can identify with confidence. Precision over recall: we only
 * flag an address whose location is *definitively* elsewhere (a non-CA US state
 * anchored by a ZIP, a UK postcode, or a named foreign country). Missing/ambiguous
 * addresses (online events, Bay events with a bare venue) are always KEPT.
 */

// Every USPS state/territory code EXCEPT CA — a match here means "another state".
const NON_CA_US_STATES = new Set(
  ("AL AK AZ AR CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE " +
    "NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR")
    .split(" "),
);

const FOREIGN_COUNTRY =
  /,\s*(United Kingdom|Scotland|England|Wales|Northern Ireland|Ireland|Canada|Mexico|Australia|New Zealand|Germany|France|Spain|Italy|Netherlands|Portugal|Brazil|Argentina|India|Japan|China|Singapore|South Africa|Nigeria|Kenya|UAE|United Arab Emirates)\.?\s*$/i;

// UK-style postcode, e.g. "KA27 8DL", "SW1A 1AA".
const UK_POSTCODE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2}\b/;

export function looksOutOfRegion(address: string | null | undefined): boolean {
  if (!address) return false;
  // "..., ST 12345" (optionally ZIP+4) where ST is a US state other than CA.
  const us = address.match(/,\s*([A-Za-z]{2})\.?\s+\d{5}(?:-\d{4})?\b/);
  if (us && NON_CA_US_STATES.has(us[1]!.toUpperCase())) return true;
  if (UK_POSTCODE.test(address)) return true;
  if (FOREIGN_COUNTRY.test(address)) return true;
  return false;
}
