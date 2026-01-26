import { useSelector } from "react-redux";
import DeviceSessionsCard from "../components/admin/DeviceSessionsCard";

export default function DeviceSessionsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <DeviceSessionsCard data={data?.deviceSessions} />;
}
