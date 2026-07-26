import { NavLink, useLocation } from "react-router-dom";
import { cx } from "../ui/kit";
import { sectionFor, visibleItems } from "./nav";

/**
 * The second navigation level: a flat tab strip for whichever section you're in.
 *
 * This replaces the `/network` card grid. A grid of cards is a menu that costs a
 * whole screen and a click to tell you what a tab strip tells you for free, while
 * you're already looking at content. So the strip sits under the header, is always
 * visible inside the section, and never appears at all for a single-tab section —
 * a lone tab is decoration, not navigation.
 *
 * Scrolls horizontally rather than wrapping: People has six tabs, and a strip that
 * reflows to two rows on a phone shifts the page content down as you navigate.
 */
export function SectionTabs({ signedIn }: { signedIn: boolean }) {
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  if (!section) return null;

  const items = visibleItems(section, signedIn);
  if (items.length < 2) return null;

  return (
    <div className="sticky top-[52px] z-10 border-b border-border bg-bg/85 backdrop-blur" data-testid={`tabs-${section.id}`}>
      <nav
        className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label={`${section.label} sections`}
      >
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === "/discover"}
            className={({ isActive }) =>
              cx(
                "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-accent text-text"
                  : "border-transparent text-muted hover:border-border hover:text-text",
              )
            }
          >
            {it.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
