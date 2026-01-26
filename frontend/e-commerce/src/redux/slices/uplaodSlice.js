// src/redux/slice/uploadSlice.js
import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// ---------- Async thunks ----------
export const uploadAvatar = createAsyncThunk(
  "upload/uploadAvatar",
  async (file, { rejectWithValue }) => {
    try {
      const fd = new FormData();
      fd.append("avatar", file);
      const res = await api.post("/upload/user/avatar", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(err.response?.data || { message: err.message });
    }
  }
);

export const uploadProductImages = createAsyncThunk(
  "upload/uploadProductImages",
  async ({ productId, files }, { rejectWithValue }) => {
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("images", f));
      fd.append("productId", productId);
      const res = await api.post("/upload/admin/product/images", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(err.response?.data || { message: err.message });
    }
  }
);

export const uploadProductVideo = createAsyncThunk(
  "upload/uploadProductVideo",
  async ({ productId, file }, { rejectWithValue }) => {
    try {
      const fd = new FormData();
      fd.append("video", file);
      fd.append("productId", productId);
      const res = await api.post("/upload/admin/product/video", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(err.response?.data || { message: err.message });
    }
  }
);

export const uploadBanner = createAsyncThunk(
  "upload/uploadBanner",
  async ({ title, file, active = true }, { rejectWithValue }) => {
    try {
      const fd = new FormData();
      fd.append("banner", file);
      fd.append("title", title || "");
      fd.append("active", active);
      const res = await api.post("/upload/admin/banner", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(err.response?.data || { message: err.message });
    }
  }
);

export const replaceMedia = createAsyncThunk(
  "upload/replaceMedia",
  async (
    { oldPublicId, file, resource_type = "image", folder },
    { rejectWithValue }
  ) => {
    try {
      const fd = new FormData();
      fd.append("oldPublicId", oldPublicId);
      fd.append("folder", folder || "");
      // file key reused as 'banner' or single file middleware expects 'banner' in some setups:
      fd.append("file", file);
      const res = await api.post("/upload/admin/media/replace", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(err.response?.data || { message: err.message });
    }
  }
);

export const deleteMedia = createAsyncThunk(
  "upload/deleteMedia",
  async ({ publicId, resource_type = "image" }, { rejectWithValue }) => {
    try {
      const res = await api.post("/upload/admin/media/delete", {
        publicId,
        resource_type,
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(err.response?.data || { message: err.message });
    }
  }
);

// ---------- slice ----------
const uploadSlice = createSlice({
  name: "upload",
  initialState: {
    loading: false,
    error: null,
    lastResult: null,
    uploads: [], // history
  },
  reducers: {
    clearUploadState(state) {
      state.loading = false;
      state.error = null;
      state.lastResult = null;
    },
  },
  extraReducers: (builder) => {
    const setPending = (state) => {
      state.loading = true;
      state.error = null;
    };
    const setRejected = (state, action) => {
      state.loading = false;
      state.error = action.payload?.message || action.error?.message;
    };

    // Avatar
    builder.addCase(uploadAvatar.pending, setPending);
    builder.addCase(uploadAvatar.fulfilled, (state, action) => {
      state.loading = false;
      state.lastResult = action.payload;
      state.uploads.unshift({
        type: "avatar",
        result: action.payload,
        time: Date.now(),
      });
    });
    builder.addCase(uploadAvatar.rejected, setRejected);

    // Product images
    builder.addCase(uploadProductImages.pending, setPending);
    builder.addCase(uploadProductImages.fulfilled, (state, action) => {
      state.loading = false;
      state.lastResult = action.payload;
      state.uploads.unshift({
        type: "product-images",
        result: action.payload,
        time: Date.now(),
      });
    });
    builder.addCase(uploadProductImages.rejected, setRejected);

    // Product video
    builder.addCase(uploadProductVideo.pending, setPending);
    builder.addCase(uploadProductVideo.fulfilled, (state, action) => {
      state.loading = false;
      state.lastResult = action.payload;
      state.uploads.unshift({
        type: "product-video",
        result: action.payload,
        time: Date.now(),
      });
    });
    builder.addCase(uploadProductVideo.rejected, setRejected);

    // Banner
    builder.addCase(uploadBanner.pending, setPending);
    builder.addCase(uploadBanner.fulfilled, (state, action) => {
      state.loading = false;
      state.lastResult = action.payload;
      state.uploads.unshift({
        type: "banner",
        result: action.payload,
        time: Date.now(),
      });
    });
    builder.addCase(uploadBanner.rejected, setRejected);

    // replace
    builder.addCase(replaceMedia.pending, setPending);
    builder.addCase(replaceMedia.fulfilled, (state, action) => {
      state.loading = false;
      state.lastResult = action.payload;
    });
    builder.addCase(replaceMedia.rejected, setRejected);

    // delete
    builder.addCase(deleteMedia.pending, setPending);
    builder.addCase(deleteMedia.fulfilled, (state, action) => {
      state.loading = false;
      state.lastResult = action.payload;
    });
    builder.addCase(deleteMedia.rejected, setRejected);
  },
});

export const { clearUploadState } = uploadSlice.actions;
export default uploadSlice.reducer;
