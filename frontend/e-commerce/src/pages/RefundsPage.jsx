import { useSelector } from "react-redux";
import RefundsTable from "../components/admin/RefundsTable";

export default function RefundsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <RefundsTable data={data?.refunds} />;
}
