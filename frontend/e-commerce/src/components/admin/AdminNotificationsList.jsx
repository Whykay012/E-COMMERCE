// src/components/notifications/AdminNotificationsList.jsx
import React, { useState } from "react";
import PropTypes from "prop-types";

export default function AdminNotificationsList({
  data = [],
  loading = false,
  noDataMessage = "No notifications available",
  enableFilter = false, // optional toggle for filter dropdown
}) {
  const [filter, setFilter] = useState("all"); // all | unread | read

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

  const filteredData = enableFilter
    ? filter === "all"
      ? data
      : data.filter((n) => (filter === "unread" ? !n.read : n.read))
    : data;

  if (!data.length) {
    return (
      <div className="p-4 bg-white rounded-2xl shadow h-64 flex items-center justify-center text-gray-500">
        {noDataMessage}
      </div>
    );
  }

  return (
    <div className="p-4 bg-white rounded-2xl shadow h-64 overflow-y-auto">
      {enableFilter && (
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
      )}

      {filteredData.length ? (
        <ul className="divide-y divide-gray-200">
          {filteredData.map((note) => (
            <li
              key={note.id}
              className={`py-2 px-3 hover:bg-gray-50 cursor-pointer rounded transition ${
                !note.read ? "bg-gray-50 font-semibold" : ""
              }`}
              onClick={() => note.onClick?.(note)}
            >
              <p className="font-medium text-gray-700">{note.title}</p>
              <div className="text-sm text-gray-700">{note.message}</div>
              {note.date && (
                <div className="text-xs text-gray-400 mt-1">
                  {new Date(note.date).toLocaleString()}
                </div>
              )}
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

AdminNotificationsList.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      title: PropTypes.string.isRequired,
      message: PropTypes.string,
      date: PropTypes.string,
      read: PropTypes.bool,
      onClick: PropTypes.func,
    })
  ),
  loading: PropTypes.bool,
  noDataMessage: PropTypes.string,
  enableFilter: PropTypes.bool,
};
