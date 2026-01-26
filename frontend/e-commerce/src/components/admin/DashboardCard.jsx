// src/components/DashboardCard.jsx
import React from "react";
import PropTypes from "prop-types";

/**
 * DashboardCard Component
 * - Wraps any dashboard content in a consistent card layout
 * - Supports optional title, value, subtitle, height, and loading state
 */
const DashboardCard = ({
  title,
  value,
  subtitle,
  children,
  className = "",
  loading = false,
}) => {
  return (
    <div
      className={`bg-white p-4 rounded-2xl shadow flex flex-col justify-between ${className}`}
    >
      {/* Card Header */}
      {title && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-500">{title}</p>
        </div>
      )}

      {/* Card Body */}
      {loading ? (
        <div className="flex-1 space-y-2">
          <div className="h-6 bg-gray-200 rounded animate-pulse w-3/4"></div>
          <div className="h-6 bg-gray-200 rounded animate-pulse w-1/2"></div>
        </div>
      ) : value ? (
        <div className="text-2xl font-semibold">{value}</div>
      ) : (
        children
      )}

      {/* Optional Subtitle */}
      {subtitle && !loading && (
        <p className="text-sm text-gray-400 mt-2">{subtitle}</p>
      )}
    </div>
  );
};

DashboardCard.propTypes = {
  title: PropTypes.string,
  value: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.number,
    PropTypes.node,
  ]),
  subtitle: PropTypes.string,
  children: PropTypes.node,
  className: PropTypes.string,
  loading: PropTypes.bool,
};

export default DashboardCard;
