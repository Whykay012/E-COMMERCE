// src/components/Wallet/PaymentHistoryTable.jsx
import React from "react";

export default function PaymentHistoryTable({
  payments,
  highlightedIndex,
  onOpenPayment,
}) {
  if (!payments.length)
    return <div className="text-center py-10">No payments found</div>;

  return (
    <table className="min-w-full border rounded-lg overflow-hidden">
      <thead className="bg-gray-50">
        <tr>
          <th className="px-4 py-2 text-left">ID</th>
          <th className="px-4 py-2 text-left">Description</th>
          <th className="px-4 py-2 text-left">Amount</th>
          <th className="px-4 py-2 text-left">Status</th>
          <th className="px-4 py-2 text-left">Date</th>
        </tr>
      </thead>
      <tbody>
        {payments.map((p, idx) => {
          const isHighlighted = idx === highlightedIndex;
          return (
            <tr
              key={p.id}
              onClick={() => onOpenPayment(p.id)}
              className={`cursor-pointer transition ${
                isHighlighted ? "bg-blue-100" : "hover:bg-gray-50"
              }`}
            >
              <td className="px-4 py-2">{p.id}</td>
              <td className="px-4 py-2">{p.description}</td>
              <td className="px-4 py-2">₦{p.amount.toLocaleString()}</td>
              <td
                className={`px-4 py-2 font-medium ${
                  p.status === "success"
                    ? "text-green-600"
                    : p.status === "failed"
                    ? "text-red-600"
                    : "text-yellow-600"
                }`}
              >
                {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
              </td>
              <td className="px-4 py-2">
                {new Date(p.createdAt).toLocaleString()}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
