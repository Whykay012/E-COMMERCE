// src/redux/slices/uiSlice.js
import { createSlice } from "@reduxjs/toolkit";

// Initialize dark mode based on localStorage or system preference
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const savedDark = localStorage.getItem("darkMode");
const initialDark = savedDark !== null ? savedDark === "true" : prefersDark;

const initialState = {
  collapsed: false,
  mobileOpen: false,
  darkMode: initialDark,
};

// Apply initial theme
if (initialDark) document.documentElement.classList.add("dark");
else document.documentElement.classList.remove("dark");

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    toggleCollapse: (state) => {
      state.collapsed = !state.collapsed;
    },
    toggleMobileOpen: (state) => {
      state.mobileOpen = !state.mobileOpen;
    },
    closeMobile: (state) => {
      state.mobileOpen = false;
    },
    toggleDarkMode: (state) => {
      state.darkMode = !state.darkMode;
      document.documentElement.classList.toggle("dark", state.darkMode);
      localStorage.setItem("darkMode", state.darkMode);
    },
    setCollapsed: (state, action) => {
      state.collapsed = action.payload;
    },
    setMobileOpen: (state, action) => {
      state.mobileOpen = action.payload;
    },
    setDarkMode: (state, action) => {
      state.darkMode = action.payload;
      document.documentElement.classList.toggle("dark", state.darkMode);
      localStorage.setItem("darkMode", state.darkMode);
    },
  },
});

export const {
  toggleCollapse,
  toggleMobileOpen,
  closeMobile,
  toggleDarkMode,
  setCollapsed,
  setMobileOpen,
  setDarkMode,
} = uiSlice.actions;

export default uiSlice.reducer;
