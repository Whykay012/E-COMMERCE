import { useSelector } from "react-redux";
import RecentOrdersTable from "../components/admin/RecentOrder";

export default function RecentOrdersPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <RecentOrdersTable data={data?.recentOrders} />;
}
