import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * UI state for the floating Shadows widget — where it sits, how big it is, and
 * whether it's pinned / minimized / expanded. Persisted to localStorage so the
 * widget stays exactly where the user left it across reloads (it's meant to feel
 * like a permanent, movable pane of the app, not a modal that resets).
 */
export type ShadowsMode = "bubble" | "open" | "expanded";
export interface ShadowsUi {
  mode: ShadowsMode;
  pinned: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

const KEY = "bay.shadows.ui.v1";
const DEFAULTS: ShadowsUi = { mode: "bubble", pinned: false, x: -1, y: -1, w: 380, h: 460 };

function load(): ShadowsUi {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
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
  },
});

export const { setMode, togglePinned, moveTo, resizeTo } = slice.actions;
export const shadowsUiReducer = slice.reducer;
