import { useState, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { loginUser } from "../redux/slices/authSlice";
import { FaEye, FaEyeSlash } from "react-icons/fa";
import { useNavigate } from "react-router-dom";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const Login = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { loading, error, user, isAuthenticated } = useSelector(
    (state) => state.auth
  );

  const [formData, setFormData] = useState({ identifier: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    dispatch(loginUser(formData));
  };

  // Handle toast notifications and redirect
  useEffect(() => {
    if (error) {
      toast.error(error, { position: "top-right", autoClose: 4000 });
    }

    if (isAuthenticated && user) {
      toast.success(`Welcome, ${user.username || user.email}!`, {
        position: "top-right",
        autoClose: 3000,
        onClose: () => navigate("/dashboard"),
      });
    }
  }, [error, isAuthenticated, user, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 via-pink-500 to-red-500 flex items-center justify-center p-4 md:p-6 relative overflow-hidden">
      <ToastContainer />
      {/* Floating background circles */}
      <div className="absolute w-60 h-60 bg-white/20 rounded-full blur-2xl top-8 left-8 animate-pulse md:w-72 md:h-72" />
      <div className="absolute w-80 h-80 bg-white/10 rounded-full blur-3xl bottom-8 right-8 animate-ping md:w-96 md:h-96" />

      {/* Glassmorphism card */}
      <div className="relative z-10 w-full max-w-md md:max-w-lg p-6 md:p-10 bg-white/20 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/30">
        <h2 className="text-3xl md:text-4xl font-extrabold text-white drop-shadow-xl text-center mb-2">
          Welcome Back
        </h2>
        <p className="text-white/90 text-center mb-6 md:mb-8 text-sm md:text-base tracking-wide">
          Log in to your account and start exploring amazing deals and products
          in our marketplace.
        </p>

        {/* Form */}
        <div className="bg-white/85 p-4 md:p-8 rounded-3xl shadow-2xl">
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4 md:gap-5"
          >
            <input
              type="text"
              name="identifier"
              placeholder="Email, phone, or username"
              value={formData.identifier}
              onChange={handleChange}
              className="p-3 md:p-4 border rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-purple-400 transition-all"
              required
            />

            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                placeholder="Password"
                value={formData.password}
                onChange={handleChange}
                className="p-3 md:p-4 border rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-purple-400 transition-all"
                required
              />
              <span
                className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer text-gray-600"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <FaEyeSlash /> : <FaEye />}
              </span>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="bg-purple-600 hover:bg-purple-700 text-white p-3 md:p-4 rounded-xl transition-all shadow-lg"
            >
              {loading ? "Logging in..." : "Login"}
            </button>
          </form>

          <p className="text-center mt-4 text-sm text-gray-700/80">
            Don't have an account?{" "}
            <span className="text-purple-600 font-semibold cursor-pointer hover:underline">
              Sign up now
            </span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
