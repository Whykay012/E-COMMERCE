import { configureStore } from "@reduxjs/toolkit";
import productReducer from "./slices/productSlice";
import cartReducer from "./slices/cartSlice";
import queryReducer from "./slices/querySlice";
import authReducer from "./slices/authSlice";
import otpReducer from "./slices/otpSlice";
import registerReducer from "./slices/registerSlice";
import paymentReducer from "./slices/paymentSlice";
import notificationsReducer from "./slices/notificatonSlice";
import ordersReducer from "./slices/orderSlice";
import adminProductsReducer from "./slices/adminProductsSlice";
import adminBannersReducer from "./slices/adminBannersSlice";
// FIX 1: Using named import for dashboardReducer
import { dashboardReducer } from "./slices/dashboardSlice"; 
import uploadReducer from "./slices/uplaodSlice";
import adminDashboardReducer from "./slices/adminDashboardSlice";
import uiReducer from "./slices/uiSlice";
import themeReducer from "./slices/themeSlice";
import layoutReducer from "./slices/layoutSlice";

// Import the merged API slice
// FIX 2: Correcting file path and name to target './api/mergedDashboardApiSlice'
import { dashboardApi } from "./slices/dashboardSlice"; 

export const store = configureStore({
 reducer: {
  auth: authReducer,
  products: productReducer,
  cart: cartReducer,
  theme: themeReducer,
  query: queryReducer,
  otp: otpReducer,
  register: registerReducer,
  payment: paymentReducer,
  dashboard: dashboardReducer,
  upload: uploadReducer,
  adminDashboard: adminDashboardReducer,
  notifications: notificationsReducer,
  orders: ordersReducer,
  adminProducts: adminProductsReducer,
  adminBanners: adminBannersReducer,
  layout: layoutReducer,
  ui: uiReducer,

  // Add the merged API reducer
  [dashboardApi.reducerPath]: dashboardApi.reducer,
 },
 middleware: (getDefaultMiddleware) =>
  getDefaultMiddleware().concat(dashboardApi.middleware),
 devTools: process.env.NODE_ENV !== "production",
});

export default store;