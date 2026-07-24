// Theme: persists the viewer's choice and stamps data-theme on <html> so the
// token overrides in index.css win in both directions. Defaults to dark.
export type Theme = "dark" | "light";

export function getTheme(): Theme {
  const saved = localStorage.getItem("bay-theme");
  return saved === "light" ? "light" : "dark";
}

export function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("bay-theme", t);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
