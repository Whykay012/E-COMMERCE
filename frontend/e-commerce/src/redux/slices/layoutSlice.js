// src/redux/slices/layoutSlice.js
import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  sidebarCollapsed: false,
  mobileOpen: false,
};

const layoutSlice = createSlice({
  name: "layout",
  initialState,
  reducers: {
    toggleSidebar: (state) => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    openMobile: (state) => {
      state.mobileOpen = true;
    },
    closeMobile: (state) => {
      state.mobileOpen = false;
    },
  },
});

export const { toggleSidebar, openMobile, closeMobile } = layoutSlice.actions;
export default layoutSlice.reducer;
