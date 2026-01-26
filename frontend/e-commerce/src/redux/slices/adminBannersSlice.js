// src/features/admin/adminBannersSlice.js
import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

export const fetchBanners = createAsyncThunk(
  "admin/banners/fetch",
  async (_, { rejectWithValue }) => {
    try {
      const res = await api.get("/admin/banners");
      return res.data.banners;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to fetch banners");
    }
  }
);

export const uploadBanner = createAsyncThunk(
  "admin/banners/upload",
  async (formData, { rejectWithValue }) => {
    try {
      const res = await api.post("/admin/banner/festive", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data.banner;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to upload banner");
    }
  }
);

export const deleteBanner = createAsyncThunk(
  "admin/banners/delete",
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/admin/banner/festive/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to delete banner");
    }
  }
);

const adminBannersSlice = createSlice({
  name: "adminBanners",
  initialState: { items: [], loading: false, error: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchBanners.pending, (s) => {
        s.loading = true;
      })
      .addCase(fetchBanners.fulfilled, (s, a) => {
        s.loading = false;
        s.items = a.payload;
      })
      .addCase(fetchBanners.rejected, (s, a) => {
        s.loading = false;
        s.error = a.payload;
      })
      .addCase(uploadBanner.fulfilled, (s, a) => {
        s.items.unshift(a.payload);
      })
      .addCase(deleteBanner.fulfilled, (s, a) => {
        s.items = s.items.filter((b) => b._id !== a.payload);
      });
  },
});

export default adminBannersSlice.reducer;
