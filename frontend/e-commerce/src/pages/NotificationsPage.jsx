import { useSelector } from "react-redux";
import AdminNotificationsList from "../components/admin/AdminNotificationsList";

export default function NotificationsPage() {
  const { data, loading } = useSelector((state) => state.adminDashboard);

  if (loading) return <div>Loading...</div>;

  return <AdminNotificationsList data={data?.notifications} />;
}
