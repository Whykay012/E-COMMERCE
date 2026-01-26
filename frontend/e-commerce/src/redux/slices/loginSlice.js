// // src/redux/authSlice.js
// import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
// import api from "../../utils/api";

// // ✅ Always send cookies with requests
// api.defaults.withCredentials = true;

// // 🔹 Login user
// export const loginUser = createAsyncThunk(
//   "auth/loginUser",
//   async (credentials, { rejectWithValue }) => {
//     try {
//       const res = await api.post("/auth/login", credentials, {
//         withCredentials: true,
//       });
//       return res.data; // { token, message, existingUser }
//     } catch (err) {
//       return rejectWithValue(err.response?.data?.message || "Login failed");
//     }
//   }
// );

// // 🔹 Fetch current session
// export const fetchCurrentUser = createAsyncThunk(
//   "auth/fetchCurrentUser",
//   async (_, { rejectWithValue }) => {
//     try {
//       const res = await api.get("/auth/me", { withCredentials: true });
//       return res.data.user; // should return user info from backend
//     } catch (err) {
//       return rejectWithValue("Session expired or not logged in");
//     }
//   }
// );

// // 🔹 Logout user
// export const logoutUser = createAsyncThunk(
//   "auth/logoutUser",
//   async (_, { rejectWithValue }) => {
//     try {
//       await api.post("/auth/logout", {}, { withCredentials: true });
//       return true;
//     } catch (err) {
//       return rejectWithValue("Logout failed");
//     }
//   }
// );

// const initialState = {
//   user: null,
//   isAuthenticated: false,
//   loading: false,
//   error: "",
// };

// const authSlice = createSlice({
//   name: "auth",
//   initialState,
//   reducers: {},
//   extraReducers: (builder) => {
//     builder
//       // 🔹 Login
//       .addCase(loginUser.pending, (state) => {
//         state.loading = true;
//         state.error = "";
//       })
//       .addCase(loginUser.fulfilled, (state, action) => {
//         state.loading = false;
//         state.user = action.payload.existingUser;
//         state.isAuthenticated = true;
//       })
//       .addCase(loginUser.rejected, (state, action) => {
//         state.loading = false;
//         state.error = action.payload;
//         state.isAuthenticated = false;
//       })

//       // 🔹 Fetch current user
//       .addCase(fetchCurrentUser.fulfilled, (state, action) => {
//         state.user = action.payload;
//         state.isAuthenticated = true;
//       })
//       .addCase(fetchCurrentUser.rejected, (state) => {
//         state.user = null;
//         state.isAuthenticated = false;
//       })

//       // 🔹 Logout
//       .addCase(logoutUser.fulfilled, (state) => {
//         state.user = null;
//         state.isAuthenticated = false;
//       });
//   },
// });

// export default authSlice.reducer;
