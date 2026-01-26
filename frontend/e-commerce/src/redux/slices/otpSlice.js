import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  otp: Array(6).fill(""), // 6-digit OTP
};

const otpSlice = createSlice({
  name: "otp",
  initialState,
  reducers: {
    setOtpDigit: (state, action) => {
      const { index, value } = action.payload;
      state.otp[index] = value;
    },
    setOtpBulk: (state, action) => {
      // For pasting OTP
      const digits = action.payload.slice(0, state.otp.length).split("");
      state.otp = [
        ...digits,
        ...Array(state.otp.length - digits.length).fill(""),
      ];
    },
    clearOtp: (state) => {
      state.otp = Array(state.otp.length).fill("");
    },
  },
});

export const { setOtpDigit, setOtpBulk, clearOtp } = otpSlice.actions;
export default otpSlice.reducer;
