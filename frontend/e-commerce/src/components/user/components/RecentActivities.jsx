export function RecentActivities({ activities }) {
  if (!activities || !activities.length || activities[0].message) {
    return (
      <p className="text-center text-gray-400 p-6">
        {activities?.[0]?.message || "No recent activity"}
      </p>
    );
  }

  return (
    <div className="p-4 bg-white rounded-xl shadow overflow-auto max-h-96">
      <h3 className="font-semibold mb-3">Recent Activities</h3>
      <ul className="space-y-2">
        {activities.map((act) => (
          <li
            key={act._id}
            className="text-gray-700 hover:bg-gray-50 p-2 rounded transition"
          >
            {act.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
