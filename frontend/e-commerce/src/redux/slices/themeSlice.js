import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  theme: localStorage.getItem("theme") || "system",
  activeTheme: "light", // actual applied theme after system detection
};

const themeSlice = createSlice({
  name: "theme",
  initialState,
  reducers: {
    initTheme: (state) => {
      const saved = localStorage.getItem("theme") || "system";
      state.theme = saved;
    },
    setTheme: (state, action) => {
      state.theme = action.payload;
      localStorage.setItem("theme", action.payload);
    },
    setActiveTheme: (state, action) => {
      state.activeTheme = action.payload;
    },
  },
});

export const { initTheme, setTheme, setActiveTheme } = themeSlice.actions;
export default themeSlice.reducer;
