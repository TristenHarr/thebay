import { configureStore } from "@reduxjs/toolkit";
import { api } from "./api";
import { shadowsUiReducer } from "./features/board/shadowsSlice";

export const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer, shadowsUi: shadowsUiReducer },
  middleware: (getDefault) => getDefault().concat(api.middleware),
});
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
