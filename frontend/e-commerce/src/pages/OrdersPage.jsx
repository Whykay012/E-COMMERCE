// src/pages/OrdersPage.jsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import OrdersTable from "../components/Orders/OrdersTable";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";
import Pagination from "../components/common/Pagination";
import {
  useGetUserOrdersQuery,
  useCancelOrderMutation,
} from "../redux/slices/dashboardApiSlice";
import { notifyError, notifySuccess } from "../utils/notify";
import { io } from "../socket/socket"; // reusable socket instance

export const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Shipped", value: "shipped" },
  { label: "Delivered", value: "delivered" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Failed", value: "failed" },
];

export const STATUS_META = {
  pending: { label: "Pending", color: "bg-yellow-100 text-yellow-800" },
  processing: { label: "Processing", color: "bg-blue-100 text-blue-800" },
  shipped: { label: "Shipped", color: "bg-indigo-100 text-indigo-800" },
  delivered: { label: "Delivered", color: "bg-green-100 text-green-800" },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-800" },
  failed: { label: "Failed", color: "bg-gray-100 text-gray-800" },
};

export default function OrdersPage() {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [localOrders, setLocalOrders] = useState([]);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Fetch orders with backend pagination, search & filters
  const { data, error, isLoading, isFetching, refetch } = useGetUserOrdersQuery(
    {
      page,
      limit,
      status: statusFilter === "all" ? undefined : statusFilter,
      search: search || undefined,
    },
    { pollingInterval: 10000 }
  );

  const [cancelOrder] = useCancelOrderMutation();
  const tableRef = useRef(null);

  // API error handling
  useEffect(() => {
    if (error) notifyError(error?.data?.message || "Failed to load orders");
  }, [error]);

  // Socket.io auto-refresh
  useEffect(() => {
    io.on("orderUpdated", () => {
      notifySuccess("Orders updated");
      refetch();
    });
    return () => io.off("orderUpdated");
  }, [refetch]);

  const ordersRaw = data?.orders || [];

  // Filtered orders (optimistic, search, local filtering)
  const filteredOrders = useMemo(() => {
    let list = Array.isArray(ordersRaw) ? ordersRaw : [];
    if (statusFilter !== "all")
      list = list.filter((o) => o.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (o) =>
          o.id.toLowerCase().includes(q) ||
          (o.items &&
            o.items.some((it) => (it.name || "").toLowerCase().includes(q)))
      );
    }
    return list;
  }, [ordersRaw, statusFilter, search]);

  // Sync filtered orders for optimistic UI
  useEffect(() => {
    setLocalOrders(filteredOrders);
    setHighlightedIndex(-1);
  }, [filteredOrders]);

  const totalCount = data?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  const openOrder = (id) => setSelectedOrderId(id);
  const closeOrder = () => setSelectedOrderId(null);

  const handleCancelOrder = async (orderId, e) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to cancel this order?")) return;

    const previousOrders = [...localOrders];
    setLocalOrders(localOrders.filter((o) => o.id !== orderId));

    try {
      await cancelOrder(orderId).unwrap();
      notifySuccess("Order cancelled successfully");
      refetch();
    } catch (err) {
      notifyError(err?.data?.message || "Failed to cancel order");
      setLocalOrders(previousOrders);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (!localOrders.length) return;
    if (e.key === "ArrowDown") {
      setHighlightedIndex((i) => (i + 1) % localOrders.length);
    } else if (e.key === "ArrowUp") {
      setHighlightedIndex(
        (i) => (i - 1 + localOrders.length) % localOrders.length
      );
    } else if (e.key === "Enter") {
      if (highlightedIndex >= 0) openOrder(localOrders[highlightedIndex].id);
    }
  };

  useEffect(() => {
    const current = tableRef.current;
    current?.addEventListener("keydown", handleKeyDown);
    return () => current?.removeEventListener("keydown", handleKeyDown);
  }, [localOrders, highlightedIndex]);

  // Reset page whenever filter, search, or limit changes
  useEffect(() => {
    setPage(1);
  }, [statusFilter, search, limit]);

  return (
    <div
      ref={tableRef}
      tabIndex={0}
      className="p-4 sm:p-6 lg:p-8 space-y-6 outline-none"
    >
      {/* Header: Title, search, filters */}
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Your Orders</h1>
          <p className="text-sm text-gray-500">
            View and manage your order history
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by order ref, product, address..."
            className="w-full sm:w-64 px-3 py-2 rounded-lg border focus:ring focus:outline-none"
            aria-label="Search orders"
          />

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border"
            aria-label="Filter orders by status"
          >
            {STATUS_OPTIONS.map((s) => (
              <option value={s.value} key={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="px-3 py-2 rounded-lg border"
            aria-label="Select orders per page"
          >
            {[5, 10, 20, 50].map((n) => (
              <option value={n} key={n}>
                {n} / page
              </option>
            ))}
          </select>
        </div>
      </header>

      <section>
        {isLoading && (
          <div className="text-center py-10">Loading orders...</div>
        )}
        {!isLoading && (
          <>
            <OrdersTable
              orders={localOrders}
              loading={isLoading || isFetching}
              onOpenOrder={openOrder}
              onCancelOrder={handleCancelOrder}
              highlightedIndex={highlightedIndex}
              statusMeta={STATUS_META}
            />
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-gray-500">
                Showing {localOrders.length} of {totalCount} orders
              </div>
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
              />
            </div>
          </>
        )}
      </section>

      {selectedOrderId && (
        <OrderDetailsModal
          open={!!selectedOrderId}
          orderId={selectedOrderId}
          onClose={closeOrder}
        />
      )}
    </div>
  );
}
// Step 4: Wallet & Payments

// Wallet balance (useGetWalletQuery)

// Payment history (useGetPaymentHistoryQuery)

// Initialize & verify payments (useInitializePaymentMutation, useVerifyPaymentQuery)

// UI: Cards + tables + modals for payment
// 1. RTK Query Integration

// Wallet Balance: useGetWalletQuery

// Payment History: useGetPaymentHistoryQuery

// Payment Initialization: useInitializePaymentMutation

// Payment Verification: useVerifyPaymentQuery

// Optimistic UI:

// For wallet updates after payment, immediately update balance in UI and roll back on error.

// Invalidates / Provides Tags:

// Payment mutations invalidate the Wallet and PaymentHistory queries to refresh data automatically.

// 2. UI Components

// Cards: show wallet balance, key metrics like total spent, total received, pending payments.

// Tables: list payment history (sortable, paginated, searchable), use Pagination like your OrdersPage.

// Modals: for payment initialization, verification, and detailed transaction view.

// Forms: for initiating payment (amount, method, etc.) with validation.

// Notifications: use your notifySuccess / notifyError utilities.

// Example Component Structure:

// WalletPage.jsx
//  ├─ WalletCards.jsx           # Wallet balance, metrics
//  ├─ PaymentHistoryTable.jsx   # Table with pagination, search, filters
//  ├─ PaymentModal.jsx          # For initiating / verifying payments
//  ├─ Pagination.jsx            # Reusable like OrdersPage
//  └─ Toast/Notification.jsx    # notifySuccess / notifyError

// 3. Functionalities

// Socket.io:

// Listen for walletUpdated events from backend to auto-refresh wallet and payments table.

// Webhook:

// Backend triggers a webhook when payment succeeds; frontend receives via Socket.io.

// Keyboard & Focus:

// Modals trap focus; arrow keys navigate table rows (Up/Down) and pages (Left/Right).

// Search & Filter:

// Filter by payment status (pending, completed, failed) and date.

// Responsive:

// Same breakpoints as OrdersPage: @1260px, @960px, @768px, @540px.

// 4. UX & Design

// Minimalist, modern, soft shadows, rounded corners.

// Hover animations on cards, buttons, table rows.

// Clear CTA buttons for Pay, Verify, View Details.

// Accessibility: color contrast, keyboard navigation, screen reader labels.

// 5. Redux State Example
// wallet: {
//   balance: 5000,
//   currency: "NGN",
//   lastUpdated: "2025-11-20T15:00:00Z",
//   transactions: [
//     { id: "txn1", amount: 1000, status: "success", type: "credit", date: "2025-11-19" },
//     { id: "txn2", amount: 500, status: "pending", type: "debit", date: "2025-11-18" },
//   ],
// }


// Use providesTags for Wallet and PaymentHistory so mutations auto-refresh.

// 6. Key Features Carried Over from OrdersPage

// ✅ RTK Query with caching, polling, and tags.

// ✅ Optimistic UI (e.g., deduct from balance immediately after initiating payment).

// ✅ Socket.io live updates for payments & wallet.

// ✅ Focus trap inside modals.

// ✅ Webhook handler updates payment status.

// ✅ Arrow Up/Down for row selection in table, Arrow Left/Right for pagination.

// Step 5: Profile & Settings

// Profile info (useGetUserDashboardQuery → user data)

// Update profile & change password (useUpdateProfileMutation, useChangePasswordMutation)

// Upload avatar (useUploadProfilePicMutation)

// Sessions management (useGetSessionsQuery, useRevokeSessionMutation, useRevokeAllSessionsMutation)

// Step 6: Products Page

// Products list (useGetProductsQuery)

// Random/Top products (useGetRandomProductsQuery, useGetTopProductsQuery)

// Product details (useGetProductByIdQuery)

// Add to cart/wishlist

// Step 7: Support Tickets

// List tickets (useListTicketsQuery)

// Create, close, reopen, delete, bulk close tickets

// Modal forms for tickets

// Step 8: Notifications & Activities

// Notifications (useGetNotificationsQuery, useMarkAsReadMutation)

// Activities (useListActivitiesQuery)

// UI: List + badges + filters

// Step 9: Cart & Wishlist

// Cart table (useGetCartQuery)

// Update, remove, sync (useUpdateCartItemMutation, etc.)

// Wishlist (useGetWishlistQuery, useAddToWishlistMutation)

// Step 10: Loyalty

// Loyalty points history (useGetLoyaltyHistoryQuery)

// Redeem/award points (useRedeemPointsMutation, useAwardPointsMutation)

// ✅ Why this approach is optimal:

// Single API slice handles all data → no redundant fetches.

// RTK Query caching avoids unnecessary network calls.

// Reusable UI components (cards, tables, modals) → consistent and fast.

// Responsive Tailwind + Recharts → visually appealing dashboards.

// Pagination, filtering, and CRUD built-in → fully functional app.

// Olayinka, if you want, we can start with Step 1 and I can write the fully functional Navbar + Sidebar + Dashboard page with charts and cards, fully integrated with your mergedDashboardApiSlice.