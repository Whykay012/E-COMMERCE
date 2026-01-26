import { useSelector } from "react-redux";
import DashboardCard from "../components/admin/DashboardCard";

export default function AdminDashboard() {
  const { data, loading, error } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading dashboard...</div>;
  if (error) return <div className="text-red-500">{error}</div>;

  const summary = data?.summary;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <DashboardCard title="Revenue" value={`₦${summary.revenue}`} />
      <DashboardCard title="Orders" value={summary.orders} />
      <DashboardCard title="Customers" value={summary.customers} />
      <DashboardCard title="Refunds" value={summary.refunds} />
      <DashboardCard title="Sales" value={summary.sales} />
    </div>
  );
}
