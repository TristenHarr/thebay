import { useGetMyXpQuery } from "../../api";

/**
 * The Experience bar — your level + progress in the game track (separate from the
 * social `points` score). Compact chip for the header; the full breakdown lives on
 * the map / achievements. Renders nothing until you have an XP row.
 */
export function LevelBar() {
  const { data } = useGetMyXpQuery();
  if (!data) return null;
  const pct = Math.max(0, Math.min(100, Math.round((data.pct || 0) * 100)));
  return (
    <div className="xp-chip" data-testid="level-bar" title={`Level ${data.level} · ${data.xp.toLocaleString()} XP · ${data.toNext.toLocaleString()} to level ${data.level + 1}`}>
      <span className="xp-lvl">Lv&nbsp;{data.level}</span>
      <span className="xp-track"><span className="xp-fill" style={{ width: `${pct}%` }} /></span>
    </div>
  );
}
