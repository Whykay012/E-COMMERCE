import { useDispatch, useSelector } from "react-redux";
import { setFormData, registerUser } from "../redux/slices/registerSlice";
import Select from "react-select";
import PhoneInput from "react-phone-input-2";
import "react-phone-input-2/lib/style.css";
import countryList from "react-select-country-list";
import { useState, useMemo, useEffect } from "react";
import { FaEye, FaEyeSlash } from "react-icons/fa";
import { useNavigate } from "react-router-dom";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { clearForm } from "../redux/slices/registerSlice"; // import this

const Register = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { formData, loading, error, success, token } = useSelector(
    (state) => state.register
  );

  useEffect(() => {
    dispatch(clearForm());
  }, [dispatch]);

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // ===== Password Strength Logic ===== //
  const passwordChecks = useMemo(() => {
    const value = formData.password || "";
    return {
      length: value.length >= 12,
      upper: /[A-Z]/.test(value),
      lower: /[a-z]/.test(value),
      number: /\d/.test(value),
      special: /[@$!%*?&.,]/.test(value),
    };
  }, [formData.password]);

  const strengthScore = Object.values(passwordChecks).filter(Boolean).length;

  const strengthBarColor =
    strengthScore <= 2
      ? "bg-red-500"
      : strengthScore === 3
      ? "bg-yellow-500"
      : strengthScore === 4
      ? "bg-blue-500"
      : "bg-green-500";

  const strengthLabel =
    strengthScore <= 2
      ? "Weak"
      : strengthScore === 3
      ? "Fair"
      : strengthScore === 4
      ? "Good"
      : "Strong";

  // ===== Navigate to VerifyEmail on success ===== //
  useEffect(() => {
    if (success && token) {
      toast.success("Registration successful! Please verify your email.");
      const timer = setTimeout(() => {
        navigate(`/verify-email/${token}`);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [success, token, navigate]);

  // ===== Form Events ===== //
  const handleChange = (e) => {
    dispatch(setFormData({ [e.target.name]: e.target.value }));
  };

  const handleCountryChange = (selected) => {
    dispatch(setFormData({ country: selected.label }));
  };

  const handlePhoneChange = (val) => {
    dispatch(setFormData({ phone: val }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    dispatch(registerUser(formData));
  };

  const countryOptions = countryList().getData();

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 via-pink-500 to-red-500 flex items-center justify-center p-6 relative overflow-hidden">
      <ToastContainer position="top-center" autoClose={3000} />

      {/* Floating circles */}
      <div className="absolute w-72 h-72 bg-white/20 rounded-full blur-2xl top-10 left-10 animate-pulse" />
      <div className="absolute w-96 h-96 bg-white/10 rounded-full blur-3xl bottom-10 right-10 animate-ping" />

      {/* Main Card */}
      <div className="relative z-10 w-full max-w-4xl p-10 bg-white/20 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/30">
        <h1 className="text-4xl font-extrabold text-white drop-shadow-xl text-center mb-2">
          Create Your Account
        </h1>

        <p className="text-white/95 text-center mb-8 text-sm md:text-base tracking-wide">
          Join our marketplace and enjoy smarter shopping — exclusive deals,
          fast checkout, and personalized recommendations.
        </p>

        {/* Alerts */}
        {error && (
          <p className="text-red-200 font-semibold mb-4 text-center">{error}</p>
        )}
        {success && (
          <p className="text-green-200 font-semibold mb-4 text-center">
            {success}
          </p>
        )}
        {loading && (
          <p className="text-blue-200 font-semibold mb-4 text-center">
            Submitting...
          </p>
        )}

        <div className="bg-white/85 p-8 rounded-3xl shadow-2xl">
          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            {/* Names */}
            <div className="flex flex-col md:flex-row gap-3">
              <input
                type="text"
                name="firstName"
                placeholder="First Name"
                value={formData.firstName}
                onChange={handleChange}
                className="flex-1 w-full border rounded px-4 py-3 md:py-4 text-gray-900"
                required
              />
              <input
                type="text"
                name="middleName"
                placeholder="Middle Name"
                value={formData.middleName}
                onChange={handleChange}
                className="flex-1 w-full border rounded px-4 py-3 md:py-4 text-gray-900"
              />
            </div>

            <input
              type="text"
              name="lastName"
              placeholder="Last Name"
              value={formData.lastName}
              onChange={handleChange}
              className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
              required
            />

            <input
              type="text"
              name="username"
              placeholder="Username"
              value={formData.username}
              onChange={handleChange}
              className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
              required
            />

            <input
              type="email"
              name="email"
              placeholder="Email Address"
              value={formData.email}
              onChange={handleChange}
              className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
              required
            />

            {/* Country + Phone */}
            <div className="flex flex-col md:flex-row gap-3">
              <div className="flex-1 w-full">
                <Select
                  options={countryOptions}
                  onChange={handleCountryChange}
                  placeholder="Country"
                  isSearchable
                />
              </div>
              <div className="flex-1 w-full">
                <PhoneInput
                  country={formData.country?.toLowerCase() || "us"}
                  value={formData.phone}
                  onChange={handlePhoneChange}
                  containerClass="w-full"
                  inputClass="!w-full px-4 py-3 md:py-4 border rounded text-gray-900"
                  buttonClass="!p-3"
                  dropdownClass="!w-full"
                  enableSearch
                />
              </div>
            </div>

            <input
              type="text"
              name="state"
              placeholder="State"
              value={formData.state}
              onChange={handleChange}
              className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
              required
            />
            <input
              type="text"
              name="address"
              placeholder="Address"
              value={formData.address}
              onChange={handleChange}
              className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
              required
            />

            {/* Age + DOB */}
            <div className="flex flex-col md:flex-row gap-3">
              <input
                type="number"
                name="age"
                placeholder="Age"
                value={formData.age}
                onChange={handleChange}
                className="flex-1 w-full border rounded px-4 py-3 md:py-4 text-gray-900"
                required
              />
              <input
                type="date"
                name="dob"
                value={formData.dob}
                onChange={handleChange}
                className="flex-1 w-full border rounded px-4 py-3 md:py-4 text-gray-900"
                required
              />
            </div>

            {/* Password */}
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                placeholder="Create Password"
                value={formData.password}
                onChange={handleChange}
                className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
                required
              />
              <span
                className="absolute right-4 top-3 md:top-4 cursor-pointer text-gray-600"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <FaEyeSlash /> : <FaEye />}
              </span>
            </div>

            {/* Strength Bar */}
            {formData.password && (
              <div>
                <div className="h-2 w-full bg-gray-200 rounded mt-1">
                  <div
                    className={`h-full ${strengthBarColor} rounded transition-all duration-500`}
                    style={{ width: `${(strengthScore / 5) * 100}%` }}
                  ></div>
                </div>

                <p className="text-sm text-gray-700 mt-1 font-semibold">
                  Strength: {strengthLabel}
                </p>

                {/* Checklist */}
                <ul className="text-xs mt-2 text-gray-800 grid grid-cols-2 gap-1">
                  <li
                    className={
                      passwordChecks.length ? "text-green-600" : "text-red-500"
                    }
                  >
                    ✓ 12 characters
                  </li>
                  <li
                    className={
                      passwordChecks.upper ? "text-green-600" : "text-red-500"
                    }
                  >
                    ✓ Uppercase letter
                  </li>
                  <li
                    className={
                      passwordChecks.lower ? "text-green-600" : "text-red-500"
                    }
                  >
                    ✓ Lowercase letter
                  </li>
                  <li
                    className={
                      passwordChecks.number ? "text-green-600" : "text-red-500"
                    }
                  >
                    ✓ Number
                  </li>
                  <li
                    className={
                      passwordChecks.special ? "text-green-600" : "text-red-500"
                    }
                  >
                    ✓ Special character
                  </li>
                </ul>
              </div>
            )}

            {/* Confirm Password */}
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                name="confirmPassword"
                placeholder="Confirm Password"
                value={formData.confirmPassword}
                onChange={handleChange}
                className="w-full border rounded px-4 py-3 md:py-4 text-gray-900"
                required
              />
              <span
                className="absolute right-4 top-3 md:top-4 cursor-pointer text-gray-600"
                onClick={() => setShowConfirm(!showConfirm)}
              >
                {showConfirm ? <FaEyeSlash /> : <FaEye />}
              </span>

              {formData.confirmPassword && (
                <p
                  className={`text-sm mt-1 ${
                    formData.password === formData.confirmPassword
                      ? "text-green-600"
                      : "text-red-500"
                  }`}
                >
                  {formData.password === formData.confirmPassword
                    ? "✓ Passwords match"
                    : "✗ Passwords do not match"}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="bg-purple-600 hover:bg-purple-700 text-white p-3 rounded-xl transition-all shadow-lg mt-2"
            >
              {loading ? "Registering..." : "Create Account"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Register;
