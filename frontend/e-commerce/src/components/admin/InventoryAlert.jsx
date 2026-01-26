// src/components/InventoryAlerts.jsx
import React from "react";
import PropTypes from "prop-types";

export default function InventoryAlerts({ alerts = [], loading = false }) {
  const hasData = alerts.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow">
      <h3 className="mb-3 font-semibold text-gray-700">Inventory Alerts</h3>

      {/* ⏳ Loading Skeleton */}
      {loading && (
        <div className="space-y-3 max-h-72">
          {[...Array(5)].map((_, idx) => (
            <div
              key={idx}
              className="h-4 bg-red-100 rounded animate-pulse"
            ></div>
          ))}
        </div>
      )}

      {/* 📦 Data Found */}
      {!loading && hasData && (
        <ul className="space-y-2 max-h-72 overflow-y-auto">
          {alerts.map((item) => (
            <li
              key={item.productId}
              className="flex justify-between items-center p-2 bg-red-50 rounded-md"
            >
              <span className="font-medium text-gray-700">
                {item.productName}
              </span>
              <span className="font-semibold text-red-600">
                {item.stock} left
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* ❌ No Alerts */}
      {!loading && !hasData && (
        <div className="text-gray-500 text-sm">
          All products are sufficiently stocked.
        </div>
      )}
    </div>
  );
}

InventoryAlerts.propTypes = {
  alerts: PropTypes.arrayOf(
    PropTypes.shape({
      productId: PropTypes.string.isRequired,
      productName: PropTypes.string.isRequired,
      stock: PropTypes.number.isRequired,
    })
  ),
  loading: PropTypes.bool,
};
