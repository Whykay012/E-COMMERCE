import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// 1️⃣ Fetch all notifications
export const fetchNotifications = createAsyncThunk(
  "notifications/fetchAll",
  async (_, { rejectWithValue }) => {
    try {
      const res = await api.get("/notifications");
      return res.data.notifications;
    } catch (err) {
      return rejectWithValue(
        err.response?.data || "Failed to fetch notifications"
      );
    }
  }
);

// 2️⃣ Mark one notification as read
export const markAsRead = createAsyncThunk(
  "notifications/markAsRead",
  async (id, { rejectWithValue }) => {
    try {
      await api.patch(`/notifications/${id}/read`);
      return id; // Return only the ID so we can update Redux directly
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to mark as read");
    }
  }
);

// 3️⃣ Mark ALL notifications as read
export const markAllRead = createAsyncThunk(
  "notifications/markAllRead",
  async (_, { rejectWithValue }) => {
    try {
      await api.patch("/notifications/read-all");
      return true;
    } catch (err) {
      return rejectWithValue(err.response?.data || "Failed to mark all read");
    }
  }
);

const notificationsSlice = createSlice({
  name: "notifications",
  initialState: {
    data: [],
    loading: false,
    error: null,
  },
  reducers: {},

  extraReducers: (builder) => {
    builder
      // Fetch Notifications
      .addCase(fetchNotifications.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.loading = false;
        state.data = action.payload;
      })
      .addCase(fetchNotifications.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // Mark ONE as read
      .addCase(markAsRead.fulfilled, (state, action) => {
        const id = action.payload;
        state.data = state.data.map((n) =>
          n._id === id ? { ...n, isRead: true } : n
        );
      })

      // Mark ALL as read
      .addCase(markAllRead.fulfilled, (state) => {
        state.data = state.data.map((n) => ({ ...n, isRead: true }));
      });
  },
});

export default notificationsSlice.reducer;
