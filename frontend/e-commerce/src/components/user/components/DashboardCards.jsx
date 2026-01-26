import React from "react";

export default function DashboardCards({ summary }) {
  const cards = [
    { title: "Wallet Balance", value: summary.totalPayments || 0, icon: "💰" },
    { title: "Orders", value: summary.totalOrders || 0, icon: "📦" },
    { title: "Wishlist", value: summary.wishlistCount || 0, icon: "❤️" },
    { title: "Cart Items", value: summary.cartItems || 0, icon: "🛒" },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.title}
          className="p-4 bg-white rounded-xl shadow hover:shadow-lg transition flex flex-col items-center justify-center cursor-pointer"
        >
          <div className="text-3xl">{card.icon}</div>
          <div className="text-gray-500">{card.title}</div>
          <div className="text-xl font-semibold mt-2">{card.value}</div>
        </div>
      ))}
    </div>
  );
}
