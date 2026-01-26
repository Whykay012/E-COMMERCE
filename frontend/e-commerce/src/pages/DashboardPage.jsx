import React from "react";
import {
  useGetDashboardSummaryQuery,
  useGetUserDashboardQuery,
} from "../redux/slices/dashboardSlice";
import DashboardCards from "../components/Dashboard/DashboardCards";
import TopProductsChart from "../components/Dashboard/TopProductsChart";
import SalesInsightsChart from "../components/Dashboard/SalesInsightsChart";
import RecentActivities from "../components/Dashboard/RecentActivities";
import NotificationsPanel from "../components/Dashboard/NotificationsPanel";
import RecentlyViewedCarousel from "../components/Dashboard/RecentlyViewedCarousel";
import { notifyError } from "../utils/notify";

export default function DashboardPage() {
  const {
    data: summary,
    isLoading: summaryLoading,
    error: summaryError,
  } = useGetDashboardSummaryQuery();
  const {
    data: dashboard,
    isLoading: dashboardLoading,
    error: dashboardError,
  } = useGetUserDashboardQuery();

  if (summaryError || dashboardError) {
    notifyError("Failed to load dashboard data");
  }

  if (summaryLoading || dashboardLoading) {
    return (
      <div className="text-center py-20 text-gray-500">
        Loading dashboard...
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Dashboard Cards */}
      <DashboardCards summary={summary} />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TopProductsChart data={dashboard.topProducts} />
        <SalesInsightsChart data={dashboard.salesInsights} />
      </div>

      {/* Activities & Notifications */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentActivities activities={dashboard.activityLog} />
        <NotificationsPanel notifications={dashboard.notifications} />
      </div>

      {/* Recently Viewed Products */}
      <RecentlyViewedCarousel products={dashboard.recentlyViewed} />
    </div>
  );
}
