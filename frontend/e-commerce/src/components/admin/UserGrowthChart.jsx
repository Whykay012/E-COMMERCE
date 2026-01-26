import React from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export default function UserGrowthChart({
  data = [],
  loading = false,
  strokeColor = "#3b82f6",
  fillColor = "#93c5fd",
  noDataMessage = "No user growth data available",
  tooltipFormatter,
}) {
  const hasData = Array.isArray(data) && data.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-72 text-gray-500">
        Loading user growth...
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-72 text-gray-500">
        {noDataMessage}
      </div>
    );
  }

  return (
    <div className="p-4 bg-white rounded-2xl shadow h-72">
      <h3 className="mb-3 font-semibold text-gray-700">User Growth</h3>

      <ResponsiveContainer width="100%" height="85%">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" />
          <YAxis />
          <Tooltip
            formatter={(value, name, props) =>
              tooltipFormatter
                ? tooltipFormatter(value, props.payload)
                : [value.toLocaleString(), name]
            }
          />
          <Area
            type="monotone"
            dataKey="users"
            stroke={strokeColor}
            fill={fillColor}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

UserGrowthChart.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      month: PropTypes.string.isRequired,
      users: PropTypes.number.isRequired,
    })
  ),
  loading: PropTypes.bool,
  strokeColor: PropTypes.string,
  fillColor: PropTypes.string,
  noDataMessage: PropTypes.string,
  tooltipFormatter: PropTypes.func,
};
