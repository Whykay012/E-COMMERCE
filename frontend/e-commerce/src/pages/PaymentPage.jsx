import { useState, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  initializePayment,
  verifyPayment,
  fetchWalletData,
  clearPaymentMessage,
} from "../redux/slices/paymentSlice";

const Payment = () => {
  const dispatch = useDispatch();
  const { wallet, history, reference, loading, error, message } = useSelector(
    (state) => state.payment
  );

  const [amount, setAmount] = useState("");

  // Fetch wallet balance & history on mount
  useEffect(() => {
    dispatch(fetchWalletData());
  }, [dispatch]);

  // Automatically verify payment when reference is set
  useEffect(() => {
    if (reference) {
      dispatch(verifyPayment(reference));
    }
  }, [reference, dispatch]);

  // Clear messages after 5 seconds
  useEffect(() => {
    if (message || error) {
      const timer = setTimeout(() => dispatch(clearPaymentMessage()), 5000);
      return () => clearTimeout(timer);
    }
  }, [message, error, dispatch]);

  // Initialize payment
  const handlePayment = (e) => {
    e.preventDefault();
    if (!amount || isNaN(amount) || Number(amount) <= 0) return;
    dispatch(initializePayment(Number(amount)));
  };

  return (
    <div className="min-h-screen p-6 bg-gray-100 flex flex-col items-center">
      <div className="bg-white rounded-lg shadow p-6 w-full max-w-lg mb-6">
        <h2 className="text-2xl font-bold mb-4 text-center">
          Wallet Balance: ₦{wallet?.balance || 0}
        </h2>

        <form className="flex flex-col gap-4" onSubmit={handlePayment}>
          <input
            type="number"
            placeholder="Enter amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="p-3 border rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
            min="1"
            required
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-green-600 text-white p-3 rounded hover:bg-green-700 transition disabled:opacity-50"
          >
            {loading ? "Processing..." : "Add Funds"}
          </button>
        </form>

        {(message || error) && (
          <p
            className={`mt-3 text-center ${
              error ? "text-red-500" : "text-green-600"
            }`}
          >
            {error || message}
          </p>
        )}
      </div>

      <div className="bg-white rounded-lg shadow p-6 w-full max-w-lg">
        <h2 className="text-xl font-bold mb-4 text-center">Payment History</h2>
        {history.length === 0 ? (
          <p className="text-center text-gray-500">No payments yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((p) => (
              <li
                key={p._id}
                className="border p-3 rounded flex justify-between items-center"
              >
                <span>
                  ₦{p.amount} -{" "}
                  <span
                    className={`${
                      p.status === "success"
                        ? "text-green-600"
                        : p.status === "pending"
                        ? "text-yellow-500"
                        : "text-red-600"
                    } font-medium`}
                  >
                    {p.status}
                  </span>
                </span>
                <span className="text-gray-500 text-sm">
                  {new Date(p.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default Payment;
