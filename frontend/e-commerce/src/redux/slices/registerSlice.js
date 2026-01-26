import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// ================================
// 🔹 Register user
// ================================
export const registerUser = createAsyncThunk(
  "register/registerUser",
  async (formData, { rejectWithValue }) => {
    const response = await api.post("/register", formData, {
      withCredentials: true,
    });
    return response.data; // { message, token }
  }
);

// ================================
// 🔹 Verify OTP / Email  (FIXED)
// ================================
export const verifyOtp = createAsyncThunk(
  "register/verifyOtp",
  async ({ token, otp }, { rejectWithValue }) => {
    try {
      const response = await api.post(
        "/verify-email",
        { token, otp }, // ✅ FIXED
        { withCredentials: true }
      );
      return response.data; // { message, user, token }
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "OTP verification failed"
      );
    }
  }
);

const initialState = {
  formData: {
    firstName: "",
    middleName: "",
    lastName: "",
    username: "",
    email: "",
    phone: "",
    country: "",
    countryCode: "",
    state: "",
    address: "",
    age: "",
    dob: "",
    password: "",
    confirmPassword: "",
  },
  loading: false,
  error: "",
  success: "",
  verifying: false,
  verified: false,
  token: "", // store verification token
  user: null,
};

const registerSlice = createSlice({
  name: "register",
  initialState,
  reducers: {
    setFormData: (state, action) => {
      state.formData = { ...state.formData, ...action.payload };
    },
    clearForm: (state) => {
      state.formData = { ...initialState.formData };
      state.error = "";
      state.success = "";
      state.verified = false;
      state.token = "";
    },
  },
  extraReducers: (builder) => {
    builder
      // 🔹 Register
      .addCase(registerUser.pending, (state) => {
        state.loading = true;
        state.error = "";
        state.success = "";
      })
      .addCase(registerUser.fulfilled, (state, action) => {
        state.loading = false;
        state.success = action.payload.message || "Registration successful";
        state.token = action.payload.token || ""; // store token for navigation
        state.error = "";
      })
      .addCase(registerUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
        state.success = "";
      })

      // 🔹 Verify OTP
      .addCase(verifyOtp.pending, (state) => {
        state.verifying = true;
        state.error = "";
        state.verified = false;
      })
      .addCase(verifyOtp.fulfilled, (state, action) => {
        state.verifying = false;
        state.verified = true;
        state.success = action.payload.message || "Email verified successfully";
        state.user = action.payload.user;
        state.token = action.payload.token || ""; // update token if backend returns a new one
        state.error = "";
      })
      .addCase(verifyOtp.rejected, (state, action) => {
        state.verifying = false;
        state.verified = false;
        state.error = action.payload;
      });
  },
});

export const { setFormData, clearForm } = registerSlice.actions;
export default registerSlice.reducer;
