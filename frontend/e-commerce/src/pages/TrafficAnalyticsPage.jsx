import { useSelector } from "react-redux";
import TrafficChart from "../components/admin/TrafficChart";

export default function TrafficAnalyticsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <TrafficChart data={data?.trafficAnalytics} />;
}
