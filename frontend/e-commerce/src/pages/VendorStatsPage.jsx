import { useSelector } from "react-redux";
import VendorStatsChart from "../components/admin/VendorStats";

export default function VendorStatsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <VendorStatsChart data={data?.vendorStats} />;
}
