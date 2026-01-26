// src/components/sessions/DeviceSessionsCard.jsx
import React from "react";
import PropTypes from "prop-types";

export default function DeviceSessionsCard({
  data = [],
  loading = false,
  noDataMessage = "No active sessions",
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, idx) => (
          <div
            key={idx}
            className="p-4 bg-white rounded-2xl shadow animate-pulse h-32"
          ></div>
        ))}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-500">
        {noDataMessage}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {data.map((session) => (
        <div
          key={session.id}
          className="p-4 bg-white rounded-2xl shadow hover:shadow-md transition cursor-pointer"
          onClick={() => session.onClick?.(session)} // optional click handler
        >
          <p className="text-sm text-gray-700">
            <strong>Device:</strong> {session.device}
          </p>
          <p className="text-sm text-gray-700">
            <strong>IP:</strong> {session.ip}
          </p>
          <p className="text-sm text-gray-500 mt-1">
            <strong>Last Active:</strong>{" "}
            {new Date(session.lastActive).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}

DeviceSessionsCard.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      device: PropTypes.string.isRequired,
      ip: PropTypes.string.isRequired,
      lastActive: PropTypes.string.isRequired,
      onClick: PropTypes.func,
    })
  ),
  loading: PropTypes.bool,
  noDataMessage: PropTypes.string,
};
