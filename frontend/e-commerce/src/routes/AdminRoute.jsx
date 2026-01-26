// src/routes/AdminRoute.jsx
import React from "react";
import { useSelector } from "react-redux";
import { Navigate, Outlet, useLocation } from "react-router-dom";

/**
 * Use for admin-only routes. Reads user from Redux.
 * <Route element={<AdminRoute />}>
 *   <Route path="/admin" element={<AdminLayout />} />
 * </Route>
 */
export default function AdminRoute({
  redirectTo = "/login",
  requiredRole = "admin",
}) {
  const user = useSelector((state) => state.auth.user);
  const location = useLocation();

  if (!user) {
    return <Navigate to={redirectTo} replace state={{ from: location }} />;
  }

  if (requiredRole && user.role !== requiredRole) {
    // you can replace with a nicer "Access denied" page/component
    return (
      <div className="p-8">
        Access denied — you do not have permission to view this page.
      </div>
    );
  }

  return <Outlet />;
}
