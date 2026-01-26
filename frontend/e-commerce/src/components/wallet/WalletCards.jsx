// src/components/Wallet/WalletCards.jsx
import React from "react";

export default function WalletCards({ wallet }) {
  if (!wallet) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div className="p-4 bg-white rounded-xl shadow hover:shadow-md transition flex flex-col">
        <span className="text-sm text-gray-500">Wallet Balance</span>
        <span className="mt-2 text-2xl font-semibold text-green-600">
          ₦{wallet.balance?.toLocaleString()}
        </span>
      </div>

      <div className="p-4 bg-white rounded-xl shadow hover:shadow-md transition flex flex-col">
        <span className="text-sm text-gray-500">Total Credits</span>
        <span className="mt-2 text-2xl font-semibold text-blue-600">
          ₦{wallet.totalCredits?.toLocaleString()}
        </span>
      </div>

      <div className="p-4 bg-white rounded-xl shadow hover:shadow-md transition flex flex-col">
        <span className="text-sm text-gray-500">Total Debits</span>
        <span className="mt-2 text-2xl font-semibold text-red-600">
          ₦{wallet.totalDebits?.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
