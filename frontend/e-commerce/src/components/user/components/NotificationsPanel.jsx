export function NotificationsPanel({ notifications }) {
  if (!notifications || !notifications.length || notifications[0].message) {
    return (
      <p className="text-center text-gray-400 p-6">
        {notifications?.[0]?.message || "No notifications"}
      </p>
    );
  }

  return (
    <div className="p-4 bg-white rounded-xl shadow overflow-auto max-h-96">
      <h3 className="font-semibold mb-3">Notifications</h3>
      <ul className="space-y-2">
        {notifications.map((notif) => (
          <li
            key={notif._id}
            className="text-gray-700 hover:bg-gray-50 p-2 rounded transition"
          >
            {notif.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
