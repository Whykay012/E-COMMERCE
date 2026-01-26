import React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export function TopProductsChart({ data }) {
  if (!data || !data.length || data[0].message) {
    return <p className="text-center text-gray-400 p-6">No top products yet</p>;
  }

  return (
    <div className="p-4 bg-white rounded-xl shadow">
      <h3 className="font-semibold mb-2">Top Products</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="totalSold" fill="#3b82f6" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
