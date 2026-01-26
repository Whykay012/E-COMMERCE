// src/components/SummaryCards.jsx
import React from "react";
import PropTypes from "prop-types";
import {
  ArrowUpRight,
  ArrowDownRight,
  Users,
  ShoppingCart,
  RefreshCcw,
  Wallet,
} from "lucide-react";

/** Utility: format currency */
const formatCurrency = (value) =>
  `₦${Number(value || 0).toLocaleString("en-US")}`;

/** Utility: choose trend color */
const trendColor = (v) =>
  v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-600";

/** Utility: choose trend icon */
const TrendIcon = ({ value }) =>
  value > 0 ? (
    <ArrowUpRight className="h-4 w-4 text-green-600" />
  ) : value < 0 ? (
    <ArrowDownRight className="h-4 w-4 text-red-600" />
  ) : (
    <ArrowUpRight className="h-4 w-4 text-gray-400 rotate-90" />
  );

export default function SummaryCards({ summary = {}, className = "" }) {
  const hasData = summary && Object.keys(summary).length > 0;

  /**  Define your summary items + their icons */
  const items = [
    {
      key: "revenue",
      label: "Revenue",
      value: summary.revenue,
      trend: summary.revenueChange,
      icon: <Wallet className="h-6 w-6 text-green-500" />,
      formatter: formatCurrency,
    },
    {
      key: "orders",
      label: "Orders",
      value: summary.orders,
      trend: summary.ordersChange,
      icon: <ShoppingCart className="h-6 w-6 text-blue-500" />,
      formatter: (v) => v || 0,
    },
    {
      key: "customers",
      label: "Customers",
      value: summary.customers,
      trend: summary.customersChange,
      icon: <Users className="h-6 w-6 text-purple-500" />,
      formatter: (v) => v || 0,
    },
    {
      key: "refunds",
      label: "Refunds",
      value: summary.refunds,
      trend: summary.refundsChange,
      icon: <RefreshCcw className="h-6 w-6 text-red-500" />,
      formatter: (v) => v || 0,
    },
  ];

  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${className}`}
    >
      {items.map(({ key, label, value, trend, icon, formatter }) => (
        <div
          key={key}
          className="p-5 bg-white rounded-2xl shadow flex flex-col justify-between hover:shadow-md transition"
        >
          {/* Top section: label + icon */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-500">{label}</span>
            {icon}
          </div>

          {/* Value or Skeleton */}
          {hasData ? (
            <div className="mt-3 text-2xl font-semibold text-gray-800">
              {formatter(value)}
            </div>
          ) : (
            <div className="mt-3 h-8 bg-gray-200 rounded animate-pulse w-3/4"></div>
          )}

          {/* Trend Indicator */}
          {hasData ? (
            <div className="flex items-center gap-1 mt-2">
              <TrendIcon value={trend} />
              <span className={`text-sm font-medium ${trendColor(trend)}`}>
                {trend > 0 ? "+" : ""}
                {trend ?? 0}%
              </span>
              <span className="text-xs text-gray-400 ml-1">vs last week</span>
            </div>
          ) : (
            <div className="mt-3 h-4 bg-gray-200 rounded animate-pulse w-1/3"></div>
          )}
        </div>
      ))}
    </div>
  );
}

SummaryCards.propTypes = {
  summary: PropTypes.shape({
    revenue: PropTypes.number,
    orders: PropTypes.number,
    customers: PropTypes.number,
    refunds: PropTypes.number,

    // New Trend Props
    revenueChange: PropTypes.number,
    ordersChange: PropTypes.number,
    customersChange: PropTypes.number,
    refundsChange: PropTypes.number,
  }),
  className: PropTypes.string,
};
