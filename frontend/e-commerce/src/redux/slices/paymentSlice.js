// src/redux/slices/paymentSlice.js
import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// ================================
// 🔹 Async Thunks
// ================================

// Fetch wallet and history
export const fetchWalletData = createAsyncThunk(
  "payment/fetchWalletData",
  async (_, { rejectWithValue }) => {
    try {
      const walletRes = await api.get("/payment/wallet");
      const historyRes = await api.get("/payment/history");
      return {
        wallet: walletRes.data,
        history: historyRes.data.payments || [],
      };
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to fetch wallet data"
      );
    }
  }
);

// Initialize payment
export const initializePayment = createAsyncThunk(
  "payment/initialize",
  async (amount, { rejectWithValue }) => {
    try {
      const res = await api.post("/payment/initialize", { amount });
      return res.data;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Payment initialization failed"
      );
    }
  }
);

// Verify payment (renamed to match your JSX import)
export const verifyPayment = createAsyncThunk(
  "payment/verify",
  async (reference, { rejectWithValue }) => {
    try {
      const res = await api.get(`/payment/verify?reference=${reference}`);
      return res.data;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Payment verification failed"
      );
    }
  }
);

// ================================
// ⚙️ Slice Definition
// ================================
const slice = createSlice({
  name: "payment",
  initialState: {
    wallet: { balance: 0 },
    history: [],
    reference: null,
    authorization_url: null,
    loading: false,
    error: null,
    message: null,
  },
  reducers: {
    clearPaymentMessage: (state) => {
      state.message = null;
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch wallet & history
      .addCase(fetchWalletData.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchWalletData.fulfilled, (state, action) => {
        state.loading = false;
        state.wallet = action.payload.wallet;
        state.history = action.payload.history;
      })
      .addCase(fetchWalletData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // Initialize payment
      .addCase(initializePayment.pending, (state) => {
        state.loading = true;
        state.error = null;
        state.message = null;
      })
      .addCase(initializePayment.fulfilled, (state, action) => {
        state.loading = false;
        state.reference =
          action.payload.reference || action.payload.data?.reference || null;
        state.authorization_url =
          action.payload.authorization_url ||
          action.payload.data?.authorization_url ||
          null;
        state.message = action.payload.message || "Payment initialized";
      })
      .addCase(initializePayment.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // Verify payment
      .addCase(verifyPayment.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(verifyPayment.fulfilled, (state, action) => {
        state.loading = false;
        state.message = action.payload.message;

        // Update wallet if provided
        if (action.payload.updatedWallet) {
          state.wallet = action.payload.updatedWallet;
        }

        // Optionally refresh history if provided
        if (action.payload.data?.payments) {
          state.history = action.payload.data.payments;
        }
      })
      .addCase(verifyPayment.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  },
});

// ================================
// 🚀 Export Actions & Reducer
// ================================
export const { clearPaymentMessage } = slice.actions;
export default slice.reducer;
