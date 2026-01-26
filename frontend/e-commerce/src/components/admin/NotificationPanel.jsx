import React, { useState } from "react";
import PropTypes from "prop-types";

export default function NotificationsPanel({
  notifications = [],
  loading = false,
  noDataMessage = "No notifications available",
}) {
  const [filter, setFilter] = useState("all");

  if (loading) {
    return (
      <div className="p-4 bg-white rounded-2xl shadow h-64 overflow-y-auto">
        <h3 className="mb-3 font-semibold text-gray-700">Notifications</h3>
        <div className="space-y-2">
          {[...Array(5)].map((_, idx) => (
            <div key={idx} className="h-4 bg-gray-200 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const filteredNotifications =
    filter === "all"
      ? notifications
      : notifications.filter((n) => (filter === "unread" ? !n.read : n.read));

  if (!notifications.length) {
    return (
      <div className="p-4 bg-white rounded-2xl shadow h-64 flex items-center justify-center text-gray-500">
        {noDataMessage}
      </div>
    );
  }

  return (
    <div className="p-4 bg-white rounded-2xl shadow h-64 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-700">Notifications</h3>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="border rounded p-1 text-sm"
        >
          <option value="all">All</option>
          <option value="unread">Unread</option>
          <option value="read">Read</option>
        </select>
      </div>

      {filteredNotifications.length ? (
        <ul className="divide-y divide-gray-200">
          {filteredNotifications.map((note) => (
            <li
              key={note.id}
              className={`py-2 px-3 hover:bg-gray-50 cursor-pointer rounded transition ${
                !note.read ? "bg-gray-50 font-semibold" : ""
              }`}
              onClick={() => note.onClick?.(note)}
            >
              <div className="text-sm text-gray-700">{note.message}</div>
              <div className="text-xs text-gray-400 mt-1">
                {new Date(note.date).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-center text-gray-400 py-10">
          No notifications to show
        </div>
      )}
    </div>
  );
}

NotificationsPanel.propTypes = {
  notifications: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      message: PropTypes.string.isRequired,
      date: PropTypes.string.isRequired,
      read: PropTypes.bool,
      onClick: PropTypes.func,
    })
  ),
  loading: PropTypes.bool,
  noDataMessage: PropTypes.string,
};
