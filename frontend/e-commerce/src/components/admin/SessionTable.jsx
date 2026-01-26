// src/components/SessionsTable.jsx
import React from "react";
import PropTypes from "prop-types";

export default function SessionsTable({ sessions = [], loading = false }) {
  const hasData = sessions && sessions.length > 0;

  return (
    <div className="p-4 bg-white rounded-2xl shadow overflow-x-auto">
      <h3 className="mb-3 font-semibold text-gray-700">Device Sessions</h3>

      {/* ───────────────────────────── */}
      {/* Loading Skeleton */}
      {/* ───────────────────────────── */}
      {loading && (
        <div className="space-y-2">
          {[...Array(3)].map((_, idx) => (
            <div
              key={idx}
              className="h-4 bg-gray-200 rounded animate-pulse w-full"
            ></div>
          ))}
        </div>
      )}

      {/* ───────────────────────────── */}
      {/* No Sessions */}
      {/* ───────────────────────────── */}
      {!loading && !hasData && (
        <p className="text-gray-500 text-sm">No active device sessions.</p>
      )}

      {/* ───────────────────────────── */}
      {/* Sessions Table */}
      {/* ───────────────────────────── */}
      {!loading && hasData && (
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="px-3 py-2">Device</th>
              <th className="px-3 py-2">IP Address</th>
              <th className="px-3 py-2">Last Active</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, idx) => (
              <tr key={idx} className="border-b hover:bg-gray-50">
                <td className="px-3 py-2">
                  <span className="px-2 py-1 bg-blue-100 text-blue-600 font-medium text-xs rounded">
                    {s.device || "Unknown"}
                  </span>
                </td>
                <td className="px-3 py-2">{s.ip || "—"}</td>
                <td className="px-3 py-2">
                  {s.lastActive ? new Date(s.lastActive).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

SessionsTable.propTypes = {
  sessions: PropTypes.arrayOf(
    PropTypes.shape({
      device: PropTypes.string.isRequired,
      ip: PropTypes.string.isRequired,
      lastActive: PropTypes.string.isRequired,
    })
  ),
  loading: PropTypes.bool,
};
