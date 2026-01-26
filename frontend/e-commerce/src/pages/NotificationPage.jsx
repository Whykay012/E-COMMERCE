// src/components/NotificationsPanel.jsx
import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../redux/slices/notificationsSlice";

const NotificationsPanel = () => {
  const dispatch = useDispatch();
  const { data, loading } = useSelector((s) => s.notifications);

  useEffect(() => {
    dispatch(fetchNotifications());
  }, [dispatch]);

  if (loading) return <div>Loading notifications...</div>;

  return (
    <div className="bg-white p-4 rounded shadow">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold">Notifications</h3>
        <button
          className="text-sm text-blue-600"
          onClick={() => dispatch(markAllNotificationsRead())}
        >
          Mark all read
        </button>
      </div>
      <ul>
        {data.map((n) => (
          <li
            key={n._id}
            className={`p-3 border-b ${n.read ? "bg-gray-50" : "bg-white"}`}
          >
            <div className="flex justify-between">
              <div>
                <p className="font-medium">{n.title || "Notification"}</p>
                <p className="text-sm text-gray-500">{n.body || n.message}</p>
              </div>
              {!n.read && (
                <button
                  className="text-sm text-blue-600"
                  onClick={() => dispatch(markNotificationRead(n._id))}
                >
                  Mark read
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default NotificationsPanel;
