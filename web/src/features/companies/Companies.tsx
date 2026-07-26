import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useGetCompaniesQuery,
  useGetCompanyMatchesQuery,
  useConfirmCompanyPersonMutation,
  useGetMyCompaniesQuery,
  useDeclareCompanyMutation,
  useImportMyCompaniesMutation,
} from "../../api";
import { Button, Card, PageHeader, Spinner, EmptyState, Badge, Field, input } from "../../ui/kit";
import { formatUsd } from "../../../../src/core/attribution/ledger";

/**
 * The funding directory — Bay Area companies as they file with the SEC, days to
 * weeks before anyone writes about the round.
 *
 * Also the home of identity resolution, which is why the "Is this you?" block
 * sits at the top rather than buried in settings: a filing name only becomes a
 * @handle when the person answers the question, and they can only answer it if
 * they are shown it.
 */
export function Companies({ me }: { me?: any }) {
  const [q, setQ] = useState("");
  const { data, isLoading } = useGetCompaniesQuery(`?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`);

  return (
    <div data-testid="companies">
      <PageHeader title="Funding" sub="Bay Area companies, as they file. Sourced from SEC Form D." />
      {me && <ClaimMatches />}
      {me && <MyEmployment />}

      <input className={`${input} mb-4`} placeholder="Search companies…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search companies" />

      {isLoading ? <Spinner /> : (
        <ol className="flex flex-col gap-2" data-testid="company-list">
          {(data?.companies ?? []).map((c: any) => (
            <Card key={c.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <Link to={`/company/${c.slug}`} className="font-semibold hover:text-accent">{c.name}</Link>
                <p className="truncate text-xs text-muted">
                  {[c.city, c.industry, c.yearFounded ? `founded ${c.yearFounded}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {c.latestAmountUsd != null && <span className="font-mono text-sm text-gold">{formatUsd(c.latestAmountUsd)}</span>}
            </Card>
          ))}
          {!data?.companies.length && <EmptyState title="No companies yet" hint="Filings land here within minutes of hitting EDGAR." />}
        </ol>
      )}
    </div>
  );
}

/**
 * "Are you the Ann Lee listed as Executive Officer of Acme Robotics on this
 * Form D?" — the only path by which an account is ever attached to a filing.
 * Candidates are generated deterministically and shown with their reasons; the
 * answer is the member's.
 */
function ClaimMatches() {
  const { data, isLoading } = useGetCompanyMatchesQuery();
  const [confirm, { isLoading: saving }] = useConfirmCompanyPersonMutation();
  if (isLoading || !data?.matches.length) return null;

  return (
    <section className="mb-5" data-testid="company-matches">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Is this you?</h2>
      <div className="flex flex-col gap-2">
        {data.matches.map((m: any) => (
          <Card key={`${m.person.companyId}|${m.person.personName}|${m.person.role}`} className="p-3">
            <p className="text-sm">{m.question}</p>
            <p className="mt-1 text-xs text-muted">
              Matched on {m.candidate.signals.join(", ")} · we are {Math.round(m.candidate.score * 100)}% sure, which is why we are asking rather than assuming.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                disabled={saving}
                onClick={() => confirm({ companyId: m.person.companyId, personName: m.person.personName, role: m.person.role })}
                data-testid="confirm-match"
              >
                Yes, that's me
              </Button>
              <Link to={`/company/${m.company.slug}`} className="text-xs text-muted hover:text-accent">See the filing →</Link>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** Where you work. `users` has no company field, so this is the first structured
 *  answer — and the signal that lets a future filing find you. */
function MyEmployment() {
  const { data } = useGetMyCompaniesQuery();
  const [declare, { isLoading: saving }] = useDeclareCompanyMutation();
  const [adopt, { isLoading: importing, data: adopted }] = useImportMyCompaniesMutation();
  const [name, setName] = useState("");
  const [role, setRole] = useState("founder");
  const [title, setTitle] = useState("");

  return (
    <section className="mb-5" data-testid="my-companies">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Where you work</h2>
      <div className="mb-2 flex flex-wrap gap-2">
        {(data?.companies ?? []).map((c: any) => (
          <Link key={`${c.companyId}|${c.role}`} to={`/company/${c.slug}`} className="rounded-full border border-border px-3 py-1 text-sm hover:border-accent">
            {c.name}
            <span className="ml-1 text-xs text-muted">{c.title || c.role}</span>
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Company"><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Robotics" /></Field>
        <Field label="Role"><input className={input} value={role} onChange={(e) => setRole(e.target.value)} /></Field>
        <Field label="Title"><input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="CEO" /></Field>
        <Button
          disabled={saving || !name.trim()}
          onClick={async () => { await declare({ name: name.trim(), role: role.trim() || "member", title: title.trim() || undefined }); setName(""); setTitle(""); }}
          data-testid="declare-company"
        >
          Add
        </Button>
        <Button variant="quiet" disabled={importing} onClick={() => adopt()} title="Read the company and position an import already recorded for you">
          {importing ? "Importing…" : "Import from LinkedIn"}
        </Button>
        {adopted != null && <Badge>{adopted.adopted} imported</Badge>}
      </div>
    </section>
  );
}
