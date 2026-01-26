import { useSelector } from "react-redux";
import TopProductsTable from "../components/admin/TopProducts";

export default function TopProductsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <TopProductsTable data={data?.topProducts} />;
}
