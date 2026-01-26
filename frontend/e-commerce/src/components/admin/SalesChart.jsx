// src/components/charts/SalesChart.jsx
import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import PropTypes from "prop-types";

/** Custom Tooltip */
function CustomTooltip({ active, payload }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white shadow p-2 rounded-md border text-sm">
        <p className="font-semibold text-gray-800">{payload[0].payload.date}</p>
        {payload.map((p) => (
          <p key={p.dataKey} className="text-gray-600">
            {p.name}: ₦{Number(p.value).toLocaleString()}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

export default function SalesChart({ data = [], compareData = null }) {
  const hasData = data && data.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow h-72">
      <h3 className="mb-3 font-semibold text-gray-700">Sales Trend</h3>

      {!hasData ? (
        <div className="w-full h-60 bg-gray-200 rounded animate-pulse"></div>
      ) : (
        <ResponsiveContainer width="100%" height="85%">
          <LineChart data={data}>
            <CartesianGrid stroke="#f0f0f0" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12, fill: "#4a5568" }}
              minTickGap={20}
            />
            <YAxis tick={{ fontSize: 12, fill: "#4a5568" }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend verticalAlign="bottom" height={36} />

            {/* Main Revenue Line */}
            <Line
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="url(#revenueGradient)"
              strokeWidth={3}
              dot={{ r: 3 }}
              activeDot={{ r: 6 }}
              isAnimationActive={true}
              animationDuration={800}
            />

            {/* Optional: Compare to Previous Period */}
            {compareData && (
              <Line
                type="monotone"
                dataKey="revenue"
                data={compareData}
                name="Prev Period"
                stroke="#a0aec0"
                strokeWidth={2}
                dot={false}
                strokeDasharray="5 5"
              />
            )}

            {/* Gradient Definition */}
            <defs>
              <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3182ce" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#3182ce" stopOpacity={0.3} />
              </linearGradient>
            </defs>
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

SalesChart.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      date: PropTypes.string.isRequired,
      revenue: PropTypes.number.isRequired,
    })
  ),
  compareData: PropTypes.arrayOf(
    PropTypes.shape({
      date: PropTypes.string.isRequired,
      revenue: PropTypes.number.isRequired,
    })
  ),
};
