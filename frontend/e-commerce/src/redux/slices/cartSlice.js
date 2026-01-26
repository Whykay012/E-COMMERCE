import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// ========================
// Async thunks
// ========================

// Sync cart with backend
export const syncCartWithServer = createAsyncThunk(
  "cart/syncCartWithServer",
  async (cartItems, { rejectWithValue }) => {
    try {
      const res = await api.post("/cart/sync", { items: cartItems });
      return res.data.items;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to sync cart"
      );
    }
  }
);

// Admin: apply global discount
export const applyGlobalDiscount = createAsyncThunk(
  "cart/applyGlobalDiscount",
  async (discount, { rejectWithValue }) => {
    try {
      const res = await api.post("/admin/carts/discount", { discount });
      return discount;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to apply global discount"
      );
    }
  }
);

// Admin: get all carts
export const fetchAllCarts = createAsyncThunk(
  "cart/fetchAllCarts",
  async (_, { rejectWithValue }) => {
    try {
      const res = await api.get("/admin/carts");
      return res.data.carts;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to fetch all carts"
      );
    }
  }
);

// ========================
// Helpers
// ========================
const recalcTotal = (items) =>
  items.reduce((sum, i) => {
    const price = i.product.price || i.product.amount || 0;
    const discountedPrice = price * (1 - (i.discount || 0) / 100);
    return sum + discountedPrice * i.quantity;
  }, 0);

const recalcTax = (total, taxRate = 0.075) => total * taxRate;
const recalcDiscount = (items) =>
  items.reduce((sum, i) => sum + (i.discount || 0), 0);

// ========================
// Initial state
// ========================
const initialState = {
  items: [],
  total: 0,
  tax: 0,
  discount: 0,
  loading: false,
  error: null,
  adminCarts: [],
};

// ========================
// Slice
// ========================
const cartSlice = createSlice({
  name: "cart",
  initialState,
  reducers: {
    // Set cart from server or local storage
    setCartFromServer: (state, action) => {
      state.items = action.payload || [];
      state.total = recalcTotal(state.items);
      state.tax = recalcTax(state.total);
      state.discount = recalcDiscount(state.items);
    },

    // Add item to cart
    addToCart: (state, action) => {
      const {
        product,
        quantity = 1,
        selectedColor = null,
        selectedSize = null,
      } = action.payload;
      const id = product._id || product.id;

      const existing = state.items.find(
        (i) =>
          i.id === id &&
          i.selectedColor === selectedColor &&
          i.selectedSize === selectedSize
      );

      const autoDiscount = product.discount || 0;

      if (existing) {
        existing.quantity += quantity;
        existing.discount = autoDiscount;
      } else {
        state.items.push({
          id,
          product,
          quantity,
          selectedColor,
          selectedSize,
          discount: autoDiscount,
        });
      }

      state.total = recalcTotal(state.items);
      state.tax = recalcTax(state.total);
      state.discount = recalcDiscount(state.items);
    },

    // Remove item from cart by productId + variation
    removeFromCart: (state, action) => {
      const { id, selectedColor = null, selectedSize = null } = action.payload;
      state.items = state.items.filter(
        (i) =>
          !(
            i.id === id &&
            i.selectedColor === selectedColor &&
            i.selectedSize === selectedSize
          )
      );
      state.total = recalcTotal(state.items);
      state.tax = recalcTax(state.total);
      state.discount = recalcDiscount(state.items);
    },

    // Update quantity with stock check
    updateQuantity: (state, action) => {
      const {
        id,
        quantity,
        selectedColor = null,
        selectedSize = null,
        stock = Infinity,
      } = action.payload;
      const item = state.items.find(
        (i) =>
          i.id === id &&
          i.selectedColor === selectedColor &&
          i.selectedSize === selectedSize
      );
      if (item) item.quantity = Math.min(Math.max(1, quantity), stock);

      state.total = recalcTotal(state.items);
      state.tax = recalcTax(state.total);
    },

    // Clear cart
    clearCart: (state) => {
      state.items = [];
      state.total = 0;
      state.tax = 0;
      state.discount = 0;
    },
  },

  extraReducers: (builder) => {
    builder
      // Sync cart
      .addCase(syncCartWithServer.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(syncCartWithServer.fulfilled, (state, action) => {
        state.loading = false;
        state.items = action.payload || [];
        state.total = recalcTotal(state.items);
        state.tax = recalcTax(state.total);
        state.discount = recalcDiscount(state.items);
      })
      .addCase(syncCartWithServer.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // Admin: apply global discount
      .addCase(applyGlobalDiscount.fulfilled, (state, action) => {
        const discount = action.payload;
        state.items.forEach((item) => (item.discount = discount));
        state.total = recalcTotal(state.items);
        state.discount = recalcDiscount(state.items);
      })
      .addCase(applyGlobalDiscount.rejected, (state, action) => {
        state.error = action.payload;
      })

      // Admin: fetch all carts
      .addCase(fetchAllCarts.fulfilled, (state, action) => {
        state.adminCarts = action.payload;
      })
      .addCase(fetchAllCarts.rejected, (state, action) => {
        state.error = action.payload;
      });
  },
});

// ========================
// Export actions & reducer
// ========================
export const {
  addToCart,
  removeFromCart,
  updateQuantity,
  clearCart,
  setCartFromServer,
} = cartSlice.actions;
export default cartSlice.reducer;
