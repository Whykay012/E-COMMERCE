// src/components/admin/Sidebar.jsx
import React from "react";
import { NavLink } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { toggleCollapse, closeMobile } from "../../redux/slices/uiSlice";

const items = [
  { to: "/admin/charts/sales-trend", label: "Sales", icon: "📈" },
  { to: "/admin/charts/category-breakdown", label: "Categories", icon: "🗂️" },
  { to: "/admin/charts/top-products", label: "Top Products", icon: "⭐" },
  { to: "/admin/charts/recent-orders", label: "Orders", icon: "📦" },
  { to: "/admin/charts/device-sessions", label: "Sessions", icon: "🖥️" },
  { to: "/admin/charts/notifications", label: "Notifications", icon: "🔔" },
  { to: "/admin/charts/inventory-alerts", label: "Inventory", icon: "⚠️" },
];

export default function Sidebar() {
  const dispatch = useDispatch();
  const { collapsed, mobileOpen } = useSelector((state) => state.ui);

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 z-20 lg:hidden transition-opacity ${
          mobileOpen ? "opacity-100 block" : "opacity-0 hidden"
        }`}
        onClick={() => dispatch(closeMobile())}
      />

      <aside
        className={`fixed z-30 h-full bg-white dark:bg-gray-800 border-r dark:border-gray-700 shadow-lg
          transition-all duration-300
          ${collapsed ? "w-20" : "w-64"}
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
          {!collapsed && <div className="font-bold text-lg">Admin</div>}
          <button
            onClick={() => dispatch(toggleCollapse())}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        {/* Navigation */}
        <nav className="p-3">
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 p-2 rounded-md transition-colors ${
                      isActive
                        ? "bg-blue-50 dark:bg-blue-900 text-blue-700 dark:text-blue-300"
                        : "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`
                  }
                  onClick={() => dispatch(closeMobile())} // closes drawer on mobile
                >
                  <span className="text-xl">{it.icon}</span>
                  {!collapsed && <span className="truncate">{it.label}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  );
}
