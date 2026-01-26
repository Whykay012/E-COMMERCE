// src/components/admin/MobileDrawer.jsx
import React from "react";
import { useSelector } from "react-redux";
import Sidebar from "./Sidebar";

export default function MobileDrawer() {
  const { mobileOpen } = useSelector((state) => state.ui);

  if (!mobileOpen) return null;

  return (
    <div className="lg:hidden">
      {/* Sidebar itself handles overlay */}
      <Sidebar />
    </div>
  );
}
