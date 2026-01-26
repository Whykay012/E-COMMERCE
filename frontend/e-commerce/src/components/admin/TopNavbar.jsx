// src/components/admin/TopNavbar.jsx
import React from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  toggleMobileOpen,
  toggleCollapse,
  toggleDarkMode,
} from "../../redux/slices/uiSlice";
import { Sun, Moon, Menu } from "lucide-react";

export default function TopNavbar() {
  const dispatch = useDispatch();
  const { collapsed, darkMode } = useSelector((state) => state.ui);

  return (
    <header className="flex items-center justify-between px-6 py-3 bg-white dark:bg-gray-800 shadow">
      {/* Left: Menu Buttons */}
      <div className="flex items-center gap-3">
        {/* Mobile Menu Toggle */}
        <button
          className="lg:hidden p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          onClick={() => dispatch(toggleMobileOpen())}
        >
          <Menu className="w-5 h-5 text-gray-700 dark:text-gray-300" />
        </button>

        {/* Desktop Collapse Toggle */}
        <button
          className="hidden lg:block p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          onClick={() => dispatch(toggleCollapse())}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {/* Right: Dark Mode Toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => dispatch(toggleDarkMode())}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {darkMode ? (
            <Moon className="w-5 h-5 text-gray-100" />
          ) : (
            <Sun className="w-5 h-5 text-gray-700" />
          )}
        </button>
      </div>
    </header>
  );
}
