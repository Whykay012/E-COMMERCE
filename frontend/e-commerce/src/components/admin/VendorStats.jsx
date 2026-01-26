// src/components/VendorStats.jsx
import React from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";

export default function VendorStats({ vendors = [], loading = false }) {
  const hasData = vendors && vendors.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow">
      <h3 className="mb-3 font-semibold text-gray-700">Vendor Stats</h3>

      {/* ───────────────────────── */}
      {/* Loading State */}
      {/* ───────────────────────── */}
      {loading && (
        <div className="space-y-3 max-h-72 overflow-y-auto">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-10 bg-gray-200 rounded animate-pulse"
            ></div>
          ))}
        </div>
      )}

      {/* ───────────────────────── */}
      {/* Empty State */}
      {/* ───────────────────────── */}
      {!loading && !hasData && (
        <p className="text-gray-500 text-sm">No vendor statistics available.</p>
      )}

      {/* ───────────────────────── */}
      {/* Vendor List */}
      {/* ───────────────────────── */}
      {!loading && hasData && (
        <ul className="space-y-2 max-h-72 overflow-y-auto">
          {vendors.map((v) => (
            <li
              key={v.id}
              className="flex justify-between items-center p-2 bg-gray-50 hover:bg-gray-100 duration-150 rounded-lg"
            >
              {/* Vendor Left */}
              <div className="flex items-center space-x-3">
                <img
                  src={v.avatar || "/placeholder-vendor.png"}
                  alt={v.name}
                  className="h-10 w-10 rounded-full object-cover border"
                />
                <div>
                  <div className="font-medium text-gray-700">{v.name}</div>
                  <div className="text-xs text-gray-500">
                    {v.activeProducts.toLocaleString()} active products
                  </div>
                </div>
              </div>

              {/* Vendor Right */}
              <div className="flex items-center space-x-3">
                {/* Status badge */}
                <span
                  className={`px-2 py-1 rounded text-xs font-semibold ${
                    v.status === "active"
                      ? "bg-green-100 text-green-600"
                      : v.status === "inactive"
                      ? "bg-red-100 text-red-600"
                      : "bg-gray-200 text-gray-600"
                  }`}
                >
                  {v.status}
                </span>

                {/* CTA */}
                <Link
                  to={`/admin/vendor/${v.id}`}
                  className="text-blue-600 text-xs font-medium hover:underline"
                >
                  View
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

VendorStats.propTypes = {
  vendors: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      avatar: PropTypes.string,
      activeProducts: PropTypes.number,
      status: PropTypes.oneOf(["active", "inactive", "pending", "banned"]),
    })
  ),
  loading: PropTypes.bool,
};
