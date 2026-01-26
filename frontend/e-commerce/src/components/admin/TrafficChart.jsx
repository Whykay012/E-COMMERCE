// src/components/charts/TrafficChart.jsx
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

// Reusable brand palette
export const TRAFFIC_COLORS = [
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#ef4444", // red-500
  "#8b5cf6", // violet-500
  "#14b8a6", // teal-500
];

// 👇 Custom Tooltip
function CustomTooltip({ active, payload }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white shadow p-2 rounded-md text-sm border">
        <p className="font-semibold text-gray-800">{payload[0].name}</p>
        <p className="text-gray-600">{payload[0].value} visits</p>
      </div>
    );
  }
  return null;
}

export default function TrafficChart({ data = [] }) {
  const hasData = data.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow h-72">
      <h3 className="mb-3 font-semibold text-gray-700">Traffic Analytics</h3>

      {!hasData ? (
        // Skeleton loader
        <div className="flex items-center justify-center h-full animate-pulse">
          <div className="h-32 w-32 rounded-full bg-gray-200" />
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="85%">
          <PieChart>
            <Pie
              data={data}
              dataKey="visits"
              nameKey="source"
              innerRadius={45}
              outerRadius={80}
              paddingAngle={3}
              animationDuration={800}
              animationBegin={200}
            >
              {data.map((_, idx) => (
                <Cell
                  key={`cell-${idx}`}
                  fill={TRAFFIC_COLORS[idx % TRAFFIC_COLORS.length]}
                />
              ))}
            </Pie>

            <Tooltip content={<CustomTooltip />} />
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

TrafficChart.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      source: PropTypes.string.isRequired,
      visits: PropTypes.number.isRequired,
    })
  ),
};
