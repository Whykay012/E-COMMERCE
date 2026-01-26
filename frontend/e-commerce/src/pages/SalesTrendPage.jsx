// src/pages/adminDashboard/SalesTrendPage.jsx
import React from "react";
import { useSelector } from "react-redux";
import SalesChart from "../components/admin/SalesChart";

export default function SalesTrendPage() {
  const { data, loading, error } = useSelector((state) => state.adminDashboard);

  if (loading)
    return <div className="p-6 text-center animate-pulse">Loading...</div>;

  if (error) return <div className="p-6 text-center text-red-500">{error}</div>;

  return <SalesChart data={data?.salesInsights || []} />;
}
