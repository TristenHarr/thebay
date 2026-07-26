import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * UI state for the floating map — where it sits, how big it is, whether it's
 * pinned / minimized / expanded, AND which discovery LAYERS are switched on
 * (shadows, spots, and — added in later stages — trails, orbs, live, lore). The
 * map is one unified, crowd-sourced surface; layers are how you dial in what you
 * want to see. Persisted to localStorage so the map stays exactly as you left it.
 */
export type ShadowsMode = "bubble" | "open" | "expanded";
export type LayerId = "shadows" | "places" | "trails" | "orbs" | "live" | "lore";
export interface ShadowsUi {
  mode: ShadowsMode;
  pinned: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  layers: Record<string, boolean>;
}

const KEY = "bay.shadows.ui.v2";
const DEFAULT_LAYERS: Record<string, boolean> = { shadows: true, places: true, orbs: true, live: true, lore: true };
const DEFAULTS: ShadowsUi = { mode: "bubble", pinned: false, x: -1, y: -1, w: 380, h: 460, layers: DEFAULT_LAYERS };

function load(): ShadowsUi {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed, layers: { ...DEFAULT_LAYERS, ...(parsed.layers || {}) } };
    }
  } catch {
    /* ignore — first run / private mode */
  }
  return DEFAULTS;
}
function persist(s: ShadowsUi) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const slice = createSlice({
  name: "shadowsUi",
  initialState: load(),
  reducers: {
    setMode(s, a: PayloadAction<ShadowsMode>) {
      s.mode = a.payload;
      persist(s);
    },
    togglePinned(s) {
      s.pinned = !s.pinned;
      persist(s);
    },
    moveTo(s, a: PayloadAction<{ x: number; y: number }>) {
      s.x = a.payload.x;
      s.y = a.payload.y;
      persist(s);
    },
    resizeTo(s, a: PayloadAction<{ w: number; h: number }>) {
      s.w = Math.max(300, a.payload.w);
      s.h = Math.max(320, a.payload.h);
      persist(s);
    },
    toggleLayer(s, a: PayloadAction<LayerId>) {
      s.layers = { ...s.layers, [a.payload]: !s.layers[a.payload] };
      persist(s);
    },
    setLayer(s, a: PayloadAction<{ id: LayerId; on: boolean }>) {
      s.layers = { ...s.layers, [a.payload.id]: a.payload.on };
      persist(s);
    },
  },
});

export const { setMode, togglePinned, moveTo, resizeTo, toggleLayer, setLayer } = slice.actions;
export const shadowsUiReducer = slice.reducer;
