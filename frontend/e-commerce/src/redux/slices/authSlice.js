// // src/redux/slices/authSlice.js
// import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
// import api from "../../utils/api";

// // Always send cookies with requests
// api.defaults.withCredentials = true;

// // -------------------------------------------------------------
// // LOGIN
// // -------------------------------------------------------------
// export const loginUser = createAsyncThunk(
//   "auth/loginUser",
//   async (credentials, { rejectWithValue }) => {
//     try {
//       const res = await api.post("/login", credentials);
//       // backend sets HTTP-only cookie here
//       return res.data.user;
//     } catch (err) {
//       return rejectWithValue(err.response?.data?.message || "Login failed");
//     }
//   }
// );

// // -------------------------------------------------------------
// // FETCH CURRENT LOGGED-IN USER (COOKIE BASED)
// // -------------------------------------------------------------
// export const fetchCurrentUser = createAsyncThunk(
//   "auth/fetchCurrentUser",
//   async (_, { rejectWithValue }) => {
//     try {
//       const res = await api.get("/auth/me");
//       return res.data.user;
//     } catch (err) {
//       return rejectWithValue("Not authenticated");
//     }
//   }
// );

// // -------------------------------------------------------------
// // LOGOUT
// // -------------------------------------------------------------
// export const logoutUser = createAsyncThunk(
//   "auth/logoutUser",
//   async (_, { rejectWithValue }) => {
//     try {
//       await api.post("/logout");
//       return true;
//     } catch (err) {
//       return rejectWithValue("Logout failed");
//     }
//   }
// );

// // -------------------------------------------------------------
// // VERIFY EMAIL (OPTIONAL FEATURE)
// // -------------------------------------------------------------
// export const verifyEmail = createAsyncThunk(
//   "auth/verifyEmail",
//   async ({ email, otp }, { rejectWithValue }) => {
//     try {
//       const res = await api.post("/verify-email", { email, otp });
//       return res.data.message;
//     } catch (error) {
//       return rejectWithValue(
//         error.response?.data?.message || "Verification failed"
//       );
//     }
//   }
// );

// // -------------------------------------------------------------
// // INITIAL STATE
// // -------------------------------------------------------------
// const initialState = {
//   user: null,
//   isAuthenticated: false,
//   loading: false,
//   verifying: false,
//   verified: false,
//   message: "",
//   error: "",
// };

// // -------------------------------------------------------------
// // AUTH SLICE (final secure version)
// // -------------------------------------------------------------
// const authSlice = createSlice({
//   name: "auth",
//   initialState,
//   reducers: {
//     logoutLocal: (state) => {
//       // clears Redux memory only
//       state.user = null;
//       state.isAuthenticated = false;
//       state.verified = false;
//       state.message = "";
//       state.error = "";
//     },
//   },

//   extraReducers: (builder) => {
//     builder

//       // -------------------------
//       // LOGIN
//       // -------------------------
//       .addCase(loginUser.pending, (state) => {
//         state.loading = true;
//         state.error = "";
//       })
//       .addCase(loginUser.fulfilled, (state, action) => {
//         state.loading = false;
//         state.user = action.payload;
//         state.isAuthenticated = true;
//       })
//       .addCase(loginUser.rejected, (state, action) => {
//         state.loading = false;
//         state.user = null;
//         state.isAuthenticated = false;
//         state.error = action.payload;
//       })

//       // -------------------------
//       // FETCH CURRENT USER
//       // -------------------------
//       .addCase(fetchCurrentUser.pending, (state) => {
//         state.loading = true;
//       })
//       .addCase(fetchCurrentUser.fulfilled, (state, action) => {
//         state.loading = false;
//         state.user = action.payload;
//         state.isAuthenticated = true;
//       })
//       .addCase(fetchCurrentUser.rejected, (state) => {
//         state.loading = false;
//         state.user = null;
//         state.isAuthenticated = false;
//       })

//       // -------------------------
//       // LOGOUT
//       // -------------------------
//       .addCase(logoutUser.fulfilled, (state) => {
//         state.user = null;
//         state.isAuthenticated = false;
//       })

//       // -------------------------
//       // VERIFY EMAIL
//       // -------------------------
//       .addCase(verifyEmail.pending, (state) => {
//         state.verifying = true;
//         state.verified = false;
//         state.error = "";
//       })
//       .addCase(verifyEmail.fulfilled, (state, action) => {
//         state.verifying = false;
//         state.verified = true;
//         state.message = action.payload;
//       })
//       .addCase(verifyEmail.rejected, (state, action) => {
//         state.verifying = false;
//         state.verified = false;
//         state.error = action.payload;
//       });
//   },
// });

// export const { logoutLocal } = authSlice.actions;
// export default authSlice.reducer;

// src/redux/slices/authSlice.js
import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

/**
 * Frontend workflow (cookie-based):
 * - loginUser sends credentials to server. Server sets httpOnly cookie (JWT/session).
 * - fetchCurrentUser calls /auth/me to get user details from cookie.
 * - logoutUser calls /logout to clear cookie server-side.
 *
 * Note: FRONTEND should NEVER store tokens. We optionally persist a minimal user profile
 * (non-sensitive) if you want offline display, but it's disabled by default.
 */

// -------------- Async thunks --------------
export const loginUser = createAsyncThunk(
  "auth/loginUser",
  async (credentials, { rejectWithValue }) => {
    try {
      // server should respond with user object (no token required in payload)
      const res = await api.post("/login", credentials);
      return res.data; // expected { user, message } or { existingUser, ... }
    } catch (err) {
      // prefer backend message || generic
      const msg = err.response?.data?.message || err.message || "Login failed";
      return rejectWithValue(msg);
    }
  }
);

export const fetchCurrentUser = createAsyncThunk(
  "auth/fetchCurrentUser",
  async (_, { rejectWithValue }) => {
    try {
      // server reads cookie and returns user
      const res = await api.get("/auth/me");
      return res.data.user || res.data;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Not authenticated"
      );
    }
  }
);

export const logoutUser = createAsyncThunk(
  "auth/logoutUser",
  async (_, { rejectWithValue }) => {
    try {
      await api.post("/logout"); // server clears cookie
      return true;
    } catch (err) {
      return rejectWithValue(err.response?.data?.message || "Logout failed");
    }
  }
);

// -------------- Slice --------------
const initialState = {
  user: null, // current user object (id, username, role, etc.)
  isAuthenticated: false,
  loading: false, // general loading
  authChecking: true, // used by PersistLogin to check session on app start
  error: null,
  // optional: toggle to persist minimal profile client-side (non-sensitive)
  persistProfile: false,
};

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    // optional local setter (non-sensitive only)
    setPersistProfile(state, action) {
      state.persistProfile = !!action.payload;
      if (!state.persistProfile) {
        localStorage.removeItem("userProfile");
      }
    },
    // clear only client-side state (doesn't call server)
    clearAuthState(state) {
      state.user = null;
      state.isAuthenticated = false;
      state.error = null;
    },
    // set user manually if needed
    setUser(state, action) {
      state.user = action.payload;
      state.isAuthenticated = !!action.payload;
      if (state.persistProfile && action.payload) {
        try {
          localStorage.setItem("userProfile", JSON.stringify(action.payload));
        } catch (e) {}
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // loginUser
      .addCase(loginUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(loginUser.fulfilled, (state, action) => {
        state.loading = false;
        // backend may return { user, message } or similar
        const user =
          action.payload?.user ||
          action.payload?.existingUser ||
          action.payload;
        state.user = user || null;
        state.isAuthenticated = !!user;
        state.error = null;
        if (state.persistProfile && user) {
          try {
            localStorage.setItem("userProfile", JSON.stringify(user));
          } catch (e) {}
        }
      })
      .addCase(loginUser.rejected, (state, action) => {
        state.loading = false;
        state.user = null;
        state.isAuthenticated = false;
        state.error = action.payload || action.error?.message;
      })

      // fetchCurrentUser
      .addCase(fetchCurrentUser.pending, (state) => {
        state.authChecking = true;
        state.error = null;
      })
      .addCase(fetchCurrentUser.fulfilled, (state, action) => {
        state.authChecking = false;
        state.user = action.payload || null;
        state.isAuthenticated = !!action.payload;
        if (state.persistProfile && action.payload) {
          try {
            localStorage.setItem("userProfile", JSON.stringify(action.payload));
          } catch (e) {}
        }
      })
      .addCase(fetchCurrentUser.rejected, (state) => {
        state.authChecking = false;
        state.user = null;
        state.isAuthenticated = false;
      })

      // logoutUser
      .addCase(logoutUser.fulfilled, (state) => {
        state.user = null;
        state.isAuthenticated = false;
        state.error = null;
        if (state.persistProfile) localStorage.removeItem("userProfile");
      })
      .addCase(logoutUser.rejected, (state, action) => {
        state.error = action.payload || action.error?.message;
      });
  },
});

export const { setPersistProfile, clearAuthState, setUser } = authSlice.actions;

export const selectCurrentUser = (state) => state.auth.user;
export const selectIsAuthenticated = (state) => state.auth.isAuthenticated;
export const selectAuthLoading = (state) =>
  state.auth.loading || state.auth.authChecking;

export default authSlice.reducer;
