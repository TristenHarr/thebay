import type { ButtonHTMLAttributes, ReactNode } from "react";
import { eventThumb } from "./thumb";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Event cover image, or a tasteful deterministic gradient + category glyph when
 *  there's none — so a card is never blank. `className` sizes the box (the caller
 *  owns width/height/rounding). */
export function EventThumb({ event, className, glyph = 40 }: { event: { imageUrl?: string | null; id?: string; title?: string; categories?: string[] }; className?: string; glyph?: number }) {
  if (event.imageUrl) return <img src={event.imageUrl} alt="" className={className} loading="lazy" />;
  const t = eventThumb(event);
  return (
    <div className={cx("flex items-center justify-center", className)} style={{ background: t.background }} aria-hidden>
      <span className="opacity-95 [text-shadow:0_1px_6px_rgba(0,0,0,0.25)]" style={{ fontSize: glyph }}>{t.glyph}</span>
    </div>
  );
}

export function Button({
  variant = "primary",
  className,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "quiet" | "danger" }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-50 focus-visible:outline";
  const styles = {
    primary: "bg-accent text-accent-ink hover:brightness-110",
    ghost: "border border-border bg-surface text-muted hover:text-text hover:border-accent",
    quiet: "text-muted hover:text-text",
    danger: "border border-border text-crit hover:bg-crit/10",
  }[variant];
  return <button className={cx(base, styles, className)} {...p} />;
}

export function Card({ children, className, as: As = "div", ...rest }: { children: ReactNode; className?: string; as?: any; [k: string]: any }) {
  return (
    <As className={cx("rounded-lg border border-border bg-elev", className)} {...rest}>
      {children}
    </As>
  );
}

export function Avatar({ user, size = 36 }: { user: { displayName?: string; handle?: string; avatarKey?: string | null }; size?: number }) {
  const name = user?.displayName || user?.handle || "?";
  const url = user?.avatarKey ? `/api/img/${user.avatarKey}` : null;
  const initials = name.split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();
  return url ? (
    <img src={url} width={size} height={size} alt={name} className="rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      className="inline-flex items-center justify-center rounded-full bg-accent font-bold text-accent-ink"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials}
    </span>
  );
}

export const Chip = ({ children, on, className, ...rest }: { children: ReactNode; on?: boolean; className?: string; [k: string]: any }) => (
  <button
    className={cx(
      "rounded-full border px-3 py-1 text-xs font-semibold transition",
      on ? "border-transparent bg-accent text-accent-ink" : "border-border bg-surface text-muted hover:text-text",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

export const Badge = ({ children, gold }: { children: ReactNode; gold?: boolean }) => (
  <span className={cx("rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide", gold ? "bg-gold/15 text-gold" : "bg-surface text-muted")}>{children}</span>
);

export const Stat = ({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div className="flex flex-col">
    <span className={cx("text-lg font-bold", mono && "font-mono tabular-nums")}>{value}</span>
    <span className="text-xs text-muted">{label}</span>
  </div>
);

export const Spinner = () => <div className="mx-auto my-10 h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" aria-label="loading" />;

/** Shimmering placeholder — feels faster than a spinner. `.skeleton` is in index.css. */
export const Skeleton = ({ className }: { className?: string }) => <div className={cx("skeleton", className)} aria-hidden />;

/** A list of card-shaped skeletons for feed/list loading states. */
export const SkeletonList = ({ rows = 5 }: { rows?: number }) => (
  <div className="flex flex-col gap-3" aria-label="loading" role="status">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="flex gap-3 rounded-lg border border-border bg-elev p-3">
        <Skeleton className="h-16 w-24 shrink-0" />
        <div className="flex flex-1 flex-col gap-2 py-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="rounded-lg border border-dashed border-border p-8 text-center">
    <p className="font-medium">{title}</p>
    {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
  </div>
);

export const PageHeader = ({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) => (
  <div className="mb-5 flex items-end justify-between gap-4">
    <div>
      <h1 className="text-2xl font-bold tracking-tight" style={{ textWrap: "balance" } as any}>{title}</h1>
      {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
    </div>
    {right}
  </div>
);

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1 text-sm text-muted">
    {label}
    {children}
  </label>
);

export const input = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent";
