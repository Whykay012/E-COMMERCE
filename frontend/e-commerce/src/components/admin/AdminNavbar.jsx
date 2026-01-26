// src/components/AdminNavbar.jsx
import React, { useState } from "react";
import { NavLink } from "react-router-dom";

export default function AdminNavbar() {
  const [openDropdown, setOpenDropdown] = useState(null);

  // src/components/AdminNavbar.jsx
  const menuItems = [
    {
      label: "Charts",
      path: "#",
      subItems: [
        { label: "Sales Trend", path: "/admin/charts/sales-trend" },
        {
          label: "Category Breakdown",
          path: "/admin/charts/category-breakdown",
        },
        { label: "Traffic Analytics", path: "/admin/charts/traffic-analytics" },
        { label: "Top Products", path: "/admin/charts/top-products" },
        { label: "Recent Orders", path: "/admin/charts/recent-orders" },
        { label: "Notifications", path: "/admin/charts/notifications" },
        { label: "Device Sessions", path: "/admin/charts/device-sessions" },
        { label: "Inventory Alerts", path: "/admin/charts/inventory-alerts" },
        { label: "Vendor Stats", path: "/admin/charts/vendor-stats" },
        { label: "Refunds", path: "/admin/charts/refunds" },
        { label: "User Growth", path: "/admin/charts/user-growth" },
      ],
    },
    {
      label: "Uploads",
      path: "#",
      subItems: [
        { label: "Banner Upload", path: "/banner" },
        { label: "Avatar Upload", path: "/avatar" },
        { label: "Product Images", path: "/product-images" },
        { label: "Product Video", path: "/product-video" },
      ],
    },
  ];

  return (
    <nav className="bg-gray-800 text-white px-6 py-4 flex items-center gap-6 relative">
      <div className="font-bold text-lg">Admin Panel</div>

      {menuItems.map((item, idx) => (
        <div
          key={idx}
          className="relative"
          onMouseEnter={() => setOpenDropdown(idx)}
          onMouseLeave={() => setOpenDropdown(null)}
        >
          {item.subItems ? (
            <>
              <button className="hover:text-gray-300 px-2 py-1">
                {item.label}
              </button>
              {openDropdown === idx && (
                <div className="absolute top-full left-0 mt-1 bg-white text-black rounded shadow-lg z-50 min-w-[180px]">
                  {item.subItems.map((sub, i) => (
                    <NavLink
                      key={i}
                      to={sub.path}
                      className="block px-4 py-2 hover:bg-gray-100"
                    >
                      {sub.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </>
          ) : (
            <NavLink to={item.path} className="hover:text-gray-300 px-2 py-1">
              {item.label}
            </NavLink>
          )}
        </div>
      ))}
    </nav>
  );
}
