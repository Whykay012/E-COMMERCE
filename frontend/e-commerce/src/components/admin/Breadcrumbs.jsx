import React from "react";
import { Link, useLocation } from "react-router-dom";

export default function Breadcrumbs() {
  const location = useLocation();

  const segments = location.pathname.split("/").filter(Boolean);

  if (segments.length < 2) return null; // only show breadcrumbs inside admin

  const breadcrumbItems = segments.map((seg, index) => ({
    label: seg.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
    path: "/" + segments.slice(0, index + 1).join("/"),
  }));

  return (
    <div className="bg-white px-4 py-2 shadow-md border-b mb-2 text-sm">
      <nav className="flex gap-1 text-gray-600">
        {breadcrumbItems.map((item, idx) => (
          <span key={idx} className="flex items-center">
            {idx < breadcrumbItems.length - 1 ? (
              <Link to={item.path} className="hover:text-blue-600">
                {item.label}
              </Link>
            ) : (
              <span className="text-gray-800">{item.label}</span>
            )}
            {idx < breadcrumbItems.length - 1 && (
              <span className="mx-1 text-gray-400">/</span>
            )}
          </span>
        ))}
      </nav>
    </div>
  );
}
