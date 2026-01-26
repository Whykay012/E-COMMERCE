import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { initTheme, setActiveTheme } from "../redux/slices/themeSlice";

export default function ThemeProvider({ children }) {
  const dispatch = useDispatch();
  const { theme } = useSelector((state) => state.theme);

  // On first load → initialize theme
  useEffect(() => {
    dispatch(initTheme());
  }, [dispatch]);

  // Apply theme every time theme state changes
  useEffect(() => {
    const systemDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;

    const applied =
      theme === "system" ? (systemDark ? "dark" : "light") : theme;

    dispatch(setActiveTheme(applied));

    // transition animation
    document.documentElement.classList.add("theme-transition");
    setTimeout(() => {
      document.documentElement.classList.remove("theme-transition");
    }, 300);

    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(applied);
  }, [theme, dispatch]);

  return <>{children}</>;
}
