/**
 * Identity resolution — candidate generation, pure.
 *
 * A Form D names "Ann Lee, Executive Officer". Somewhere on this platform there
 * may be a member who IS that Ann Lee. Connecting the two is the single most
 * consequential inference in the whole track, because the output is published:
 * "@annlee raised $4.2M" is a claim about a real, identifiable person, and if
 * the match is wrong it is a false claim about them.
 *
 * So the pipeline is deliberately shaped so that no machine can complete it:
 *
 *   1. THIS FILE generates candidates from signals you can read in the code —
 *      normalized name, company domain ↔ email domain, the LinkedIn company and
 *      position the importer has been storing all along, a prior self-declaration.
 *   2. A model may REORDER those candidates ({@link applyRanking}) and nothing
 *      else. It cannot add a person, cannot change a score, cannot write a link.
 *   3. The person themselves confirms. Only that sets `company_people.user_id`,
 *      and the schema (migration 0018) refuses the row otherwise.
 *
 * Nothing in this module returns a link. It returns questions to ask.
 */
import { normalizePersonName, normalizeCompanyName, emailDomain, isFreeEmailDomain } from "./normalize";

/** A person as a filing names them. */
export interface PersonRef {
  name: string;
  /** The filing's relationship word: 'Executive Officer' | 'Director' | 'Promoter'. */
  role: string;
}

export interface CompanyRef {
  id?: string;
  name: string;
  domain?: string | null;
}

export interface UserRef {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  /** imported_items.payload_json.$.company — written by the LinkedIn importer. */
  importedCompany?: string | null;
  /** imported_items.payload_json.$.position — likewise. */
  importedPosition?: string | null;
  /** Companies this member has already said they work at (user_companies). */
  declaredCompanyIds?: string[];
}

export interface Candidate {
  userId: string;
  handle: string;
  displayName: string;
  /** 0…<1. Never 1: a generated candidate is never a certainty. */
  score: number;
  /** Every signal that contributed, so the UI can show its working. */
  signals: string[];
}

/** Below this, don't even ask. */
export const CANDIDATE_FLOOR = 0.25;

/** Signal weights. Flat and legible on purpose — this is not a learned model. */
const W = {
  nameExact: 0.5,
  nameInitial: 0.25,
  emailDomain: 0.3,
  linkedinCompany: 0.25,
  linkedinPosition: 0.1,
  declared: 0.3,
} as const;

/** Words a LinkedIn position uses for each Form D relationship. */
const ROLE_WORDS: Array<[RegExp, RegExp]> = [
  [/executive|officer/i, /\b(ceo|cto|coo|cfo|cro|chief|founder|co-?founder|president|vp|head)\b/i],
  [/director|board/i, /\b(director|board|chair)\b/i],
  [/promoter/i, /\b(founder|co-?founder|promoter|partner|principal)\b/i],
];

function nameSignal(person: string, user: string): { signal: string; weight: number } | null {
  const a = normalizePersonName(person);
  const b = normalizePersonName(user);
  if (!a || !b) return null;
  if (a === b) return { signal: "name:exact", weight: W.nameExact };
  const pa = a.split(" ");
  const pb = b.split(" ");
  const lastA = pa[pa.length - 1];
  const lastB = pb[pb.length - 1];
  // Same surname AND the same first initial. Weaker, still worth asking about
  // ("A. Lee" is plausibly "Ann Lee"), never strong enough to stand alone as truth.
  if (lastA && lastA === lastB && pa[0]?.[0] && pa[0][0] === pb[0]?.[0]) {
    return { signal: "name:initial", weight: W.nameInitial };
  }
  return null;
}

/**
 * Candidates for one (person, company) pair, strongest first. A NAME SIGNAL IS
 * MANDATORY: a colleague on the company domain who is plainly someone else is
 * not a candidate, however well the domain matches.
 */
export function generateCandidates(person: PersonRef, company: CompanyRef, users: UserRef[]): Candidate[] {
  if (!person?.name || !Array.isArray(users)) return [];
  const companyNorm = normalizeCompanyName(company?.name);
  const companyDomain = (company?.domain ?? "").toLowerCase().trim() || null;
  const out: Candidate[] = [];

  for (const u of users) {
    const nameHit = nameSignal(person.name, u.displayName);
    if (!nameHit) continue; // the gate

    const signals = [nameHit.signal];
    let score = nameHit.weight;

    const ud = emailDomain(u.email);
    if (companyDomain && ud && ud === companyDomain && !isFreeEmailDomain(ud)) {
      signals.push("domain:email");
      score += W.emailDomain;
    }
    if (companyNorm && u.importedCompany && normalizeCompanyName(u.importedCompany) === companyNorm) {
      signals.push("linkedin:company");
      score += W.linkedinCompany;
      // Position only counts when we already believe the company — a "Director"
      // somewhere else says nothing about this filing.
      const pos = u.importedPosition ?? "";
      if (ROLE_WORDS.some(([role, words]) => role.test(person.role) && words.test(pos))) {
        signals.push("linkedin:position");
        score += W.linkedinPosition;
      }
    }
    if (company?.id && (u.declaredCompanyIds ?? []).includes(company.id)) {
      signals.push("declared:company");
      score += W.declared;
    }

    // Asymptotic cap: however many signals line up, this is still a question.
    const capped = Math.min(0.99, Math.round(score * 100) / 100);
    if (capped >= CANDIDATE_FLOOR) out.push({ userId: u.id, handle: u.handle, displayName: u.displayName, score: capped, signals });
  }

  // Stable: score desc, then userId asc, so the same inputs always order the same.
  return out.sort((a, b) => b.score - a.score || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/**
 * Apply a model's ordering to an existing candidate set.
 *
 * The ONLY thing a model is allowed to do in identity resolution. Ids it invented
 * are dropped, candidates it forgot are kept (in their deterministic order), and
 * scores are untouched — so the worst a bad ranking can do is put the right
 * person second.
 */
export function applyRanking(candidates: Candidate[], rankedUserIds: string[]): Candidate[] {
  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const out: Candidate[] = [];
  const used = new Set<string>();
  for (const id of Array.isArray(rankedUserIds) ? rankedUserIds : []) {
    const c = byId.get(id);
    if (c && !used.has(id)) {
      used.add(id);
      out.push(c);
    }
  }
  for (const c of candidates) if (!used.has(c.userId)) out.push(c);
  return out;
}

/** The question a candidate becomes. Rendered verbatim — it must be answerable. */
export function confirmationQuestion(person: PersonRef, company: CompanyRef): string {
  return `Are you the ${person.name} listed as ${person.role} of ${company.name} on this Form D?`;
}
