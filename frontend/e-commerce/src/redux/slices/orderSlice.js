import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// Fetch all orders
export const fetchOrders = createAsyncThunk(
  "orders/fetchOrders",
  async (_, { rejectWithValue }) => {
    try {
      const res = await api.get("/orders");
      return res.data.orders;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to fetch orders");
    }
  }
);

const ordersSlice = createSlice({
  name: "orders",
  initialState: {
    data: [],
    filtered: [],
    loading: false,
    error: null,
  },
  reducers: {
    // Filter by status
    filterByStatus: (state, action) => {
      const status = action.payload;
      state.filtered =
        status === "all"
          ? state.data
          : state.data.filter((o) => o.status === status);
    },

    // Sort orders
    sortOrders: (state, action) => {
      const type = action.payload;

      state.filtered.sort((a, b) => {
        if (type === "date-newest")
          return new Date(b.createdAt) - new Date(a.createdAt);
        if (type === "date-oldest")
          return new Date(a.createdAt) - new Date(b.createdAt);
        if (type === "amount-highest") return b.totalAmount - a.totalAmount;
        if (type === "amount-lowest") return a.totalAmount - b.totalAmount;
        return 0;
      });
    },
  },

  extraReducers: (builder) => {
    builder
      .addCase(fetchOrders.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchOrders.fulfilled, (state, action) => {
        state.loading = false;
        state.data = action.payload;
        state.filtered = action.payload; // default
      })
      .addCase(fetchOrders.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  },
});

export const { filterByStatus, sortOrders } = ordersSlice.actions;
export default ordersSlice.reducer;
