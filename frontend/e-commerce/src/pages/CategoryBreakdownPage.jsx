import { useSelector } from "react-redux";
import CategoryChart from "../components/admin/CategoryChart";

export default function CategoryBreakdownPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <CategoryChart data={data?.categoryBreakdown} />;
}
