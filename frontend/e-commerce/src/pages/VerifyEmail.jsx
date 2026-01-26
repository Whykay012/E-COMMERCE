import { useSelector, useDispatch } from "react-redux";
import { setOtpDigit, setOtpBulk, clearOtp } from "../redux/slices/otpSlice";

import api from "../utils/api";
import { useRef, useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const VerifyEmail = () => {
  const { token } = useParams();
  const otp = useSelector((state) => state.otp.otp);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const inputsRef = useRef([]);
  const [loading, setLoading] = useState(false);
  const [timer, setTimer] = useState(600);
  const [canResend, setCanResend] = useState(false);
  const [shake, setShake] = useState(false);

  // ❗ If no token in URL
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <h1 className="text-2xl font-bold text-red-500 text-center">
          Invalid or expired verification link.
        </h1>
      </div>
    );
  }

  // Countdown timer
  useEffect(() => {
    if (timer <= 0) {
      setCanResend(true);
      return;
    }

    const interval = setInterval(() => setTimer((t) => t - 1), 1000);
    return () => clearInterval(interval);
  }, [timer]);

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const handleChange = (index, value) => {
    if (!/^\d?$/.test(value)) return;

    dispatch(setOtpDigit({ index, value }));

    if (value && index < otp.length - 1) {
      inputsRef.current[index + 1]?.focus();
    }

    const newOtp = [...otp];
    newOtp[index] = value;
    if (newOtp.every((d) => d !== "")) handleSubmit(newOtp.join(""));
  };

  const handleKeyDown = (e, index) => {
    if (e.key === "Backspace") {
      if (otp[index]) {
        dispatch(setOtpDigit({ index, value: "" }));
      } else if (index > 0) {
        inputsRef.current[index - 1]?.focus();
        dispatch(setOtpDigit({ index: index - 1, value: "" }));
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputsRef.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < otp.length - 1) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    const pasteData = e.clipboardData.getData("text").replace(/\D/g, "");
    dispatch(setOtpBulk(pasteData));
    const lastIndex = Math.min(pasteData.length, otp.length) - 1;
    inputsRef.current[lastIndex]?.focus();

    if (pasteData.length >= otp.length)
      handleSubmit(pasteData.slice(0, otp.length));
  };

  // 🔹 handleSubmit
  const handleSubmit = async (otpString) => {
    const payload = otpString || otp.join("");
    if (payload.length !== otp.length) return toast.error("Enter complete OTP");

    try {
      setLoading(true);

      // ✅ Correct template literal for token in URL
      const res = await api.post(`/verify-email/${token}`, {
        // token, // token from URL
        otp: payload,
      });

      toast.success(res.data.message || "Email verified successfully!");
      dispatch(clearOtp());
      navigate("/login"); // or wherever
    } catch (err) {
      setShake(true);
      setTimeout(() => setShake(false), 500);
      toast.error(err.response?.data?.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  // 🔹 handleResendOTP
  const handleResendOTP = async () => {
    try {
      setLoading(true);
      const res = await api.post(`/resend-otp/${token}`);

      // 🔁 Update URL with new token
      const newToken = res.data.token;

      navigate(`/verify-email/${newToken}`, { replace: true });

      setTimer(600);
      setCanResend(false);
      dispatch(clearOtp());
      toast.success(res.data.message);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to resend OTP");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 via-pink-500 to-red-500 flex items-center justify-center p-6 relative overflow-hidden">
      <ToastContainer position="top-center" autoClose={3000} />

      {/* Floating circles */}
      <div className="absolute w-72 h-72 bg-white/20 rounded-full blur-2xl top-10 left-10 animate-pulse" />
      <div className="absolute w-96 h-96 bg-white/10 rounded-full blur-3xl bottom-10 right-10 animate-ping" />

      {/* Main Card */}
      <div className="relative z-10 w-full max-w-2xl p-10 bg-white/20 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/30">
        <h1 className="text-3xl font-extrabold text-white drop-shadow-xl text-center mb-2">
          Verify Your Email
        </h1>

        <p className="text-white/95 text-center mb-8 text-sm md:text-base tracking-wide">
          Enter the OTP sent to your email to complete registration.
        </p>

        <div className="bg-white/85 p-8 rounded-3xl shadow-2xl">
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => e.preventDefault()}
            onPaste={handlePaste}
          >
            {/* OTP Inputs */}
            <div
              className={`flex gap-3 justify-center ${
                shake ? "animate-shake" : ""
              }`}
            >
              {otp.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => (inputsRef.current[i] = el)}
                  value={digit}
                  onChange={(e) => handleChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, i)}
                  maxLength={1}
                  type="text"
                  className="w-14 h-14 text-center text-xl border rounded-md focus:ring-2 focus:ring-purple-500"
                />
              ))}
            </div>

            {/* Verify Button */}
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={otp.some((d) => !d) || loading}
              className={`w-full text-white py-3 rounded-xl transition-all shadow-lg ${
                otp.some((d) => !d) || loading
                  ? "bg-gray-400 cursor-not-allowed"
                  : "bg-purple-600 hover:bg-purple-700"
              }`}
            >
              {loading ? "Verifying..." : "Verify"}
            </button>

            {/* Timer & Resend */}
            <div className="flex items-center justify-between text-sm text-gray-700 mt-2">
              <span>OTP expires in: {formatTime(timer)}</span>
              <button
                type="button"
                onClick={handleResendOTP}
                disabled={!canResend || loading}
                className={`underline text-purple-600 ${
                  !canResend || loading
                    ? "text-gray-400 cursor-not-allowed"
                    : ""
                }`}
              >
                Resend OTP
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default VerifyEmail;
