import { useRef, useState } from "react";
import { useGetIntegrationsQuery, useImportIntegrationMutation, useConnectIntegrationMutation, useGetImportedQuery } from "../../api";
import { Button, Card, Spinner, PageHeader, Badge } from "../../ui/kit";
import { parseLinkedInCsv } from "../../../../src/integrations/linkedin";

/** Shows what we've pulled in from a provider — proof the richer import worked. */
function ImportedSummary({ provider }: { provider: string }) {
  const { data } = useGetImportedQuery(provider);
  const items = data?.items || [];
  if (!items.length) return null;
  const label = (it: any) => it.payload?.title || it.payload?.name || it.externalId;
  return (
    <div className="mt-1 rounded-lg border border-border bg-surface p-2 text-xs">
      <div className="mb-1 font-semibold text-muted">{items.length} imported</div>
      <ul className="flex flex-col gap-0.5">
        {items.slice(0, 4).map((it: any, i: number) => <li key={i} className="truncate">• {label(it)}</li>)}
        {items.length > 4 && <li className="text-muted">+{items.length - 4} more</li>}
      </ul>
    </div>
  );
}

type Kind = "ics" | "csv" | "link";
const PROVIDERS: { id: string; icon: string; name: string; blurb: string; kind: Kind; accept?: string; hint?: string }[] = [
  { id: "luma", icon: "🎟️", name: "Luma", kind: "ics", accept: ".ics", blurb: "Copy your Luma calendar in.", hint: "In Luma: Calendar → Subscribe → download the .ics, then upload it here." },
  { id: "eventbrite", icon: "🎫", name: "Eventbrite", kind: "ics", accept: ".ics", blurb: "Import your Eventbrite orders.", hint: "Export your Eventbrite calendar as .ics and upload it." },
  { id: "meetup", icon: "👥", name: "Meetup", kind: "ics", accept: ".ics", blurb: "Bring your Meetup RSVPs across.", hint: "Meetup → your calendar → download iCal, then upload." },
  { id: "calendar", icon: "📅", name: "Calendar", kind: "ics", accept: ".ics", blurb: "Import from Google / Apple / Outlook.", hint: "Export any calendar as .ics and upload it to see those events here." },
  { id: "linkedin", icon: "💼", name: "LinkedIn", kind: "csv", accept: ".csv", blurb: "Import your connections.", hint: "LinkedIn → Settings → Get a copy of your data → Connections. Upload the Connections.csv." },
  { id: "telegram", icon: "✈️", name: "Telegram", kind: "link", blurb: "Link Telegram for chat & alerts." },
];

export function Integrations() {
  const { data, isLoading } = useGetIntegrationsQuery();
  const [importFn] = useImportIntegrationMutation();
  const [connect] = useConnectIntegrationMutation();
  const [status, setStatus] = useState<Record<string, string>>({});
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  if (isLoading) return <Spinner />;
  const connected = new Set((data?.accounts || []).map((a: any) => a.provider));

  async function onFile(provider: string, kind: Kind, file: File) {
    setStatus((s) => ({ ...s, [provider]: "Importing…" }));
    const text = await file.text();
    let res: any;
    if (kind === "csv") res = await importFn({ provider, items: parseLinkedInCsv(text) });
    else res = await importFn({ provider, ics: text });
    const d = res.data;
    setStatus((s) => ({ ...s, [provider]: d ? `Imported ${d.imported} of ${d.total}` : (res.error?.data?.error || "Import failed") }));
    if (d) connect({ provider });
  }

  return (
    <div data-testid="integrations">
      <PageHeader title="Integrations" sub="Bring your events and network into The Bay — nothing leaves without you." />
      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((p) => (
          <Card key={p.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{p.icon}</span>
              <b>{p.name}</b>
              {connected.has(p.id) && <Badge>connected</Badge>}
            </div>
            <p className="text-sm text-muted">{p.blurb}</p>
            {p.hint && <p className="text-xs text-muted">{p.hint}</p>}
            {p.kind === "link" ? (
              <div className="mt-1 flex gap-2">
                <a href="https://t.me/thebay_events_bot" target="_blank" rel="noopener"><Button variant="ghost">Open bot ↗</Button></a>
                <Button variant="quiet" onClick={async () => { await connect({ provider: p.id }); setStatus((s) => ({ ...s, [p.id]: "Linked" })); }}>Mark linked</Button>
              </div>
            ) : (
              <div className="mt-1">
                <input ref={(el) => { refs.current[p.id] = el; }} type="file" accept={p.accept} hidden onChange={(e) => e.target.files?.[0] && onFile(p.id, p.kind, e.target.files[0])} />
                <Button variant="ghost" onClick={() => refs.current[p.id]?.click()}>Upload {p.accept}</Button>
              </div>
            )}
            {status[p.id] && <div className="text-xs text-accent">{status[p.id]}</div>}
            {connected.has(p.id) && p.kind !== "link" && <ImportedSummary provider={p.id} />}
          </Card>
        ))}
      </div>
    </div>
  );
}
