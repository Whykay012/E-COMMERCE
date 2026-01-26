// src/routes/AnimatedRoutes.jsx
import React from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";

// Layouts
import Layout from "../components/wallet/Layout";
import AdminLayout from "../components/admin/AdminLayout";

// Pages
import Home from "../pages/Home";
import Product from "../pages/Product";
import Cart from "../pages/Cart";
import Payment from "../pages/PaymentPage";
import VerifyEmail from "../pages/VerifyEmail";
import Login from "../pages/Login";
import Register from "../pages/Register";
import NotFound from "../pages/NotFound";

// User dashboard pages
import Dashboard from "../pages/DashboardPage";
import Orders from "../pages/OrdersPage";
import Wallet from "../pages/WalletPage";
import Profile from "../pages/profile";
import Products from "../pages/Products";
import Tickets from "../pages/Tickets";

// Admin pages
import SalesTrendPage from "../pages/SalesTrendPage";
import CategoryBreakdownPage from "../pages/CategoryBreakdownPage";
import TrafficAnalyticsPage from "../pages/TrafficAnalyticsPage";
import TopProductsPage from "../pages/TopProductsPage";
import RecentOrdersPage from "../pages/RecentOrdersPage";
import NotificationsPage from "../pages/NotificationsPage";
import DeviceSessionsPage from "../pages/DeviceSessionsPage";
import InventoryAlertsPage from "../pages/InventoryAlertsPage";
import VendorStatsPage from "../pages/VendorStatsPage";
import RefundsPage from "../pages/RefundsPage";
import AvatarUploadPage from "../pages/AvatarUploadPage";
import ProductImageUploadPage from "../pages/ProductImageUploadPage";
import ProductVideoUploadPage from "../pages/ProductVideoUploadPage";
import BannerUploadPage from "../pages/BannerUploadPage";

// Guards
import PersistLogin from "../components/PersistLogin";
import ProtectedRoute from "./ProtectedRoute";
import AdminRoute from "./AdminRoute";

export default function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        {/* Wrap with PersistLogin */}
        <Route element={<PersistLogin />}>
          {/* Public routes */}
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/product/:id" element={<Product />} />
            <Route path="/cart" element={<Cart />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
          </Route>

          {/* Protected user routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/payment" element={<Payment />} />
              <Route path="/verify-email/:token" element={<VerifyEmail />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/wallet" element={<Wallet />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/products" element={<Products />} />
              <Route path="/tickets" element={<Tickets />} />
            </Route>
          </Route>

          {/* Admin routes */}
          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<AdminLayout />}>
              <Route path="charts/sales-trend" element={<SalesTrendPage />} />
              <Route
                path="charts/category-breakdown"
                element={<CategoryBreakdownPage />}
              />
              <Route
                path="charts/traffic-analytics"
                element={<TrafficAnalyticsPage />}
              />
              <Route path="charts/top-products" element={<TopProductsPage />} />
              <Route
                path="charts/recent-orders"
                element={<RecentOrdersPage />}
              />
              <Route
                path="charts/notifications"
                element={<NotificationsPage />}
              />
              <Route
                path="charts/device-sessions"
                element={<DeviceSessionsPage />}
              />
              <Route
                path="charts/inventory-alerts"
                element={<InventoryAlertsPage />}
              />
              <Route path="charts/vendor-stats" element={<VendorStatsPage />} />
              <Route path="charts/refunds" element={<RefundsPage />} />
              <Route path="avatar" element={<AvatarUploadPage />} />
              <Route
                path="product-images"
                element={<ProductImageUploadPage />}
              />
              <Route
                path="product-video"
                element={<ProductVideoUploadPage />}
              />
              <Route path="banner" element={<BannerUploadPage />} />
            </Route>
          </Route>
        </Route>

        {/* Fallback 404 */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AnimatePresence>
  );
}
