// src/features/admin/adminProductsSlice.js
import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

export const fetchAdminProducts = createAsyncThunk(
  "admin/products/fetch",
  async (_, { rejectWithValue }) => {
    try {
      const res = await api.get("/admin/products");
      return res.data.products;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to fetch products");
    }
  }
);

export const deleteAdminProduct = createAsyncThunk(
  "admin/products/delete",
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/admin/products/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to delete product");
    }
  }
);

const adminProductsSlice = createSlice({
  name: "adminProducts",
  initialState: { items: [], loading: false, error: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAdminProducts.pending, (s) => {
        s.loading = true;
      })
      .addCase(fetchAdminProducts.fulfilled, (s, a) => {
        s.loading = false;
        s.items = a.payload;
      })
      .addCase(fetchAdminProducts.rejected, (s, a) => {
        s.loading = false;
        s.error = a.payload;
      })
      .addCase(deleteAdminProduct.fulfilled, (s, a) => {
        s.items = s.items.filter((p) => p._id !== a.payload);
      });
  },
});

export default adminProductsSlice.reducer;
