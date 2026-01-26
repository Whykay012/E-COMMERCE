// src/components/layout/AdminLayout.jsx
import React, { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import Sidebar from "../admin/Sidebar";
import TopNavbar from "../admin/TopNavbar";
import MobileDrawer from "../admin/MobileDrawer";
import { fetchAdminDashboard } from "../../redux/slices/adminDashboardSlice";
import { closeMobile } from "../../redux/slices/uiSlice";

export default function AdminLayout() {
  const dispatch = useDispatch();
  const { mobileOpen } = useSelector((state) => state.ui);

  useEffect(() => {
    // Fetch admin dashboard data
    dispatch(fetchAdminDashboard());
  }, [dispatch]);

  // Close mobile drawer on clicking outside
  const handleBackdropClick = () => {
    dispatch(closeMobile());
  };

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Desktop Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopNavbar />

        <main className="p-6 overflow-auto flex-1">
          <Suspense
            fallback={<div className="text-center py-10">Loading...</div>}
          >
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Mobile Drawer with backdrop */}
      <div
        className={`fixed inset-0 z-20 lg:hidden transition ${
          mobileOpen ? "block" : "hidden"
        }`}
        onClick={handleBackdropClick}
      />
      {mobileOpen && <MobileDrawer />}
    </div>
  );
}
