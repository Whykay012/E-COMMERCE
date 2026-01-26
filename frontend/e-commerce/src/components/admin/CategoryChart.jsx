// src/components/charts/CategoryChart.jsx
import React from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import PropTypes from "prop-types";

const DEFAULT_COLORS = [
  "#3182ce",
  "#38a169",
  "#dd6b20",
  "#e53e3e",
  "#805ad5",
  "#d69e2e",
  "#4fd1c5",
  "#f6ad55",
];

export default function CategoryChart({
  data = [],
  colors = DEFAULT_COLORS,
  innerRadius = 50,
  outerRadius = 80,
  noDataMessage = "No category data available",
  tooltipFormatter,
}) {
  const hasData = Array.isArray(data) && data.length > 0;

  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="p-4 bg-white rounded-2xl shadow h-72">
      <h3 className="mb-3 font-semibold text-gray-700">Category Breakdown</h3>

      {hasData ? (
        <ResponsiveContainer width="100%" height="85%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="category"
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              paddingAngle={3}
              label={({ category, value }) =>
                `${category}: ${((value / total) * 100).toFixed(1)}%`
              }
            >
              {data.map((_, idx) => (
                <Cell
                  key={`cell-${idx}`}
                  fill={colors[idx % colors.length]}
                  stroke="#fff"
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name, props) =>
                tooltipFormatter
                  ? tooltipFormatter(value, props.payload)
                  : [`${value.toLocaleString()}`, props.payload.category]
              }
            />
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center h-60 text-gray-500 text-sm">
          {noDataMessage}
        </div>
      )}
    </div>
  );
}

CategoryChart.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      category: PropTypes.string.isRequired,
      value: PropTypes.number.isRequired,
    })
  ),
  colors: PropTypes.arrayOf(PropTypes.string),
  innerRadius: PropTypes.number,
  outerRadius: PropTypes.number,
  noDataMessage: PropTypes.string,
  tooltipFormatter: PropTypes.func,
};
