import { PageHeader, EmptyState } from "./kit";

/** Temporary stand-in so a route renders (and its nav test passes) before its
 *  feature UI lands. Every stub names the phase it belongs to. */
export function Placeholder({ title, phase }: { title: string; phase?: string }) {
  return (
    <div data-testid={`placeholder-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <PageHeader title={title} />
      <EmptyState title={`${title} — coming online`} hint={phase ? `Shipping in ${phase}.` : "This surface is being built."} />
    </div>
  );
}
