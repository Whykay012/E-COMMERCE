// src/redux/api/mergedDashboardApiSlice.js
import { createApi } from "@reduxjs/toolkit/query/react";
import api from "../../utils/api"; // Axios instance with withCredentials: true

const axiosBaseQuery =
  ({ baseUrl } = { baseUrl: "" }) =>
  async ({ url, method = "GET", data, params, headers }) => {
    try {
      const result = await api({
        url: baseUrl + url,
        method,
        data,
        params,
        headers,
      });
      return { data: result.data };
    } catch (axiosError) {
      let err = axiosError;
      return {
        error: {
          status: err.response?.status,
          data: err.response?.data || err.message,
        },
      };
    }
  };

const TAGS = {
  DASHBOARD: [
    "User",
    "Wallet",
    "Orders",
    "Cart",
    "Wishlist",
    "Notifications",
    "Loyalty",
    "RecentlyViewed",
    "Tickets",
    "Activities",
    "Addresses",
    "Payments",
    "TopProducts",
    "SalesInsights",
  ],
  PROFILE: ["User", "Profile"],
  WALLET: ["Wallet", "Payments", "Orders", "Cart"],
  ORDERS: ["Orders", "Cart", "Wallet"],
  CART: ["Cart"],
  ADDRESSES: ["Addresses"],
  WISHLIST: ["Wishlist"],
  RECENTLY_VIEWED: ["RecentlyViewed"],
  NOTIFICATIONS: ["Notifications"],
  LOYALTY: ["Loyalty"],
  TICKETS: ["Tickets"],
  ACTIVITIES: ["Activities"],
  SESSIONS: ["Sessions"],
  PRODUCTS: ["Products"],
};

export const dashboardApi = createApi({
  reducerPath: "dashboardApi",
  baseQuery: axiosBaseQuery({
    baseUrl: process.env.REACT_APP_API_URL || "/api",
  }),
  tagTypes: [
    ...TAGS.DASHBOARD,
    ...TAGS.PROFILE,
    ...TAGS.WALLET,
    ...TAGS.ORDERS,
    ...TAGS.CART,
    ...TAGS.ADDRESSES,
    ...TAGS.WISHLIST,
    ...TAGS.RECENTLY_VIEWED,
    ...TAGS.NOTIFICATIONS,
    ...TAGS.LOYALTY,
    ...TAGS.TICKETS,
    ...TAGS.ACTIVITIES,
    ...TAGS.SESSIONS,
    ...TAGS.PRODUCTS,
  ],
  endpoints: (builder) => ({
    // ---------------- DASHBOARD ----------------
    getUserDashboard: builder.query({
      query: ({
        wishlistPage = 1,
        ordersPage = 1,
        notificationsPage = 1,
        paymentsPage = 1,
        sessionsPage = 1,
        limit = 5,
      } = {}) => ({
        url: "/dashboard",
        params: {
          wishlistPage,
          ordersPage,
          notificationsPage,
          paymentsPage,
          sessionsPage,
          limit,
        },
      }),
      providesTags: TAGS.DASHBOARD,
    }),
    getDashboardSummary: builder.query({
      query: () => "/dashboard/summary",
      providesTags: [
        "User",
        "Wallet",
        "Orders",
        "Cart",
        "Wishlist",
        "Notifications",
      ],
    }),

    // ---------------- PROFILE ----------------
    updateProfile: builder.mutation({
      query: (data) => ({
        url: "/profile/update-profile",
        method: "PUT",
        data,
      }),
      invalidatesTags: TAGS.PROFILE,
    }),
    changePassword: builder.mutation({
      query: (data) => ({
        url: "/profile/change-password",
        method: "PATCH",
        data,
      }),
      invalidatesTags: TAGS.PROFILE,
    }),
    uploadProfilePic: builder.mutation({
      query: (formData) => ({
        url: "/profile/avatar",
        method: "POST",
        data: formData,
        headers: { "Content-Type": "multipart/form-data" },
      }),
      invalidatesTags: TAGS.PROFILE,
    }),

    // ---------------- WALLET / PAYMENTS ----------------
    // ---------------- WALLET / PAYMENTS ----------------
    getWallet: builder.query({
      query: () => "/payment/wallet",
      providesTags: ["Wallet"],
    }),
    initializePayment: builder.mutation({
      query: (data) => ({ url: "/payment/initiate", method: "POST", data }),
      invalidatesTags: ["Wallet", "Payments"],
    }),
    verifyPayment: builder.query({
      query: (reference) => `/payment/verify?reference=${reference}`,
      providesTags: ["Wallet", "Payments", "Orders"],
    }),
    getPaymentHistory: builder.query({
      query: ({ page = 1, limit = 20 }) =>
        `/payment/history?page=${page}&limit=${limit}`,
      providesTags: (result) =>
        result?.payments
          ? [
              ...result.payments.map((p) => ({ type: "Payments", id: p._id })),
              { type: "Payments", id: "LIST" },
            ]
          : [{ type: "Payments", id: "LIST" }],
    }),

    // ---------------- ORDERS ----------------

    // ------------------------------------------
    // USER: GET ORDERS (Search, Filters, Pagination)
    // ------------------------------------------
    getUserOrders: builder.query({
      query: ({ page = 1, limit = 10, status, search }) => {
        const params = new URLSearchParams();
        params.append("page", page);
        params.append("limit", limit);
        if (status) params.append("status", status);
        if (search) params.append("search", search);

        return {
          url: `/orders/user?${params.toString()}`,
          method: "GET",
        };
      },

      providesTags: (result) =>
        result?.orders
          ? [
              ...result.orders.map((o) => ({ type: "Order", id: o._id })),
              { type: "Orders", id: "LIST" },
            ]
          : [{ type: "Orders", id: "LIST" }],
    }),

    // ------------------------------------------
    // USER: GET ORDER BY ID
    // ------------------------------------------
    getOrderById: builder.query({
      query: (orderId) => `/orders/${orderId}`,
      providesTags: (result, error, id) => [{ type: "Order", id }],
    }),

    // ------------------------------------------
    // USER: CREATE ORDER
    // ------------------------------------------
    createOrder: builder.mutation({
      query: (data) => ({
        url: "/orders",
        method: "POST",
        data,
      }),

      // Refresh LIST + CART (because new order is placed)
      invalidatesTags: [{ type: "Orders", id: "LIST" }, "Cart", "Payments"],
    }),

    // ------------------------------------------
    // USER: CANCEL ORDER
    // ------------------------------------------
    cancelOrder: builder.mutation({
      query: (orderId) => ({
        url: `/orders/${orderId}/cancel`,
        method: "PATCH",
      }),

      invalidatesTags: (result, error, id) => [
        { type: "Order", id },
        { type: "Orders", id: "LIST" },
      ],
    }),

    // ===================================================================
    // ADMIN ORDER MANAGEMENT
    // ===================================================================

    // ------------------------------------------
    // ADMIN: LIST ORDERS (Filters, Search, Date Range)
    // ------------------------------------------
    adminGetOrders: builder.query({
      query: ({
        page = 1,
        limit = 20,
        status,
        search,
        startDate,
        endDate,
        sort = "-createdAt",
      }) => {
        const params = new URLSearchParams();
        params.append("page", page);
        params.append("limit", limit);
        params.append("sort", sort);
        if (status) params.append("status", status);
        if (search) params.append("search", search);
        if (startDate) params.append("startDate", startDate);
        if (endDate) params.append("endDate", endDate);

        return {
          url: `/admin/orders?${params.toString()}`,
          method: "GET",
        };
      },

      providesTags: (result) =>
        result?.orders
          ? [
              ...result.orders.map((o) => ({ type: "Order", id: o._id })),
              { type: "Orders", id: "ADMIN_LIST" },
            ]
          : [{ type: "Orders", id: "ADMIN_LIST" }],
    }),

    // ------------------------------------------
    // ADMIN: GET SINGLE ORDER
    // ------------------------------------------
    adminGetOrderById: builder.query({
      query: (orderId) => `/admin/orders/${orderId}`,
      providesTags: (result, error, id) => [{ type: "Order", id }],
    }),

    // ------------------------------------------
    // ADMIN: UPDATE ORDER STATUS
    // (Processing, Shipped, Delivered, etc.)
    // ------------------------------------------
    adminUpdateOrderStatus: builder.mutation({
      query: ({ orderId, status }) => ({
        url: `/admin/orders/${orderId}/status`,
        method: "PATCH",
        data: { status },
      }),

      invalidatesTags: (result, error, id) => [
        { type: "Order", id },
        { type: "Orders", id: "ADMIN_LIST" },
      ],
    }),

    // ---------------- CART ----------------
    getCart: builder.query({ query: () => "/cart", providesTags: TAGS.CART }),
    addToCart: builder.mutation({
      query: (data) => ({ url: "/cart/add", method: "POST", data }),
      invalidatesTags: TAGS.CART,
    }),
    updateCartItem: builder.mutation({
      query: ({ productId, ...data }) => ({
        url: `/cart/${productId}`,
        method: "PUT",
        data,
      }),
      invalidatesTags: TAGS.CART,
    }),
    removeCartItem: builder.mutation({
      query: (productId) => ({ url: `/cart/${productId}`, method: "DELETE" }),
      invalidatesTags: TAGS.CART,
    }),
    syncCart: builder.mutation({
      query: (data) => ({ url: "/cart/sync", method: "POST", data }),
      invalidatesTags: TAGS.CART,
    }),

    // ---------------- ADDRESSES ----------------
    listAddresses: builder.query({
      query: () => "/addresses",
      providesTags: TAGS.ADDRESSES,
    }),
    getAddress: builder.query({
      query: (id) => `/addresses/${id}`,
      providesTags: TAGS.ADDRESSES,
    }),
    createAddress: builder.mutation({
      query: (data) => ({ url: "/addresses", method: "POST", data }),
      invalidatesTags: TAGS.ADDRESSES,
    }),
    updateAddress: builder.mutation({
      query: ({ id, ...data }) => ({
        url: `/addresses/${id}`,
        method: "PUT",
        data,
      }),
      invalidatesTags: TAGS.ADDRESSES,
    }),
    deleteAddress: builder.mutation({
      query: (id) => ({ url: `/addresses/${id}`, method: "DELETE" }),
      invalidatesTags: TAGS.ADDRESSES,
    }),

    // ---------------- WISHLIST ----------------
    getWishlist: builder.query({
      query: () => "/wishlist",
      providesTags: TAGS.WISHLIST,
    }),
    addToWishlist: builder.mutation({
      query: (data) => ({ url: "/wishlist", method: "POST", data }),
      invalidatesTags: TAGS.WISHLIST,
    }),
    removeFromWishlist: builder.mutation({
      query: (productId) => ({
        url: `/wishlist/${productId}`,
        method: "DELETE",
      }),
      invalidatesTags: TAGS.WISHLIST,
    }),

    // ---------------- RECENTLY VIEWED ----------------
    listRecentlyViewed: builder.query({
      query: () => "/recently-viewed",
      providesTags: TAGS.RECENTLY_VIEWED,
    }),
    addRecentlyViewed: builder.mutation({
      query: (data) => ({ url: "/recently-viewed", method: "POST", data }),
      invalidatesTags: TAGS.RECENTLY_VIEWED,
    }),
    removeRecentlyViewed: builder.mutation({
      query: (id) => ({ url: `/recently-viewed/${id}`, method: "DELETE" }),
      invalidatesTags: TAGS.RECENTLY_VIEWED,
    }),

    // ---------------- NOTIFICATIONS ----------------
    getNotifications: builder.query({
      query: () => "/notifications",
      providesTags: TAGS.NOTIFICATIONS,
    }),
    markAsRead: builder.mutation({
      query: (id) => ({ url: `/notifications/${id}/read`, method: "PATCH" }),
      invalidatesTags: TAGS.NOTIFICATIONS,
    }),
    markAllRead: builder.mutation({
      query: () => ({ url: "/notifications/read-all", method: "PATCH" }),
      invalidatesTags: TAGS.NOTIFICATIONS,
    }),

    // ---------------- LOYALTY ----------------
    getLoyaltyHistory: builder.query({
      query: () => "/loyalty/history",
      providesTags: TAGS.LOYALTY,
    }),
    awardPoints: builder.mutation({
      query: (data) => ({ url: "/loyalty/award", method: "POST", data }),
      invalidatesTags: TAGS.LOYALTY,
    }),
    redeemPoints: builder.mutation({
      query: (data) => ({ url: "/loyalty/redeem", method: "POST", data }),
      invalidatesTags: TAGS.LOYALTY,
    }),

    // ---------------- SUPPORT TICKETS ----------------
    listTickets: builder.query({
      query: () => "/support-tickets",
      providesTags: TAGS.TICKETS,
    }),
    getTicket: builder.query({
      query: (id) => `/support-tickets/${id}`,
      providesTags: TAGS.TICKETS,
    }),
    createTicket: builder.mutation({
      query: (data) => ({ url: "/support-tickets", method: "POST", data }),
      invalidatesTags: TAGS.TICKETS,
    }),
    closeTicket: builder.mutation({
      query: (id) => ({ url: `/support-tickets/${id}/close`, method: "PUT" }),
      invalidatesTags: TAGS.TICKETS,
    }),
    reopenTicket: builder.mutation({
      query: (id) => ({ url: `/support-tickets/${id}/reopen`, method: "PUT" }),
      invalidatesTags: TAGS.TICKETS,
    }),
    deleteTicket: builder.mutation({
      query: (id) => ({ url: `/support-tickets/${id}`, method: "DELETE" }),
      invalidatesTags: TAGS.TICKETS,
    }),
    bulkCloseTickets: builder.mutation({
      query: (ticketIds) => ({
        url: "/support-tickets/bulk-close",
        method: "PUT",
        data: { ticketIds },
      }),
      invalidatesTags: TAGS.TICKETS,
    }),

    // ---------------- ACTIVITY LOGS ----------------
    listActivities: builder.query({
      query: () => "/activity-logs",
      providesTags: TAGS.ACTIVITIES,
    }),

    // ---------------- SESSIONS ----------------
    getSessions: builder.query({
      query: () => "/sessions",
      providesTags: TAGS.SESSIONS,
    }),
    revokeSession: builder.mutation({
      query: (id) => ({ url: `/sessions/${id}`, method: "DELETE" }),
      invalidatesTags: TAGS.SESSIONS,
    }),
    revokeAllSessions: builder.mutation({
      query: () => ({ url: "/sessions", method: "DELETE" }),
      invalidatesTags: TAGS.SESSIONS,
    }),

    // ---------------- TOP PRODUCTS / SALES INSIGHTS ----------------
    getTopProducts: builder.query({
      query: () => "/dashboard/top-products",
      providesTags: ["TopProducts"],
    }),
    getSalesInsights: builder.query({
      query: () => "/dashboard/sales-insights",
      providesTags: ["SalesInsights"],
    }),

    // ---------------- PRODUCTS ----------------
    getProducts: builder.query({
      query: (params = {}) => ({ url: "/products", params }),
      providesTags: TAGS.PRODUCTS,
    }),
    getRandomProducts: builder.query({
      query: (count = 10) => `/products/random?count=${count}`,
      providesTags: TAGS.PRODUCTS,
    }),
    getProductById: builder.query({
      query: (id) => `/products/${id}`,
      providesTags: TAGS.PRODUCTS,
    }),
  }),
});

export const {
  useGetUserDashboardQuery,
  useGetDashboardSummaryQuery,
  useUpdateProfileMutation,
  useChangePasswordMutation,
  useUploadProfilePicMutation,
  useGetWalletQuery,
  useInitializePaymentMutation,
  useVerifyPaymentQuery,
  useGetPaymentHistoryQuery,
  useGetUserOrdersQuery,
  useGetOrderByIdQuery,
  useCreateOrderMutation,
  useGetCartQuery,
  useAddToCartMutation,
  useUpdateCartItemMutation,
  useRemoveCartItemMutation,
  useSyncCartMutation,
  useListAddressesQuery,
  useGetAddressQuery,
  useCreateAddressMutation,
  useUpdateAddressMutation,
  useDeleteAddressMutation,
  useGetWishlistQuery,
  useAddToWishlistMutation,
  useRemoveFromWishlistMutation,
  useListRecentlyViewedQuery,
  useAddRecentlyViewedMutation,
  useRemoveRecentlyViewedMutation,
  useGetNotificationsQuery,
  useMarkAsReadMutation,
  useMarkAllReadMutation,
  useGetLoyaltyHistoryQuery,
  useAwardPointsMutation,
  useRedeemPointsMutation,
  useListTicketsQuery,
  useGetTicketQuery,
  useCreateTicketMutation,
  useCloseTicketMutation,
  useReopenTicketMutation,
  useDeleteTicketMutation,
  useBulkCloseTicketsMutation,
  useListActivitiesQuery,
  useGetSessionsQuery,
  useRevokeSessionMutation,
  useRevokeAllSessionsMutation,
  useGetTopProductsQuery,
  useGetSalesInsightsQuery,
  useGetProductsQuery,
  useGetRandomProductsQuery,
  useGetProductByIdQuery,
  useCancelOrderMutation,
} = dashboardApi;
