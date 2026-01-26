import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

// ====================================================================
// Mock Data for All Endpoints
// ====================================================================
const mockProfile = { id: 'user-001', firstName: 'Olayinka', lastName: 'Adebayo', email: 'olayinka.a@company.com', phone: '+234 800 123 4567', avatarUrl: 'https://placehold.co/100x100/3b82f6/ffffff?text=OA', twoFactorEnabled: true };
const mockOrders = [
    { id: 'ORD9021', date: '2025-11-20', total: 149.99, status: 'Delivered', items: 3 },
    { id: 'ORD9020', date: '2025-11-15', total: 45.50, status: 'Shipped', items: 1 },
];
const mockAddresses = [{ id: 1, type: 'Home (Default)', line1: '123 E-Commerce Ave', city: 'Lagos', country: 'NG', isDefault: true }];
const mockPayments = [{ id: 'p1', type: 'Visa', last4: '4242', expiry: '12/26', isDefault: true }];
const mockSessions = [{ id: 's1', device: 'Windows 11 / Chrome', location: 'Lagos, Nigeria', lastActive: '2 minutes ago', current: true }];
const mockNotificationsPrefs = { email: { restock: true, promo: false, updates: true }, inApp: { messages: true, priceDrop: false } };
const mockCart = { items: [{ id: 101, name: 'Wireless Headset', price: 79.99, qty: 1 }], total: 79.99 };
const mockWishlist = [{ id: 201, name: 'Smartwatch', price: 199.99 }];
const mockLoyalty = { points: 1250, history: [{ date: '2025-10-01', description: 'Purchase ORD9018', amount: 120 }] };
const mockUserReviews = [
    { id: 501, productId: 'P345', productName: 'Ergonomic Mouse', rating: 5, text: 'Great mouse, very comfortable.', date: '2025-10-25' },
];
const mockReferral = { code: 'OLA2025', referralsCount: 3, totalEarned: 1500, history: [{ date: '2025-11-01', user: 'Jane D.', points: 500 }] };
const mockRecommendations = [{ id: 301, name: 'Travel Bag', price: 89.99 }];


// ====================================================================
// RTK Query API Slice Definition
// ====================================================================

const API_BASE_URL = '/api/'; 
const MOCK_DELAY = 500; // Simulate network latency

const delayedFetchBaseQuery = async (args, api, extraOptions) => {
    await new Promise(resolve => setTimeout(resolve, MOCK_DELAY));
    
    const url = typeof args === 'string' ? args : args.url;
    const method = (typeof args === 'object' && args.method) ? args.method : 'GET';
    
    // --- Dashboard & Account Routes (Existing) ---
    if (url === 'dashboard/profile' && method === 'GET') return { data: mockProfile };
    if (url === 'dashboard/profile' && method === 'PUT') return { data: { ...mockProfile, ...args.body } };
    if (url === 'orders' && method === 'GET') return { data: mockOrders };
    if (url === 'addresses' && method === 'GET') return { data: mockAddresses };
    if (url === 'payment-methods' && method === 'GET') return { data: mockPayments };
    if (url === 'sessions' && method === 'GET') return { data: mockSessions };
    if (url === 'notifications/preferences' && method === 'GET') return { data: mockNotificationsPrefs };
    
    // --- Core E-Commerce Routes (New Coverage) ---
    if (url === 'cart' && method === 'GET') return { data: mockCart };
    if (url === 'wishlist' && method === 'GET') return { data: mockWishlist };
    if (url === 'loyalty/history' && method === 'GET') return { data: mockLoyalty };
    if (url === 'recommendations/foryou' && method === 'GET') return { data: mockRecommendations };

    // --- NEW Feature Routes (Reviews & Referrals) ---
    if (url === 'reviews/mine' && method === 'GET') return { data: mockUserReviews };
    if (url === 'referrals/code' && method === 'GET') return { data: mockReferral };

    // Fallback: Use actual fetch base query
    return fetchBaseQuery({ baseUrl: API_BASE_URL })(args, api, extraOptions);
};

export const userDashboard = createApi({
    reducerPath: 'api',
    baseQuery: delayedFetchBaseQuery,
    tagTypes: ['Profile', 'Orders', 'Addresses', 'Payments', 'Sessions', 'Notifications', 'Cart', 'Wishlist', 'Loyalty', 'Reviews', 'Referrals', 'Recommendations'],
    endpoints: (builder) => ({
        // --- DASHBOARD: PROFILE & AUTH ---
        getProfile: builder.query({ query: () => 'dashboard/profile', providesTags: ['Profile'] }),
        updateProfile: builder.mutation({
            query: (profileData) => ({ url: 'dashboard/profile', method: 'PUT', body: profileData }),
            invalidatesTags: ['Profile'],
        }),
        getSessions: builder.query({ query: () => 'sessions', providesTags: ['Sessions'] }),
        revokeSession: builder.mutation({ query: (sessionId) => ({ url: `sessions/${sessionId}`, method: 'DELETE' }), invalidatesTags: ['Sessions'] }),
        
        // --- DASHBOARD: ORDERS & ADDRESSES ---
        getOrders: builder.query({ query: () => 'orders', providesTags: ['Orders'] }),
        cancelOrder: builder.mutation({ query: (orderId) => ({ url: `orders/${orderId}/cancel`, method: 'POST' }), invalidatesTags: ['Orders'] }),
        getAddresses: builder.query({ query: () => 'addresses', providesTags: ['Addresses'] }),
        deleteAddress: builder.mutation({ query: (addressId) => ({ url: `addresses/${addressId}`, method: 'DELETE' }), invalidatesTags: ['Addresses'] }),

        // --- DASHBOARD: PAYMENTS & NOTIFICATIONS ---
        getPaymentMethods: builder.query({ query: () => 'payment-methods', providesTags: ['Payments'] }),
        getNotificationPreferences: builder.query({ query: () => 'notifications/preferences', providesTags: ['Notifications'] }),
        updateNotificationPreferences: builder.mutation({
            query: (prefs) => ({ url: 'notifications/preferences', method: 'PUT', body: prefs }),
            invalidatesTags: ['Notifications'],
        }),
        markNotificationAsRead: builder.mutation({ query: (id) => ({ url: `notifications/${id}/read`, method: 'PATCH' }), invalidatesTags: ['Notifications'] }),
        markAllNotificationsAsRead: builder.mutation({ query: () => ({ url: 'notifications/read-all', method: 'PATCH' }), invalidatesTags: ['Notifications'] }),

        // --- CORE E-COMMERCE: CART & WISHLIST ---
        getCart: builder.query({ query: () => 'cart', providesTags: ['Cart'] }),
        addToCart: builder.mutation({ query: (item) => ({ url: 'cart/add', method: 'POST', body: item }), invalidatesTags: ['Cart'] }),
        updateCartItem: builder.mutation({ query: ({ productId, qty }) => ({ url: `cart/${productId}`, method: 'PUT', body: { qty } }), invalidatesTags: ['Cart'] }),
        removeFromCart: builder.mutation({ query: (productId) => ({ url: `cart/${productId}`, method: 'DELETE' }), invalidatesTags: ['Cart'] }),
        
        getWishlist: builder.query({ query: () => 'wishlist', providesTags: ['Wishlist'] }),
        addToWishlist: builder.mutation({ query: (productId) => ({ url: 'wishlist', method: 'POST', body: { productId } }), invalidatesTags: ['Wishlist'] }),
        removeFromWishlist: builder.mutation({ query: (productId) => ({ url: `wishlist/${productId}`, method: 'DELETE' }), invalidatesTags: ['Wishlist'] }),

        // --- CORE E-COMMERCE: LOYALTY ---
        getLoyaltyHistory: builder.query({ query: () => 'loyalty/history', providesTags: ['Loyalty'] }),
        redeemLoyaltyPoints: builder.mutation({ query: (amount) => ({ url: 'loyalty/redeem', method: 'POST', body: { amount } }), invalidatesTags: ['Loyalty'] }),

        // --- NEW FEATURE: REVIEWS ---
        getUserReviews: builder.query({ query: () => 'reviews/mine', providesTags: ['Reviews'] }),
        submitReview: builder.mutation({
            query: (reviewData) => ({ url: 'reviews', method: 'POST', body: reviewData }),
            invalidatesTags: ['Reviews'],
        }),
        deleteUserReview: builder.mutation({
            query: (reviewId) => ({ url: `reviews/${reviewId}`, method: 'DELETE' }),
            invalidatesTags: ['Reviews'],
        }),

        // --- NEW FEATURE: REFERRALS ---
        getReferralCode: builder.query({ query: () => 'referrals/code', providesTags: ['Referrals'] }),
        
        // --- NEW FEATURE: RECOMMENDATIONS (Public and Private) ---
        getPersonalRecommendations: builder.query({ query: () => 'recommendations/foryou', providesTags: ['Recommendations'] }),

    }),
});

// Export all necessary hooks
export const {
    useGetProfileQuery, useUpdateProfileMutation, useGetSessionsQuery, useRevokeSessionMutation,
    useGetOrdersQuery, useCancelOrderMutation, useGetAddressesQuery, useDeleteAddressMutation,
    useGetPaymentMethodsQuery, useGetNotificationPreferencesQuery, useUpdateNotificationPreferencesMutation,
    useGetCartQuery, useAddToCartMutation, useUpdateCartItemMutation, useRemoveFromCartMutation,
    useGetWishlistQuery, useAddToWishlistMutation, useRemoveFromWishlistMutation,
    useGetLoyaltyHistoryQuery, useRedeemLoyaltyPointsMutation,
    useGetUserReviewsQuery, useSubmitReviewMutation, useDeleteUserReviewMutation,
    useGetReferralCodeQuery,
    useGetPersonalRecommendationsQuery,
} = userDashboard;