import { useSelector } from "react-redux";
import InventoryAlertsTable from "../components/admin/InventoryAlert";

export default function InventoryAlertsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <InventoryAlertsTable data={data?.inventoryAlerts} />;
}
