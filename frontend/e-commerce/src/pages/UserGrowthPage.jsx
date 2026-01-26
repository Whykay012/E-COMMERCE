import { useSelector } from "react-redux";
import UserGrowthChart from "../components/admin/UserGrowthChart";

export default function UserGrowthPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <UserGrowthChart data={data?.userGrowth} />;
}
