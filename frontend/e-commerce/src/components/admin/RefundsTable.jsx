// src/components/RefundsTable.jsx
import React from "react";
import PropTypes from "prop-types";

export default function RefundsTable({ refunds = [], loading = false }) {
  const hasData = refunds && refunds.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow overflow-x-auto">
      <h3 className="mb-3 font-semibold text-gray-700">Recent Refunds</h3>

      {/* ───────────────────────────── */}
      {/* Loading Skeleton */}
      {/* ───────────────────────────── */}
      {loading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, idx) => (
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
        <p className="text-gray-500 text-sm">No refunds available.</p>
      )}

      {/* ───────────────────────────── */}
      {/* Refunds Table */}
      {/* ───────────────────────────── */}
      {!loading && hasData && (
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="bg-gray-100">
              <th className="p-2">Order ID</th>
              <th className="p-2">Customer</th>
              <th className="p-2">Amount</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>

          <tbody>
            {refunds.map((r) => (
              <tr
                key={r.orderId}
                className="border-b last:border-none hover:bg-gray-50"
              >
                <td className="p-2">{r.orderId}</td>
                <td className="p-2">{r.customerName}</td>

                <td className="p-2 font-semibold text-red-600">
                  ₦{r.amount.toLocaleString()}
                </td>

                <td className="p-2">
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium
                    ${
                      r.status === "Completed"
                        ? "bg-green-100 text-green-700"
                        : r.status === "Pending"
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

RefundsTable.propTypes = {
  refunds: PropTypes.arrayOf(
    PropTypes.shape({
      orderId: PropTypes.string.isRequired,
      customerName: PropTypes.string.isRequired,
      amount: PropTypes.number.isRequired,
      status: PropTypes.string.isRequired,
    })
  ),
  loading: PropTypes.bool,
};
