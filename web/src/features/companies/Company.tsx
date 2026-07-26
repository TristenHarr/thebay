import { Link, useParams } from "react-router-dom";
import { useGetCompanyQuery, useReleaseCompanyPersonMutation } from "../../api";
import { Card, PageHeader, Spinner, EmptyState, Badge, Button } from "../../ui/kit";
import { formatUsd } from "../../../../src/core/attribution/ledger";

/**
 * One company: its filings, and the people named on them.
 *
 * The people list is where this screen earns its keep. A Form D names executives,
 * directors and promoters, and those names are public record — so we show them.
 * What we do NOT do is attach a @handle to one until that person has confirmed
 * it: an unconfirmed row renders as a name and a role with an explicit note
 * saying so, because "@annlee raised $4.2M" off a fuzzy name match would be
 * publishing a possibly-false claim about a real person.
 */
export function Company({ me }: { me?: any }) {
  const { slug = "" } = useParams();
  const { data, isLoading } = useGetCompanyQuery(slug);
  const [release] = useReleaseCompanyPersonMutation();

  if (isLoading) return <Spinner />;
  if (!data?.company) return <EmptyState title="Company not found" hint="It may not have filed here yet." />;
  const c = data.company;

  return (
    <div data-testid="company">
      <PageHeader
        title={c.name}
        sub={[c.city && c.state ? `${c.city}, ${c.state}` : c.city, c.industry, c.yearFounded ? `founded ${c.yearFounded}` : null].filter(Boolean).join(" · ")}
      />
      <div className="mb-4 flex items-center gap-2">
        <Link to="/companies" className="text-sm text-muted hover:text-accent">← All companies</Link>
        <div className="flex-1" />
        {c.cik && <span className="font-mono text-xs text-muted">CIK {c.cik}</span>}
      </div>

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Rounds</h2>
      <ol className="mb-6 flex flex-col gap-2" data-testid="company-rounds">
        {data.rounds.map((r: any) => (
          <Card key={r.id} className="flex items-center gap-3 p-3">
            <span className="font-mono text-sm text-gold">{r.amountUsd == null ? "—" : formatUsd(r.amountUsd)}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {/* Only a SEC-sourced round may be printed as "Form D". */}
                {r.source === "sec" ? "Form D" : r.stage || r.kind}
                {r.amountSoldUsd != null && r.amountUsd != null && r.amountSoldUsd < r.amountUsd && (
                  <span className="ml-2 text-xs font-normal text-muted">{formatUsd(r.amountSoldUsd)} sold so far</span>
                )}
              </p>
              <p className="text-xs text-muted">
                {[r.filedAt ? `filed ${r.filedAt}` : null, r.firstSaleAt ? `first sale ${r.firstSaleAt}` : null].filter(Boolean).join(" · ")}
              </p>
            </div>
            {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noreferrer nofollow" className="text-xs text-muted hover:text-accent">filing →</a>}
          </Card>
        ))}
        {!data.rounds.length && <EmptyState title="No rounds on file" />}
      </ol>

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">People on the filings</h2>
      <ul className="flex flex-col gap-2" data-testid="company-people">
        {data.people.map((p: any) => (
          <Card key={`${p.personName}|${p.role}`} className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              {p.confirmed && p.handle ? (
                <Link to={`/u/${p.handle}`} className="font-semibold hover:text-accent">{p.displayName || p.personName}</Link>
              ) : (
                <span className="font-semibold">{p.personName}</span>
              )}
              <p className="text-xs text-muted">{p.role}</p>
            </div>
            {p.confirmed ? (
              <>
                <Badge>confirmed</Badge>
                {me && p.userId === me.id && (
                  <Button variant="quiet" className="text-xs" onClick={() => release({ companyId: c.id, personName: p.personName, role: p.role })}>
                    Not me
                  </Button>
                )}
              </>
            ) : (
              // Said out loud rather than implied: this is a name on a document.
              <span className="text-xs text-muted" title="Public record. No account is linked to this name.">listed on the filing</span>
            )}
          </Card>
        ))}
        {!data.people.length && <EmptyState title="No people named" hint="Not every filing lists related persons." />}
      </ul>
    </div>
  );
}
