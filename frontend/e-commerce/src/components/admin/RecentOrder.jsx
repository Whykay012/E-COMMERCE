// src/components/RecentOrders.jsx
import React from "react";
import PropTypes from "prop-types";

export default function RecentOrders({ orders = [], loading = false }) {
  const hasData = orders && orders.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow overflow-x-auto">
      <h3 className="mb-3 font-semibold text-gray-700">Recent Orders</h3>

      {/* ───────────────────────────── */}
      {/* Loading Skeleton */}
      {/* ───────────────────────────── */}
      {loading && (
        <div className="space-y-2">
          {[...Array(5)].map((_, idx) => (
            <div
              key={idx}
              className="h-4 bg-gray-200 rounded animate-pulse w-full"
            ></div>
          ))}
        </div>
      )}

      {/* ───────────────────────────── */}
      {/* No Data */}
      {/* ───────────────────────────── */}
      {!loading && !hasData && (
        <p className="text-gray-500 text-sm">No recent orders yet.</p>
      )}

      {/* ───────────────────────────── */}
      {/* Orders Table */}
      {/* ───────────────────────────── */}
      {!loading && hasData && (
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="px-3 py-2">Order ID</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Date</th>
            </tr>
          </thead>

          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b hover:bg-gray-50">
                <td className="px-3 py-2">{o.id}</td>
                <td className="px-3 py-2">{o.customerName}</td>
                <td className="px-3 py-2">₦{o.amount?.toLocaleString()}</td>
                <td className="px-3 py-2">
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium 
                    ${
                      o.status === "Delivered"
                        ? "bg-green-100 text-green-700"
                        : o.status === "Pending"
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {o.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {new Date(o.date).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

RecentOrders.propTypes = {
  orders: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      customerName: PropTypes.string.isRequired,
      amount: PropTypes.number.isRequired,
      status: PropTypes.string.isRequired,
      date: PropTypes.string.isRequired,
    })
  ),
  loading: PropTypes.bool,
};
