import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetNetMeQuery, useGetNetLeaderboardQuery, useGetNetRecipesQuery, useRegisterClientMutation, useRevokeClientMutation } from "../../api";
import { Badge, Button, Card, EmptyState, PageHeader, Spinner, Stat, cx } from "../../ui/kit";

/**
 * Your standing in the scrape network, and how to actually contribute.
 *
 * The catalog used to come off one laptop. This screen is the other end of making it come off
 * everybody's: register a machine or a browser, see what your work was worth, and see which
 * scraper recipes are being trialled right now.
 *
 * Two things this is careful to be honest about. A worker token is shown EXACTLY ONCE, because
 * it is a bearer credential and a page that can re-reveal one is a page that leaks one. And
 * `pending` finds are shown as awaiting a second look rather than as a score — a probation
 * member's sighting is not worth anything until somebody independent confirms it, and implying
 * otherwise would make the first confirmation feel like a loss.
 */

const TIER_BLURB: Record<string, string> = {
  probation: "Your finds count once another worker independently confirms them.",
  trusted: "You publish on your own, and you can vouch for people you meet.",
  core: "You publish on your own, vouch for people, and get first pick of the queue.",
};

const CLIENT_KINDS = [
  { kind: "cli" as const, label: "This machine", hint: "A full browser via Playwright, so it gets the sources a plain fetch can\u2019t" },
  { kind: "extension" as const, label: "This browser", hint: "Chrome extension — your own connection, so sites that block servers don't block you" },
];

export default function Contribute({ me }: { me: any }) {
  const { data, isLoading } = useGetNetMeQuery(undefined, { skip: !me });
  const { data: board } = useGetNetLeaderboardQuery();
  const { data: recipes } = useGetNetRecipesQuery();
  const [register] = useRegisterClientMutation();
  const [revoke] = useRevokeClientMutation();
  const [freshToken, setFreshToken] = useState<{ token: string; kind: string } | null>(null);

  if (!me) {
    return (
      <div className="mx-auto max-w-3xl p-4" data-testid="contribute">
        <PageHeader title="Contribute" sub="Sign in to see your standing in the scrape network." />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-4" data-testid="contribute">
        <Spinner />
      </div>
    );
  }

  const member = data?.member;
  const shadows = (recipes?.recipes ?? []).filter((r: any) => r.status === "shadow" || r.status === "proposed");

  if (!member) {
    return (
      <div className="mx-auto max-w-3xl p-4" data-testid="contribute">
        <PageHeader title="Contribute" sub="The events catalog is scraped by members, from their own machines." />
        <Card className="p-6">
          <h3 className="text-sm font-semibold">You're not in the network yet</h3>
          <p className="mt-2 text-sm text-muted">
            Joining is deliberately a physical thing: you meet somebody who's already in, and their phone shows you a
            moving code your camera has to watch. That's the whole barrier — it keeps the catalog honest without
            keeping anybody out who actually turns up.
          </p>
          <Link to="/handshake">
            <Button className="mt-4">Join with a handshake</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="contribute">
      <PageHeader
        title="Contribute"
        sub={TIER_BLURB[member.tier] ?? ""}
        right={<Badge gold={member.tier === "core"}>{member.tier}</Badge>}
      />

      <Card className="p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Confirmed finds" value={member.confirms} />
          <Stat label="Contradicted" value={member.contradictions} />
          <Stat label="Active days" value={member.distinctDays} />
          <Stat label="Trust" value={member.trust.toFixed(1)} />
        </div>
        {data?.nextTier ? (
          <p className="mt-4 text-xs text-muted">
            Next: <Badge>{data.nextTier.tier}</Badge> at {data.nextTier.minConfirms} confirmed finds across{" "}
            {data.nextTier.minDays} separate days.
          </p>
        ) : null}
        {member.quarantinedAt ? (
          <p className="mt-4 text-xs text-warn">
            Your submissions are on hold pending a review. Nothing has been deleted — a person will look at them.
          </p>
        ) : null}
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-semibold">Your workers</h3>
        <p className="mt-1 text-xs text-muted">
          Each machine or browser gets its own token, scoped to submitting scrape results and nothing else.
        </p>

        {freshToken ? (
          <div className="mt-4 rounded-lg border border-accent/40 bg-accent/5 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Copy this now — it is never shown again</p>
            <code className="mt-2 block break-all font-mono text-xs" data-testid="contribute-token">
              {freshToken.token}
            </code>
            <p className="mt-2 text-xs text-muted">
              {freshToken.kind === "cli" ? (
                <>
                  Clone the repo, then run{" "}
                  <code className="font-mono">BAY_WORKER_TOKEN={"\u2026"} npm run work</code>
                </>
              ) : (
                <>Paste it into the extension's popup and press Start.</>
              )}
            </p>
            <Button variant="quiet" className="mt-2 text-xs" onClick={() => setFreshToken(null)}>
              I've saved it
            </Button>
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          {(data?.clients ?? []).length === 0 ? (
            <p className="text-sm text-muted">No workers registered yet.</p>
          ) : (
            (data?.clients ?? []).map((c: any) => (
              <div key={c.id} className={cx("flex items-center justify-between rounded-lg border border-border p-3", c.revokedAt && "opacity-50")}>
                <div>
                  <div className="text-sm font-medium">
                    {c.label || c.kind} {c.revokedAt ? <span className="text-xs text-muted">(revoked)</span> : null}
                  </div>
                  <div className="text-xs text-muted">
                    {c.capabilities.join(", ")}
                    {c.lastSeenAt ? ` · last seen ${new Date(c.lastSeenAt).toLocaleString()}` : " · never used"}
                  </div>
                </div>
                {c.revokedAt ? null : (
                  <Button variant="danger" className="text-xs" onClick={() => void revoke(c.id)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {CLIENT_KINDS.map((k) => (
            <Button
              key={k.kind}
              variant="ghost"
              className="text-xs"
              title={k.hint}
              onClick={async () => {
                const r = await register({ kind: k.kind, label: k.label, capabilities: k.kind === "cli" ? ["fetch", "browser"] : ["fetch", "dom", "browser"] }).unwrap();
                setFreshToken({ token: r.token, kind: k.kind });
              }}
            >
              Register {k.label.toLowerCase()}
            </Button>
          ))}
        </div>
      </Card>

      {shadows.length ? (
        <Card className="p-5">
          <h3 className="text-sm font-semibold">Being trialled right now</h3>
          <p className="mt-1 text-xs text-muted">
            Candidate scrapers run beside the live one and replace it only if they find more, get less wrong, and cost
            the site no extra requests.
          </p>
          <div className="mt-3 space-y-2">
            {shadows.map((r: any) => (
              <div key={r.recipeId} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">
                    {r.sourceId} v{r.version}
                  </span>
                  <Badge>{r.status}</Badge>
                </div>
                {r.notes ? <p className="mt-1 text-xs text-muted">{r.notes}</p> : null}
                {r.author ? <p className="mt-1 text-xs text-muted">proposed by @{r.author}</p> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <h3 className="text-sm font-semibold">Who's filling the catalog</h3>
        {(board?.board ?? []).length === 0 ? (
          <EmptyState title="Nobody has found anything yet" hint="Be the first." />
        ) : (
          <ol className="mt-3 space-y-1">
            {(board?.board ?? []).map((p: any, i: number) => (
              <li key={p.id} className="flex items-center justify-between text-sm">
                <span>
                  <span className="mr-2 font-mono text-xs text-muted">{i + 1}</span>@{p.handle}{" "}
                  <Badge gold={p.tier === "core"}>{p.tier}</Badge>
                </span>
                <span className="font-mono text-xs">{p.finds} finds</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
