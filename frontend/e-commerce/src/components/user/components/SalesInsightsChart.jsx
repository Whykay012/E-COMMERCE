import React from "react";
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";

export function SalesInsightsChart({ data }) {
  if (!data || !data.length) {
    return <p className="text-center text-gray-400 p-6">No sales data yet</p>;
  }

  return (
    <div className="p-4 bg-white rounded-xl shadow">
      <h3 className="font-semibold mb-2">Sales Insights</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <XAxis dataKey="_id" />
          <YAxis />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="totalSales"
            stroke="#10b981"
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
